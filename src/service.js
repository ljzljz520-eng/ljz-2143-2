import { Store, nextId } from './store.js';
import {
  applyIntent,
  countsForSession,
  deriveAttendance,
  getActivity,
  getSession,
  isEligible,
  nowIso,
  recomputeCounts
} from './domain.js';
import { checkTicketScope, issueTicket, verifyTicket } from './tickets.js';

export class ValidationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function requireId(value, field) {
  if (!value || !ID_RE.test(String(value))) throw new ValidationError('invalid_id', `${field} 不合法`);
  return String(value);
}

function updateDevice(data, deviceId, batchId = null) {
  if (!deviceId) return null;
  let device = data.devices.find((item) => item.id === deviceId);
  if (!device) {
    device = { id: deviceId, name: deviceId, lastSeenAt: null, lastBatchId: null, revision: 0 };
    data.devices.push(device);
  }
  device.lastSeenAt = nowIso();
  if (batchId) device.lastBatchId = batchId;
  device.revision = data.meta.revision + 1;
  return device;
}

function refreshPublishedCounts(data) {
  if (data.publication?.sessionId) {
    const counts = countsForSession(data, data.publication.sessionId);
    if (counts) data.publication.counts = counts;
  }
}

function ensureEligibility(data, activityId, sessionId, personId) {
  let item = data.eligibility.find(
    (row) => row.activityId === activityId && row.sessionId === sessionId && row.personId === personId
  );
  if (!item) {
    item = { activityId, sessionId, personId, status: 'active', grantedAt: nowIso(), grantedBy: 'workbench-conflict-override' };
    data.eligibility.push(item);
  } else {
    item.status = 'active';
  }
  return item;
}

function stageItem(data, raw, result, serverReason) {
  data.meta.stagingSeq = (data.meta.stagingSeq || 0) + 1;
  const item = {
    id: `stg-${String(data.meta.stagingSeq).padStart(6, '0')}`,
    status: 'conflict',
    action: raw.action,
    payload: {
      idempotencyKey: raw.idempotencyKey,
      activityId: raw.activityId,
      sessionId: raw.sessionId,
      personId: raw.personId,
      deviceId: raw.deviceId || null,
      scannedAt: raw.scannedAt || nowIso(),
      reason: raw.reason || '',
      ticketId: raw.ticketId || null,
      // 不长期保存票据令牌；裁决以服务端资格和工作台身份为准。
      ticketToken: undefined
    },
    code: result.code || 'conflict',
    serverReason,
    eventId: result.event?.id || null,
    batchId: raw.batchId || null,
    createdAt: nowIso(),
    resolvedAt: null,
    resolution: null
  };
  delete item.payload.ticketToken;
  data.staging.push(item);
  return item;
}

function validateIntent(data, raw, { offline = false } = {}) {
  const action = raw.action === 'manual-checkin' || raw.action === 'revoke' ? raw.action : 'scan';
  const activityId = requireId(raw.activityId, 'activityId');
  const sessionId = requireId(raw.sessionId, 'sessionId');
  const personId = requireId(raw.personId, 'personId');
  const idempotencyKey = raw.idempotencyKey ? String(raw.idempotencyKey) : nextId('idem');
  const deviceId = raw.deviceId ? requireId(raw.deviceId, 'deviceId') : null;
  if (action === 'scan' && !deviceId && !offline) {
    // 在线扫码也允许工作台模拟，但真实设备必须带 deviceId。
  }
  let ticketPayload = null;
  let ticketId = null;
  if (action === 'scan') {
    if (!raw.ticketToken) throw new ValidationError('ticket_required');
    const ticket = verifyTicket(raw.ticketToken);
    if (!ticket.ok) throw new ValidationError(ticket.code, ticket.code);
    ticketPayload = ticket.payload;
    ticketId = ticket.payload.tid;
    const scope = checkTicketScope(ticketPayload, activityId, sessionId);
    if (!scope.ok) throw new ValidationError(scope.code, scope.code);
  }
  const session = getSession(data, sessionId);
  if (!session) throw new ValidationError('session_not_found');
  if (session.activityId !== activityId) throw new ValidationError('activity_session_mismatch');
  return {
    action,
    activityId,
    sessionId,
    personId,
    idempotencyKey,
    deviceId,
    ticketId,
    scannedAt: raw.scannedAt ? String(raw.scannedAt) : nowIso(),
    reason: raw.reason ? String(raw.reason).slice(0, 200) : '',
    actor: raw.actor || { type: deviceId ? 'device' : 'workbench', id: deviceId || 'web' }
  };
}

