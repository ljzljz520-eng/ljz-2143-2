const $ = (id) => document.getElementById(id);
let state = null;

async function api(path, body = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || `HTTP ${res.status}`);
  return data;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
}

function setMessage(text, kind = 'ok') {
  $('adminMessage').textContent = text;
  $('adminMessage').className = `result ${kind}`;
}

function personLabel(id) {
  const p = state.people.find((item) => item.id === id);
  return p ? `${p.name} (${p.id})` : id;
}

function sessionLabel(id) {
  const s = state.sessions.find((item) => item.id === id);
  return s ? `${s.name} / ${id}` : id;
}

function renderSessions() {
  $('revision').textContent = `服务端版本：${state.revision} · 人数由不可变事件实时重放`;
  $('sessionList').innerHTML = state.sessions.map((s) => `
    <article class="session">
      <h3>${escapeHtml(s.name)}</h3>
      <p class="muted">${s.id} · ${new Date(s.startsAt).toLocaleString()} 至 ${new Date(s.endsAt).toLocaleString()}</p>
      <div class="count-line">
        <span><strong>${s.counts.confirmed}</strong> 确认人数</span>
        <span><strong>${s.counts.tentative}</strong> 暂定/冲突</span>
        <span><strong>${s.counts.eligible}</strong> 参与资格</span>
      </div>
      <div class="actions">
        <button onclick="window.adminActions.revokeMissing('${s.id}')" class="danger">撤销无效签到（演示请在事件区操作）</button>
        <button onclick="window.adminActions.usePublish('${s.id}')" class="secondary">用于发布</button>
      </div>
    </article>`).join('');
}

function renderDeviceSync() {
  $('deviceSync').innerHTML = state.devices.map((device) => {
    const batch = state.deviceSync.filter((item) => item.deviceId === device.id).at(-1);
    return `<div><strong>${escapeHtml(device.name || device.id)}</strong>：${device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleTimeString() : '尚未同步'}
      ${batch ? ` · 批次 ${escapeHtml(batch.batchId.slice(0, 8))} / 已确认 ${batch.acknowledged} / 冲突 ${batch.conflicts} / 版本 ${batch.serverRevision}` : ''}</div>`;
  }).join('');
}

function renderConflicts() {
  const items = state.staging.filter((item) => item.status === 'conflict');
  if (!items.length) {
    $('conflictList').innerHTML = '<p class="muted">没有未处置冲突。离线合并将服务端资格、撤销顺序和票据场次作为裁决依据。</p>';
    return;
  }
  $('conflictList').innerHTML = items.map((item) => {
    const p = item.payload;
    return `<article class="conflict">
      <h3><span class="badge conflict">${escapeHtml(item.code)}</span> ${escapeHtml(personLabel(p.personId))}</h3>
      <p>${escapeHtml(sessionLabel(p.sessionId))} · 动作 ${escapeHtml(p.action)} · 设备 ${escapeHtml(p.deviceId || '-')}</p>
      <p class="muted">暂存键：${escapeHtml(p.idempotencyKey)}<br>${escapeHtml(item.serverReason || '')}</p>
      <div class="actions">
        <button onclick="window.adminActions.resolve('${item.id}','accept')">接受（生成独立事件）</button>
        <button onclick="window.adminActions.resolve('${item.id}','replace')" class="secondary">替换（撤销后补签）</button>
        <button onclick="window.adminActions.resolve('${item.id}','discard')" class="danger">丢弃</button>
      </div>
    </article>`;
  }).join('');
}

function renderEvents() {
  $('eventList').innerHTML = state.events.slice(0, 120).map((event) => `
    <div class="event-row ${event.type === 'REVOKE' ? 'revoke' : event.type.includes('REJECTED') ? 'reject' : event.type.includes('MANUAL') ? 'manual' : ''}">
      <span>${new Date(event.scannedAt).toLocaleTimeString()}</span>
      <span>${escapeHtml(personLabel(event.personId))}</span>
      <span class="type">${event.type}</span>
      <span>${escapeHtml(sessionLabel(event.sessionId))}<br><small class="muted">${escapeHtml(event.id)} · ${escapeHtml(event.reason || event.actor?.id || '')}</small></span>
    </div>`).join('');
}

async function revokeActive(sessionId, personId) {
  await api('/api/checkins', {
    action: 'revoke',
    activityId: state.sessions.find((s) => s.id === sessionId).activityId,
    sessionId,
    personId,
    deviceId: 'workbench',
    idempotencyKey: crypto.randomUUID(),
    reason: '工作台撤销'
  });
  await load();
}

function render() {
  if (!state) return;
  renderSessions(); renderDeviceSync(); renderConflicts(); renderEvents();
}

async function load() {
  state = await (await fetch('/api/admin')).json();
  render();
}

function defaultDateTime(input, offsetMinutes) {
  const d = new Date(Date.now() + offsetMinutes * 60000);
  d.setSeconds(0, 0);
  input.value = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

document.querySelectorAll('.tabs button').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === button));
    document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `tab-${button.dataset.tab}`));
  });
});

