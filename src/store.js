import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_FILE = process.env.DATA_FILE || 'data/checkin.json';

function seed() {
  // 固定相对当前时刻，保证演示时场次窗口处于可用状态；事件和计数仍为空。
  const now = Date.now();
  const iso = (offsetMs) => new Date(now + offsetMs).toISOString();
  return {
    version: 1,
    meta: { eventSeq: 0, revision: 0, createdAt: new Date(now).toISOString() },
    activities: [
      {
        id: 'act-campus-festival',
        name: '校园创新文化节',
        createdAt: iso(-3600_000)
      }
    ],
    sessions: [
      {
        id: 'ses-opening',
        activityId: 'act-campus-festival',
        name: '开幕主会场',
        startsAt: iso(-30 * 60_000),
        endsAt: iso(3 * 3600_000),
        createdAt: iso(-3600_000)
      },
      {
        id: 'ses-workshop',
        activityId: 'act-campus-festival',
        name: '机器人工作坊',
        startsAt: iso(4 * 3600_000),
        endsAt: iso(7 * 3600_000),
        createdAt: iso(-3600_000)
      }
    ],
    people: [
      { id: 'p-001', name: '林一鸣', studentNo: '2026001' },
      { id: 'p-002', name: '王思远', studentNo: '2026002' },
      { id: 'p-003', name: '赵晓雨', studentNo: '2026003' },
      { id: 'p-004', name: '陈嘉禾', studentNo: '2026004' }
    ],
    eligibility: [
      { activityId: 'act-campus-festival', sessionId: 'ses-opening', personId: 'p-001', status: 'active' },
      { activityId: 'act-campus-festival', sessionId: 'ses-opening', personId: 'p-002', status: 'active' },
      { activityId: 'act-campus-festival', sessionId: 'ses-opening', personId: 'p-003', status: 'active' },
      { activityId: 'act-campus-festival', sessionId: 'ses-opening', personId: 'p-004', status: 'active' },
      { activityId: 'act-campus-festival', sessionId: 'ses-workshop', personId: 'p-001', status: 'active' },
      { activityId: 'act-campus-festival', sessionId: 'ses-workshop', personId: 'p-002', status: 'active' },
      { activityId: 'act-campus-festival', sessionId: 'ses-workshop', personId: 'p-003', status: 'active' }
    ],
    devices: [
      { id: 'dev-gate-a', name: '东门 A', lastSeenAt: null, lastBatchId: null, revision: 0 },
      { id: 'dev-gate-b', name: '东门 B', lastSeenAt: null, lastBatchId: null, revision: 0 }
    ],
    events: [],
    staging: [],
    publication: null
  };
}

function clone(value) {
  return globalThis.structuredClone(value);
}

export class Store extends EventEmitter {
  constructor(file = DEFAULT_FILE, { reset = false } = {}) {
    super();
    this.setMaxListeners(0);
    this.file = resolve(file);
    this.data = this.#load(reset);
  }

  #load(reset) {
    if (!reset && existsSync(this.file)) {
      try {
        return JSON.parse(readFileSync(this.file, 'utf8'));
      } catch (error) {
        throw new Error(`无法读取持久化文件 ${this.file}: ${error.message}`);
      }
    }
    const data = seed();
    this.#write(data);
    return data;
  }

  #write(data = this.data) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, this.file);
  }

  snapshot() {
    return clone(this.data);
  }

  /**
   * 串行化所有状态变更。回调内对 data 的修改与落盘、SSE 通知处于同一个事务边界；
   * HTTP 事件循环因此不会交错产生“读到旧人数、写入新场次”的撕裂状态。
   */
  mutate(type, mutator, publicPayload = true) {
    const beforeRevision = this.data.meta.revision;
    // 先在副本中执行事务；抛错不会污染已发布内存状态，成功后才整体替换并原子落盘。
    const working = clone(this.data);
    const result = mutator(working) ?? {};
    const changed = result.changed !== false;
    if (changed) {
      if (beforeRevision === working.meta.revision) {
        working.meta.revision += 1;
      }
      this.data = working;
      this.#write();
      process.nextTick(() => {
        this.emit('commit', {
          type,
          revision: this.data.meta.revision,
          at: new Date().toISOString(),
          result: publicPayload === true ? sanitizeCommit(result) : publicPayload
        });
      });
    }
    return clone(result);
  }

  bump(data) {
    data.meta.revision += 1;
  }
}

function sanitizeCommit(result) {
  if (!result || typeof result !== 'object') return result;
  const cloneResult = clone(result);
  delete cloneResult.ticketToken;
  delete cloneResult.tickets;
  return cloneResult;
}

export function nextId(prefix) {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  return `${prefix}-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}
