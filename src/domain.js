// 纯领域逻辑：签到状态永远从不可变事件重放得到，而不是读取/覆盖一个布尔字段。

export const ACTIVE_EVENT_TYPES = new Set(['CHECK_IN', 'MANUAL_CHECKIN', 'RE_ENTRY']);

export function nowIso(clock = Date) {
  return new Date(clock.now()).toISOString();
}

export function getActivity(data, activityId) {
  return data.activities.find((item) => item.id === activityId);
}

export function getSession(data, sessionId) {
  return data.sessions.find((item) => item.id === sessionId);
}

export function isEligible(data, activityId, sessionId, personId) {
  return data.eligibility.some(
    (item) =>
      item.activityId === activityId &&
      item.sessionId === sessionId &&
      item.personId === personId &&
      item.status === 'active'
  );
}

function eventTimeKey(event) {
  const time = Date.parse(event.scannedAt || event.createdAt || 0);
  return [Number.isFinite(time) ? time : 0, event.seq || 0];
}

/**
 * 重放某场次全部事件。补签、撤销、再次入场都是独立事件；
 * REVOKE 之后的有效入场事件才能重新产生有效签到。
 */
export function deriveAttendance(events, sessionId) {
  const result = new Map();
  events
    .filter((event) => event.sessionId === sessionId)
    .slice()
    .sort((a, b) => {
      const [at, as] = eventTimeKey(a);
      const [bt, bs] = eventTimeKey(b);
      return at - bt || as - bs;
    })
    .forEach((event) => {
      if (event.type === 'REVOKE') {
        result.delete(event.personId);
      } else if (ACTIVE_EVENT_TYPES.has(event.type)) {
        result.set(event.personId, event);
      }
      // SCAN_REJECTED / DUPLICATE_* 只留审计，不产生有效签到。
    });
  return result;
}

export function latestEventForPerson(events, sessionId, personId, beforeIso) {
  let list = events.filter(
    (event) => event.sessionId === sessionId && event.personId === personId
  );
  if (beforeIso) {
    const before = Date.parse(beforeIso);
    // 同一毫秒内撤销后再次入场时，用 seq 保证 REVOKE 已被视为历史事件。
    list = list.filter((event) => Date.parse(event.scannedAt || event.createdAt) <= before);
  }
  return list.sort((a, b) => {
    const [at, as] = eventTimeKey(a);
    const [bt, bs] = eventTimeKey(b);
    return bt - at || bs - as;
  })[0];
}

function makeEvent(data, input, type) {
  const seq = data.meta.eventSeq + 1;
  data.meta.eventSeq = seq;
  return {
    id: `evt-${String(seq).padStart(6, '0')}`,
    seq,
    idempotencyKey: input.idempotencyKey,
    type,
    activityId: input.activityId,
    sessionId: input.sessionId,
    personId: input.personId,
    deviceId: input.deviceId || null,
    scannedAt: input.scannedAt || nowIso(),
    createdAt: nowIso(),
    actor: input.actor || { type: 'device', id: input.deviceId || 'unknown' },
    reason: input.reason || '',
    relatedEventId: input.relatedEventId || null,
    ticketId: input.ticketId || null
  };
}

function append(data, input, type, reason = '', relatedEventId = null) {
  const event = makeEvent(data, { ...input, reason: reason || input.reason, relatedEventId }, type);
  data.events.push(event);
  return event;
}

function baseResult(status, extra = {}) {
  return { status, ...extra };
}

/**
 * 应用一个签到意图。该函数可用于在线请求，也可用于离线队列合并/冲突裁决。
 * 返回值包含重放后的状态；调用方依据 status 决定是否放入冲突队列。
 */
