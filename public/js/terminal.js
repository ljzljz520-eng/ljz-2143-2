const $ = (id) => document.getElementById(id);
const storage = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) { localStorage.setItem(key, JSON.stringify(value)); }
};

const state = {
  admin: null,
  offline: navigator.onLine === false,
  queue: storage.get('terminal.queue', []),
  synced: storage.get('terminal.synced', []),
  boundScope: storage.get('terminal.boundScope', null)
};

function api(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then(async (res) => {
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.message || data.error || `HTTP ${res.status}`), { data, status: res.status });
    return data;
  });
}

function currentSession() {
  return state.admin?.sessions?.find((item) => item.id === $('sessionId').value) || null;
}

function selectedPerson() {
  const id = $('manualPerson').value.trim();
  return state.admin?.people?.find((person) => person.id === id) || null;
}

function setResult(text, kind = 'ok') {
  $('scanResult').textContent = text;
  $('scanResult').className = `result ${kind}`;
}

function render() {
  const sessions = state.admin?.sessions || [];
  const current = $('sessionId').value;
  $('sessionId').innerHTML = sessions.map((s) => `<option value="${s.id}">${s.activityId} / ${s.name}</option>`).join('');
  if (sessions.some((s) => s.id === current)) $('sessionId').value = current;
  const session = currentSession();
  const scopedQueue = state.queue.filter((item) => item.sessionId === session?.id);
  const tentative = scopedQueue.length + (session?.counts?.unresolvedConflicts || 0);
  $('serverConfirmed').textContent = session?.counts?.confirmed ?? '--';
  $('tentativeCount').textContent = tentative;
  $('queueCount').textContent = scopedQueue.length;
  $('queueList').innerHTML = state.queue.map((item) => `<li><span>${item.personId} · ${item.sessionId}</span><span class="badge conflict">${item.scopeLocked ? '旧场锁定' : '待合并'}</span></li>`).join('') || '<li class="muted">离线队列为空</li>';
  $('netState').textContent = state.offline ? '离线暂存' : '在线强一致';
  $('netState').classList.toggle('offline', state.offline);
  $('goOffline').textContent = state.offline ? '切回在线' : '切换离线';
  storage.set('terminal.queue', state.queue);
  storage.set('terminal.synced', state.synced.slice(-100));
  storage.set('terminal.boundScope', state.boundScope);
}

async function refresh() {
  const res = await fetch('/api/admin');
  state.admin = await res.json();
  render();
}

async function issueTicket() {
  const session = currentSession();
  const person = selectedPerson();
  if (!session || !person) return setResult('请选择场次并输入有效人员 ID', 'bad');
  try {
    const data = await api('/api/tickets', {
      activityId: session.activityId,
      sessionId: session.id,
      personId: person.id,
      ttlMinutes: 120
    });
    $('ticketToken').value = data.token;
    state.boundScope = { activityId: data.activityId, sessionId: data.sessionId, personId: data.personId, expiresAt: data.expiresAt, ticketId: data.ticketId };
    setResult('票据已绑定活动、场次和有效范围，请妥善保存在终端。', 'ok');
    render();
  } catch (error) {
    setResult(`签票失败：${error.message}`, 'bad');
  }
}

function decodeTicket(token) {
  try {
    const [body] = token.split('.');
    return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return null;
  }
}

async function scan() {
  const session = currentSession();
  const token = $('ticketToken').value.trim();
  const ticket = decodeTicket(token);
  const personId = $('manualPerson').value.trim() || ticket?.pid;
  if (!session || !token || !personId) return setResult('缺少场次、人员或票据', 'bad');
  if (!ticket || ticket.aid !== session.activityId || ticket.sid !== session.id) {
    return setResult('票据不属于当前场次：活动换场后旧扫描队列不得进入新人数', 'bad');
  }
  if (state.boundScope && (state.boundScope.activityId !== session.activityId || state.boundScope.sessionId !== session.id)) {
    return setResult('该终端仍保留旧活动票据，请重新签发现场票据', 'bad');
  }
  const idempotencyKey = crypto.randomUUID();
  const payload = {
    action: 'scan',
    activityId: session.activityId,
    sessionId: session.id,
    personId,
    deviceId: $('deviceId').value,
    ticketToken: token,
    idempotencyKey,
    scannedAt: new Date().toISOString()
  };

  if (state.offline) {
    state.queue.push(payload);
    setResult('已离线暂存；当前只增加本终端暂定人数，不计入大屏确认人数。', 'warn');
    render();
    return;
  }

  try {
    const result = await api('/api/checkins', payload);
    $('serverLog').textContent = JSON.stringify(result, null, 2);
    if (['confirmed', 're_entered'].includes(result.status)) setResult(`服务端确认：${result.kind === 'reentry' ? '再次入场' : '入场'}成功`, 'ok');
    else if (result.status === 'duplicate') setResult('同场重复扫码已拒绝；有效签到仍只有一个', 'warn');
    else setResult(`结果：${result.status} / ${result.code || ''}`, 'warn');
    await refresh();
  } catch (error) {
    // 服务器是否已成功未知：保留同一幂等键，进入本地暂存，恢复后重试。
    payload.unknownAfterRequest = true;
    state.queue.push(payload);
    $('serverLog').textContent = error.stack || error.message;
    setResult('网络异常，无法确认服务器结果；已用相同幂等键暂存，稍后重试。', 'warn');
    render();
  }
}

async function syncQueue() {
  const session = currentSession();
  if (!session) return setResult('请选择当前场次', 'bad');
  // 只自动合并当前场次。旧场次票据/队列必须显式由工作台处理，不能串入新人数。
  const mine = state.queue.filter((item) => item.sessionId === session.id);
  const old = state.queue.filter((item) => item.sessionId !== session.id);
  if (!mine.length) return setResult('当前场次没有待合并队列；旧场次队列已锁定保留', 'warn');
  try {
    const result = await api('/api/sync', {
      deviceId: $('deviceId').value,
      batchId: crypto.randomUUID(),
      queue: mine
    });
    $('serverLog').textContent = JSON.stringify(result, null, 2);
    state.synced.push({ batchId: result.batchId, at: result.acceptedAt, results: result.results });
    state.queue = old;
    const conflicts = result.results.filter((item) => item.status === 'conflict').length;
    setResult(conflicts ? `已合并，${conflicts} 条进入工作台冲突队列` : '队列已服务端确认，同一幂等键不会重复计数', conflicts ? 'warn' : 'ok');
    await refresh();
  } catch (error) {
    setResult(`合并失败，队列保留并可重试：${error.message}`, 'bad');
  }
}

$('issueTicket').addEventListener('click', issueTicket);
$('scanBtn').addEventListener('click', scan);
$('syncNow').addEventListener('click', syncQueue);
$('goOffline').addEventListener('click', () => { state.offline = !state.offline; render(); });
$('sessionId').addEventListener('change', () => {
  const s = currentSession();
  if (state.boundScope && s && state.boundScope.sessionId !== s.id) setResult('已换场：旧票据与旧扫描队列不可用于新场次。', 'warn');
  render();
});
window.addEventListener('online', () => { state.offline = false; render(); });
window.addEventListener('offline', () => { state.offline = true; render(); });

refresh().catch((error) => {
  setResult(`无法连接服务端：${error.message}`, 'bad');
  render();
});
setInterval(() => refresh().catch(() => render()), 5000);
render();