export function createService(dataFile = process.env.DATA_FILE || 'data/checkin.json', { reset = false } = {}) {
  const store = new Store(dataFile, { reset });

  function adminSnapshot() {
    const data = store.snapshot();
    return {
      revision: data.meta.revision,
      serverTime: nowIso(),
      activities: data.activities,
      sessions: data.sessions.map((session) => ({
        ...session,
        counts: countsForSession(data, session.id)
      })),
      people: data.people,
      eligibility: data.eligibility,
      devices: data.devices,
      deviceSync: data.deviceSync || [],
      events: data.events.slice().sort((a, b) => b.seq - a.seq),
      staging: data.staging.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
      publication: data.publication
    };
  }

  function publicSnapshot() {
    const data = store.snapshot();
    const pub = data.publication;
    if (!pub) {
      return {
        revision: data.meta.revision,
        published: false,
        serverTime: nowIso(),
        message: '尚未发布场次'
      };
    }
    const session = getSession(data, pub.sessionId);
    const activity = getActivity(data, pub.activityId);
    // 大屏响应刻意不返回人员、学号、事件等敏感/明细信息。
    return {
      published: true,
      revision: data.meta.revision,
      publicationId: pub.id,
      activityId: pub.activityId,
      activityName: activity?.name || '',
      sessionId: pub.sessionId,
      sessionName: session?.name || '',
      title: pub.title,
      subtitle: pub.subtitle,
      visualUrl: pub.visualUrl || null,
      rotation: pub.rotation || 0,
      theme: pub.theme || 'dark',
      counts: countsForSession(data, pub.sessionId),
      publishedAt: pub.publishedAt
    };
  }

  function createSession(input) {
    const activityId = requireId(input.activityId, 'activityId');
    const name = String(input.name || '').trim();
    if (name.length < 1 || name.length > 80) throw new ValidationError('invalid_session_name');
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt) || Number.isNaN(endsAt) || endsAt <= startsAt) {
      throw new ValidationError('invalid_time_range');
    }
    const id = input.id ? requireId(input.id, 'id') : nextId('ses');
    return store.mutate('session.created', (data) => {
      const activity = getActivity(data, activityId);
      if (!activity) throw new ValidationError('activity_not_found');
      if (data.sessions.some((session) => session.id === id)) throw new ValidationError('session_exists');
      const personIds = Array.isArray(input.personIds) ? input.personIds : [];
      personIds.forEach((personId) => requireId(personId, 'personId'));
      const session = {
        id,
        activityId,
        name,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        createdAt: nowIso()
      };
      data.sessions.push(session);
      personIds.forEach((personId) => {
        if (!data.people.some((person) => person.id === personId)) throw new ValidationError('person_not_found');
        if (!isEligible(data, activityId, id, personId)) {
          data.eligibility.push({ activityId, sessionId: id, personId, status: 'active' });
        }
      });
      store.bump(data);
      return { session, counts: countsForSession(data, id) };
    });
  }

  function grantEligibility(input) {
    const activityId = requireId(input.activityId, 'activityId');
    const sessionId = requireId(input.sessionId, 'sessionId');
    const personId = requireId(input.personId, 'personId');
    return store.mutate('eligibility.granted', (data) => {
      if (!getActivity(data, activityId)) throw new ValidationError('activity_not_found');
      const session = getSession(data, sessionId);
      if (!session || session.activityId !== activityId) throw new ValidationError('session_not_found');
      if (!data.people.some((person) => person.id === personId)) throw new ValidationError('person_not_found');
      const result = ensureEligibility(data, activityId, sessionId, personId);
      store.bump(data);
      refreshPublishedCounts(data);
      return { eligibility: result, counts: countsForSession(data, sessionId) };
    });
  }

  function issueOfflineTicket(input) {
    const activityId = requireId(input.activityId, 'activityId');
    const sessionId = requireId(input.sessionId, 'sessionId');
    const personId = requireId(input.personId, 'personId');
    const ttlMinutes = Math.min(Number(input.ttlMinutes) || 720, 24 * 60);
    const data = store.snapshot();
    const session = getSession(data, sessionId);
    if (!session || session.activityId !== activityId) throw new ValidationError('session_not_found');
    if (!isEligible(data, activityId, sessionId, personId)) throw new ValidationError('not_eligible');
    const issuedAt = new Date().toISOString();
    const expiresAt = new Date(Math.min(Date.now() + ttlMinutes * 60_000, Date.parse(session.endsAt))).toISOString();
    const ticketId = nextId('tkt');
    const ticket = issueTicket({ activityId, sessionId, personId, ticketId, issuedAtIso: issuedAt, expiresAtIso: expiresAt });
    return {
      ticketId,
      activityId,
      sessionId,
      personId,
      issuedAt,
      expiresAt,
      token: ticket.token
    };
  }

  function submitOnline(rawInput) {
    const prepared = store.mutate('online.validated', (data) => {
      const intent = validateIntent(data, rawInput);
      updateDevice(data, intent.deviceId);
      return { intent, changed: false };
    }, false);
    const intent = prepared.intent;
    return store.mutate('attendance.intent', (data) => {
      updateDevice(data, intent.deviceId);
      const result = applyIntent(data, intent, nowIso());
      if (result.status === 'conflict') {
        const item = stageItem(data, intent, result, '在线请求与服务端撤销/资格状态冲突，等待工作台处置');
        result.stagingId = item.id;
      }
      refreshPublishedCounts(data);
      if (data.meta.revision === 0) store.bump(data);
      return result;
    });
  }

  function syncBatch(input) {
    const deviceId = requireId(input.deviceId, 'deviceId');
    const batchId = requireId(input.batchId || nextId('batch'), 'batchId');
    if (!Array.isArray(input.queue) || input.queue.length === 0) throw new ValidationError('empty_queue');
    const prepared = [];
    for (const [index, raw] of input.queue.entries()) {
      try {
        const intent = validateIntent(store.snapshot(), { ...raw, deviceId });
        prepared.push({ index, intent });
      } catch (error) {
        // 票据不属于当前场次等错误必须在事务外中止整批：旧队列不能被悄悄并入新人数。
        throw new ValidationError(error.code || 'invalid_intent', `第 ${index + 1} 条：${error.message}`);
      }
    }
    return store.mutate('offline.batch', (data) => {
      updateDevice(data, deviceId, batchId);
      const results = [];
      for (const { index, intent } of prepared) {
        const result = applyIntent(data, intent, nowIso());
        if (result.status === 'conflict') {
          const item = stageItem(data, { ...intent, batchId }, result, '离线合并冲突，等待工作台处置');
          result.stagingId = item.id;
        }
        results.push({ index, ...result });
      }
      refreshPublishedCounts(data);
      const ack = {
        deviceId,
        batchId,
        serverRevision: data.meta.revision,
        acceptedAt: nowIso(),
        results
      };
      data.deviceSync = data.deviceSync || [];
      data.deviceSync.push({
        deviceId,
        batchId,
        queued: input.queue.length,
        acknowledged: results.length,
        rejected: 0,
        conflicts: results.filter((item) => item.status === 'conflict').length,
        at: ack.acceptedAt,
        serverRevision: data.meta.revision
      });
      if (data.deviceSync.length > 100) data.deviceSync = data.deviceSync.slice(-100);
      return ack;
    });
  }

  function heartbeat(deviceIdRaw) {
    const deviceId = requireId(deviceIdRaw, 'deviceId');
    return store.mutate('device.heartbeat', (data) => {
      const device = updateDevice(data, deviceId);
      return { device };
    }, false);
  }

  function resolveConflict(input) {
    const stagingId = requireId(input.stagingId, 'stagingId');
    const decision = ['accept', 'discard', 'replace'].includes(input.decision) ? input.decision : null;
    if (!decision) throw new ValidationError('invalid_decision');
    return store.mutate('staging.resolved', (data) => {
      const item = data.staging.find((row) => row.id === stagingId);
      if (!item) throw new ValidationError('staging_not_found');
      if (item.status !== 'conflict') throw new ValidationError('staging_already_resolved');
      const base = item.payload;
      const actor = { type: 'workbench', id: requireId(input.operator || 'web', 'operator') };
      let applied = null;

      if (decision === 'discard') {
        item.status = 'discarded';
      } else if (decision === 'accept') {
        // 管理员确认离线票据代表的人有效：资格缺失时补录资格，再形成可审计的独立入场事件。
        ensureEligibility(data, base.activityId, base.sessionId, base.personId);
        if (item.code === 'late_checkin_after_revoke') {
          applied = applyIntent(
            data,
            {
              action: 'manual-checkin',
              activityId: base.activityId,
              sessionId: base.sessionId,
              personId: base.personId,
              idempotencyKey: `${base.idempotencyKey}:accepted-now`,
              deviceId: 'workbench',
              reason: `管理员接受迟到离线扫描 ${base.idempotencyKey}`,
              actor
            },
            nowIso()
          );
        } else {
          applied = applyIntent(
            data,
            {
              action: base.action === 'revoke' ? 'revoke' : 'manual-checkin',
              activityId: base.activityId,
              sessionId: base.sessionId,
              personId: base.personId,
              idempotencyKey: `${base.idempotencyKey}:accepted`,
              deviceId: 'workbench',
              reason: `管理员接受离线冲突 ${base.idempotencyKey}`,
              actor
            },
            nowIso()
          );
        }
        item.status = applied.status === 'conflict' ? 'conflict' : 'accepted';
        if (applied.status === 'conflict') item.code = applied.code;
      } else {
        if (!['active_checkin_exists', 'duplicate_active_checkin'].includes(item.code) && base.action !== 'manual-checkin') {
          throw new ValidationError('replace_not_applicable');
        }
        const active = deriveAttendance(data.events, base.sessionId).get(base.personId);
        if (!active) throw new ValidationError('no_active_checkin');
        const revoke = applyIntent(
          data,
          {
            action: 'revoke',
            activityId: base.activityId,
            sessionId: base.sessionId,
            personId: base.personId,
            idempotencyKey: `${base.idempotencyKey}:replace-revoke`,
            deviceId: 'workbench',
            reason: `管理员替换旧有效签到 ${base.idempotencyKey}`,
            actor
          },
          nowIso()
        );
        applied = applyIntent(
          data,
          {
            action: 'manual-checkin',
            activityId: base.activityId,
            sessionId: base.sessionId,
            personId: base.personId,
            idempotencyKey: `${base.idempotencyKey}:replace-checkin`,
            deviceId: 'workbench',
            reason: `管理员补签替换 ${base.idempotencyKey}`,
            actor
          },
          nowIso()
        );
        item.status = applied.status === 'conflict' ? 'conflict' : 'replaced';
      }

      item.resolvedAt = nowIso();
      item.resolution = { decision, operator: actor.id, at: item.resolvedAt, result: applied?.status || decision };
      refreshPublishedCounts(data);
      return { item, applied, counts: countsForSession(data, base.sessionId) };
    });
  }

  function publish(input) {
    const activityId = requireId(input.activityId, 'activityId');
    const sessionId = requireId(input.sessionId, 'sessionId');
    const title = String(input.title || '校园活动签到').slice(0, 80);
    const subtitle = String(input.subtitle || '').slice(0, 160);
    const rotation = [0, 90, 180, 270].includes(Number(input.rotation)) ? Number(input.rotation) : 0;
    const theme = ['dark', 'light', 'festive'].includes(input.theme) ? input.theme : 'dark';
    const visualUrl = input.visualUrl === undefined || input.visualUrl === null
      ? '/assets/visual-default.svg'
      : String(input.visualUrl).slice(0, 300);
    return store.mutate('screen.published', (data) => {
      const activity = getActivity(data, activityId);
      const session = getSession(data, sessionId);
      if (!activity) throw new ValidationError('activity_not_found');
      if (!session || session.activityId !== activityId) throw new ValidationError('session_not_found');
      const counts = countsForSession(data, sessionId);
      data.publication = {
        id: nextId('pub'),
        activityId,
        sessionId,
        title,
        subtitle,
        visualUrl,
        rotation,
        theme,
        counts,
        publishedAt: nowIso()
      };
      return { publication: data.publication };
    });
  }

  function recompute() {
    return store.mutate('counts.recomputed', (data) => {
      const report = recomputeCounts(data);
      refreshPublishedCounts(data);
      return { report, publication: data.publication };
    });
  }

  return {
    store,
    adminSnapshot,
    publicSnapshot,
    createSession,
    grantEligibility,
    issueOfflineTicket,
    submitOnline,
    syncBatch,
    heartbeat,
    resolveConflict,
    publish,
    recompute
  };
}