export function applyIntent(data, input, currentTime = nowIso()) {
  const session = getSession(data, input.sessionId);
  if (!session) return baseResult('rejected', { code: 'session_not_found' });
  const activity = getActivity(data, session.activityId);
  if (!activity || activity.id !== input.activityId) {
    return baseResult('rejected', { code: 'activity_session_mismatch' });
  }
  if (!isEligible(data, session.activityId, session.id, input.personId)) {
    return baseResult('conflict', { code: 'not_eligible' });
  }

  const existing = data.events.find((event) => event.idempotencyKey === input.idempotencyKey);
  if (existing) {
    const active = deriveAttendance(data.events, session.id).get(input.personId);
    return baseResult(active ? 'duplicate' : 'already_processed', {
      code: 'idempotent_retry',
      existingEvent: existing,
      activeEvent: active || null
    });
  }

  const attendance = deriveAttendance(data.events, session.id);
  const active = attendance.get(input.personId);

  if (input.action === 'revoke') {
    if (!active) return baseResult('conflict', { code: 'no_active_checkin' });
    const event = append(data, input, 'REVOKE', input.reason || '工作台撤销', active.id);
    return baseResult('revoked', { event, activeEvent: null });
  }

  if (input.action === 'manual-checkin') {
    if (active) {
      return baseResult('conflict', { code: 'active_checkin_exists', activeEvent: active });
    }
    const event = append(data, { ...input, scannedAt: currentTime }, 'MANUAL_CHECKIN');
    return baseResult('confirmed', { event, activeEvent: event, kind: 'manual' });
  }

  if (input.action !== 'scan') {
    return baseResult('rejected', { code: 'unknown_action' });
  }

  const scannedAt = input.scannedAt || currentTime;
  const latestBefore = latestEventForPerson(data.events, session.id, input.personId, scannedAt);
  const activeBefore = latestBefore && ACTIVE_EVENT_TYPES.has(latestBefore.type) ? latestBefore : null;

  if (activeBefore) {
    const scanTime = Date.parse(scannedAt);
    const laterRevoke = data.events.some(
      (event) =>
        event.sessionId === session.id &&
        event.personId === input.personId &&
        event.type === 'REVOKE' &&
        Date.parse(event.scannedAt || event.createdAt) > scanTime
    );
    if (laterRevoke) {
      // 迟到扫描的物理时间早于撤销，即使网络后到也不能复活旧签到。
      const event = append(
        data,
        { ...input, scannedAt },
        'SCAN_REJECTED',
        'late_checkin_after_revoke',
        activeBefore.id
      );
      return baseResult('conflict', { code: 'late_checkin_after_revoke', event, activeEvent: null });
    }
    // 同一场次重复扫码：记录拒绝事件，但有效签到仍只有原来的一个。
    const event = append(
      data,
      { ...input, scannedAt },
      'SCAN_REJECTED',
      'duplicate_active_checkin',
      activeBefore.id
    );
    return baseResult('duplicate', { code: 'duplicate_active_checkin', event, activeEvent: activeBefore });
  }

  const type = latestBefore && latestBefore.type === 'REVOKE' ? 'RE_ENTRY' : 'CHECK_IN';
  const event = append(data, { ...input, scannedAt }, type);
  const activeAfter = deriveAttendance(data.events, session.id).get(input.personId);

  if (!activeAfter || activeAfter.id !== event.id) {
    // 事件已被追加且可审计，但一个时间戳更晚的 REVOKE 仍生效。
    return baseResult('conflict', {
      code: 'late_checkin_after_revoke',
      event,
      activeEvent: null
    });
  }
  return baseResult(type === 'RE_ENTRY' ? 're_entered' : 'confirmed', {
    event,
    activeEvent: event,
    kind: type === 'RE_ENTRY' ? 'reentry' : 'checkin'
  });
}

export function unresolvedStaging(data, sessionId) {
  return data.staging.filter(
    (item) => item.status === 'conflict' && (!sessionId || item.payload.sessionId === sessionId)
  );
}

export function countsForSession(data, sessionId) {
  const session = getSession(data, sessionId);
  if (!session) return null;
  const eligibleRecords = data.eligibility.filter(
    (item) =>
      item.activityId === session.activityId &&
      item.sessionId === sessionId &&
      item.status === 'active'
  );
  const eligiblePeople = new Set(eligibleRecords.map((item) => item.personId));
  const active = deriveAttendance(data.events, sessionId);
  const confirmed = [...eligiblePeople].filter((personId) => active.has(personId)).length;
  const tentativePeople = new Set(
    unresolvedStaging(data, sessionId).map((item) => item.payload.personId)
  );
  return {
    activityId: session.activityId,
    sessionId,
    eligible: eligiblePeople.size,
    confirmed,
    tentative: tentativePeople.size,
    unresolvedConflicts: unresolvedStaging(data, sessionId).length
  };
}

export function recomputeCounts(data) {
  return {
    at: nowIso(),
    immutableEvents: data.events.length,
    sessions: data.sessions.map((session) => countsForSession(data, session.id))
  };
}
