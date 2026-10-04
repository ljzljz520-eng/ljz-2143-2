import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach } from 'node:test';

import { createService } from '../src/service.js';
import { applyIntent } from '../src/domain.js';

let dir;
let svc;
let ticket;

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'checkin-'));
  svc = createService(join(dir, 'data.json'), { reset: true });
  ticket = (personId = 'p-001', sessionId = 'ses-opening') =>
    svc.issueOfflineTicket({ activityId: 'act-campus-festival', sessionId, personId, ttlMinutes: 120 }).token;
}

beforeEach(setup);
after(() => dir && rmSync(dir, { recursive: true, force: true }));

function scan(deviceId, personId = 'p-001', overrides = {}) {
  return svc.submitOnline({
    action: 'scan',
    activityId: 'act-campus-festival',
    sessionId: 'ses-opening',
    personId,
    deviceId,
    ticketToken: ticket(personId),
    idempotencyKey: overrides.idempotencyKey || crypto.randomUUID(),
    scannedAt: overrides.scannedAt
  });
}

function revoke(personId = 'p-001', idempotencyKey = crypto.randomUUID()) {
  return svc.submitOnline({
    action: 'revoke',
    activityId: 'act-campus-festival',
    sessionId: 'ses-opening',
    personId,
    deviceId: 'workbench',
    idempotencyKey
  });
}

function chronologicalTypes(snapshot = svc.adminSnapshot()) {
  return snapshot.events.slice().sort((a, b) => a.seq - b.seq).map((event) => event.type);
}

test('两台设备同时扫同一人：串行事务只形成一个有效签到', () => {
  const keyA = crypto.randomUUID();
  const keyB = crypto.randomUUID();
  const results = [
    scan('dev-gate-a', 'p-001', { idempotencyKey: keyA }),
    scan('dev-gate-b', 'p-001', { idempotencyKey: keyB })
  ];
  assert.equal(results[0].status, 'confirmed');
  assert.equal(results[1].status, 'duplicate');
  assert.equal(results[1].activeEvent.id, results[0].event.id);
  const counts = svc.adminSnapshot().sessions.find((s) => s.id === 'ses-opening').counts;
  assert.equal(counts.confirmed, 1);
  assert.equal(counts.tentative, 0);
});

test('撤销后旧签到迟到：旧事件保留审计但不会恢复有效签到', () => {
  const oldKey = crypto.randomUUID();
  const oldAt = new Date(Date.now() - 60_000).toISOString();
  const first = scan('dev-gate-a', 'p-002', { idempotencyKey: oldKey, scannedAt: oldAt });
  assert.equal(first.status, 'confirmed');
  revoke('p-002');

  // 这是迟到的同一条旧请求（同一幂等键），不能产生新 CHECK_IN，也不能覆盖撤销。
  const retry = scan('dev-gate-a', 'p-002', { idempotencyKey: oldKey, scannedAt: oldAt });
  assert.equal(retry.status, 'already_processed');
  const snapshot = svc.adminSnapshot();
  const types = chronologicalTypes(snapshot);
  assert.deepEqual(types, ['CHECK_IN', 'REVOKE']);
  const counts = snapshot.sessions.find((s) => s.id === 'ses-opening').counts;
  assert.equal(counts.confirmed, 0);
});

test('撤销后另一个迟到旧扫描进入冲突处置，且不会自动恢复人数', () => {
  const oldAt = new Date(Date.now() - 90_000).toISOString();
  scan('dev-gate-a', 'p-002', { scannedAt: oldAt });
  revoke('p-002');
  const late = scan('dev-gate-b', 'p-002', {
    idempotencyKey: crypto.randomUUID(),
    scannedAt: new Date(Date.now() - 30_000).toISOString()
  });
  assert.equal(late.status, 'conflict');
  assert.equal(late.code, 'late_checkin_after_revoke');
  let counts = svc.adminSnapshot().sessions.find((s) => s.id === 'ses-opening').counts;
  assert.equal(counts.confirmed, 0);
  assert.equal(counts.tentative, 1);

  const resolved = svc.resolveConflict({ stagingId: late.stagingId, decision: 'discard' });
  assert.equal(resolved.item.status, 'discarded');
  counts = svc.adminSnapshot().sessions.find((s) => s.id === 'ses-opening').counts;
  assert.equal(counts.confirmed, 0);
  assert.equal(counts.tentative, 0);
  assert.deepEqual(chronologicalTypes().filter((type) => type !== 'SCAN_REJECTED'), ['CHECK_IN', 'REVOKE']);
});

test('服务端可能已成功后终端重试：同一幂等键不重复计数', () => {
  const key = crypto.randomUUID();
  const first = scan('dev-gate-a', 'p-003', { idempotencyKey: key });
  const retry = scan('dev-gate-a', 'p-003', { idempotencyKey: key });
  assert.equal(first.status, 'confirmed');
  assert.equal(retry.status, 'duplicate');
  assert.equal(retry.existingEvent.id, first.event.id);
  assert.equal(svc.adminSnapshot().sessions.find((s) => s.id === 'ses-opening').counts.confirmed, 1);
});