$('createSession').addEventListener('click', async () => {
  try {
    await api('/api/admin/sessions', {
      activityId: $('newActivity').value.trim(),
      name: $('newName').value.trim(),
      startsAt: new Date($('newStart').value).toISOString(),
      endsAt: new Date($('newEnd').value).toISOString(),
      personIds: $('newPeople').value.split(',').map((x) => x.trim()).filter(Boolean)
    });
    setMessage('场次已创建');
    await load();
  } catch (error) { setMessage(error.message, 'bad'); }
});

$('grantBtn').addEventListener('click', async () => {
  try {
    const s = state.sessions.find((x) => x.id === $('grantSession').value.trim());
    await api('/api/admin/eligibility', { activityId: s.activityId, sessionId: s.id, personId: $('grantPerson').value.trim() });
    setMessage('资格已持久化');
    await load();
  } catch (error) { setMessage(error.message, 'bad'); }
});

async function attendanceAction(action) {
  try {
    const s = state.sessions.find((x) => x.id === $('attSession').value.trim());
    const result = await api('/api/checkins', {
      action,
      activityId: s.activityId,
      sessionId: s.id,
      personId: $('attPerson').value.trim(),
      deviceId: 'workbench',
      reason: action === 'revoke' ? '工作台撤销' : '工作台人工补签',
      idempotencyKey: crypto.randomUUID()
    });
    if (result.status === 'conflict') setMessage(`冲突：${result.code}；可在冲突页处置，不会覆盖布尔字段。`, 'warn');
    else setMessage(`已生成 ${result.event?.type || result.status} 事件，并完成计数重放。`);
    await load();
  } catch (error) { setMessage(error.message, 'bad'); }
}
$('manualBtn').addEventListener('click', () => attendanceAction('manual-checkin'));
$('revokeBtn').addEventListener('click', () => attendanceAction('revoke'));

$('recompute').addEventListener('click', async () => {
  try {
    const result = await api('/api/admin/recompute', {});
    setMessage(`重算完成：${result.report.immutableEvents} 个事件；确认人数没有被布尔覆盖。`);
    await load();
  } catch (error) { setMessage(error.message, 'bad'); }
});

$('publishBtn').addEventListener('click', async () => {
  try {
    const s = state.sessions.find((x) => x.id === $('pubSession').value.trim());
    const result = await api('/api/admin/publish', {
      activityId: s.activityId,
      sessionId: s.id,
      title: $('pubTitle').value,
      subtitle: $('pubSubtitle').value,
      visualUrl: $('pubVisual').value.trim(),
      rotation: Number($('pubRotation').value),
      theme: $('pubTheme').value
    });
    setMessage(`已原子发布 ${result.publication.id}：当前场次、确认人数、主视觉和旋转角度同版本切换。`);
    await load();
  } catch (error) { setMessage(error.message, 'bad'); }
});

$('ticketBtn').addEventListener('click', async () => {
  try {
    const s = state.sessions.find((x) => x.id === $('ticketSession').value.trim());
    const data = await api('/api/tickets', {
      activityId: s.activityId,
      sessionId: s.id,
      personId: $('ticketPerson').value.trim(),
      ttlMinutes: Number($('ticketTtl').value)
    });
    $('ticketResult').textContent = JSON.stringify(data, null, 2);
  } catch (error) { $('ticketResult').textContent = error.message; }
});

window.adminActions = {
  async resolve(id, decision) {
    try {
      const result = await api(`/api/admin/staging/${id}/resolve`, { decision, operator: 'web-admin' });
      setMessage(`冲突已${decision}，重算确认人数：${result.counts.confirmed}`);
      await load();
    } catch (error) { setMessage(error.message, 'bad'); }
  },
  async revokeMissing(sessionId) {
    const personId = prompt('输入要撤销的人员 ID，例如 p-001');
    if (!personId) return;
    try { await revokeActive(sessionId, personId.trim()); setMessage('撤销已作为 REVOKE 事件保存'); }
    catch (error) { setMessage(error.message, 'bad'); }
  },
  usePublish(sessionId) {
    $('pubSession').value = sessionId;
    $('ticketSession').value = sessionId;
    $('grantSession').value = sessionId;
    $('attSession').value = sessionId;
    document.querySelector('[data-tab="publish"]').click();
  }
};

function connect() {
  const source = new EventSource('/api/events?scope=admin');
  source.addEventListener('hello', (event) => { state = JSON.parse(event.data); render(); });
  source.addEventListener('commit', (event) => {
    state = JSON.parse(event.data).payload;
    render();
  });
}
defaultDateTime($('newStart'), 30);
defaultDateTime($('newEnd'), 180);
load().then(() => {
  const first = state.sessions[0];
  if (first) { $('grantSession').value = first.id; $('pubSession').value = first.id; $('ticketSession').value = first.id; $('attSession').value = first.id; }
  if (state.publication) { $('pubSession').value = state.publication.sessionId; $('pubTitle').value = state.publication.title; }
}).catch((error) => setMessage(error.message, 'bad'));
connect();
setInterval(load, 8000);