test('撤销后再次入场保留 CHECK_IN、REVOKE、RE_ENTRY 三个独立事件', () => {
  scan('dev-gate-a', 'p-004');
  revoke('p-004');
  const reenter = scan('dev-gate-b', 'p-004');
  assert.equal(reenter.status, 're_entered');
  assert.deepEqual(chronologicalTypes(), ['CHECK_IN', 'REVOKE', 'RE_ENTRY']);
  assert.equal(svc.adminSnapshot().sessions.find((s) => s.id === 'ses-opening').counts.confirmed, 1);
});

test('一个人可参加多个场次，不同场次计数相互独立', () => {
  scan('dev-gate-a', 'p-001');
  const workshopToken = ticket('p-001', 'ses-workshop');
  const workshop = svc.submitOnline({
    action: 'scan',
    activityId: 'act-campus-festival',
    sessionId: 'ses-workshop',
    personId: 'p-001',
    deviceId: 'dev-gate-a',
    ticketToken: workshopToken,
    idempotencyKey: crypto.randomUUID()
  });
  assert.equal(workshop.status, 'confirmed');
  const sessions = Object.fromEntries(svc.adminSnapshot().sessions.map((s) => [s.id, s.counts.confirmed]));
  assert.deepEqual(sessions, { 'ses-opening': 1, 'ses-workshop': 1 });
});

test('离线票据绑定场次，旧扫描队列不会进入换场后的新人数', () => {
  const oldToken = ticket('p-001', 'ses-opening');
  const batch = svc.syncBatch({
    deviceId: 'dev-gate-a',
    batchId: crypto.randomUUID(),
    queue: [{
      action: 'scan',
      activityId: 'act-campus-festival',
      sessionId: 'ses-opening',
      personId: 'p-001',
      ticketToken: oldToken,
      idempotencyKey: crypto.randomUUID(),
      scannedAt: new Date().toISOString()
    }]
  });
  assert.equal(batch.results[0].status, 'confirmed');
  assert.throws(() => svc.syncBatch({
    deviceId: 'dev-gate-b',
    batchId: crypto.randomUUID(),
    queue: [{
      action: 'scan',
      activityId: 'act-campus-festival',
      sessionId: 'ses-workshop',
      personId: 'p-001',
      ticketToken: oldToken,
      idempotencyKey: crypto.randomUUID()
    }]
  }), /ticket_wrong_session/);
  assert.equal(svc.adminSnapshot().sessions.find((s) => s.id === 'ses-workshop').counts.confirmed, 0);
});

test('工作台可处置离线冲突并查看重算结果', async () => {
  scan('dev-gate-a', 'p-001');
  const sync = svc.syncBatch({
    deviceId: 'dev-gate-b',
    batchId: crypto.randomUUID(),
    queue: [{
      action: 'scan',
      activityId: 'act-campus-festival',
      sessionId: 'ses-opening',
      personId: 'p-001',
      ticketToken: ticket('p-001'),
      idempotencyKey: crypto.randomUUID(),
      scannedAt: new Date().toISOString()
    }]
  });
  assert.equal(sync.results[0].status, 'duplicate', '普通重复在线直接确认，不入暂存');

  svc.grantEligibility({ activityId: 'act-campus-festival', sessionId: 'ses-opening', personId: 'p-001' });
  const conflictInput = {
    action: 'manual-checkin',
    activityId: 'act-campus-festival',
    sessionId: 'ses-opening',
    personId: 'p-001',
    deviceId: 'offline-tablet',
    idempotencyKey: crypto.randomUUID()
  };
  const staged = svc.store.mutate('test.stage', (data) => {
    const result = applyIntent(data, conflictInput, new Date().toISOString());
    assert.equal(result.status, 'conflict');
    data.meta.stagingSeq = (data.meta.stagingSeq || 0) + 1;
    const item = {
      id: `stg-${String(data.meta.stagingSeq).padStart(6, '0')}`,
      status: 'conflict', action: 'manual-checkin', payload: conflictInput, code: result.code,
      serverReason: 'test', eventId: null, batchId: null, createdAt: new Date().toISOString(), resolvedAt: null, resolution: null
    };
    data.staging.push(item);
    return { item };
  });
  const resolved = svc.resolveConflict({ stagingId: staged.item.id, decision: 'replace' });
  assert.equal(resolved.item.status, 'replaced');
  const report = svc.recompute().report;
  assert.equal(report.sessions.find((s) => s.sessionId === 'ses-opening').confirmed, 1);
  assert.ok(svc.adminSnapshot().events.some((e) => e.type === 'MANUAL_CHECKIN'));
});

test('发布时当前场次、人数、主视觉和旋转角原子落为一个版本', () => {
  scan('dev-gate-a', 'p-001');
  const pub = svc.publish({
    activityId: 'act-campus-festival',
    sessionId: 'ses-opening',
    title: '现场发布',
    visualUrl: '/assets/visual-default.svg',
    rotation: 90
  });
  const screen = svc.publicSnapshot();
  assert.equal(screen.sessionId, pub.publication.sessionId);
  assert.equal(screen.counts.confirmed, 1);
  assert.equal(screen.rotation, 90);
  assert.equal(screen.visualUrl, '/assets/visual-default.svg');
  assert.equal(JSON.stringify(screen).includes('p-001'), false);
  assert.equal(JSON.stringify(screen).includes('studentNo'), false);
});
