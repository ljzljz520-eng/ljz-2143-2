const el = {
  body: document.body,
  layer: document.getElementById('visualLayer'),
  activity: document.getElementById('screenActivity'),
  session: document.getElementById('screenSession'),
  confirmed: document.getElementById('confirmedCount'),
  tentative: document.getElementById('tentativeCount'),
  eligible: document.getElementById('eligibleCount'),
  subtitle: document.getElementById('screenSubtitle'),
  meta: document.getElementById('screenMeta'),
  card: document.querySelector('.screen-card')
};
let currentPubId = '';
let lastRevision = -1;
let failedVisual = false;

function markOnline(text = '已连接服务端事件') {
  el.meta.textContent = `${text} · ${new Date().toLocaleTimeString()} · 不含个人敏感信息`;
}

function applyVisual(state) {
  failedVisual = false;
  el.layer.classList.remove('broken');
  if (!state.visualUrl) {
    el.layer.style.backgroundImage = 'none';
    el.layer.classList.add('broken');
    return;
  }
  // 先预加载，成功后才把背景从旧主视觉切到新主视觉；失败则保留可操作签到状态与纯 CSS 主屏。
  const probe = new Image();
  probe.onload = () => {
    el.layer.style.backgroundImage = `url("${state.visualUrl}")`;
    el.layer.classList.remove('broken');
  };
  probe.onerror = () => {
    el.layer.classList.add('broken');
    el.layer.style.backgroundImage = 'none';
    failedVisual = true;
  };
  probe.src = state.visualUrl;
}

function render(state) {
  if (!state.published) {
    el.activity.textContent = '等待发布';
    el.session.textContent = '请在工作台选择活动场次';
    el.confirmed.textContent = '--';
    el.tentative.textContent = '--';
    el.eligible.textContent = '--';
    el.subtitle.textContent = '';
    el.layer.classList.add('broken');
    return;
  }
  const switched = state.publicationId !== currentPubId;
  // 同一个对象中的 sessionId、activityName、title、counts 来自同一次服务端响应；
  // 先写文本，再切换视觉与旋转，避免大屏出现“新人数字 + 旧场次名”的中间帧。
  el.activity.textContent = state.activityName;
  el.session.textContent = state.sessionName;
  el.confirmed.textContent = state.counts?.confirmed ?? 0;
  el.tentative.textContent = state.counts?.tentative ?? 0;
  el.eligible.textContent = state.counts?.eligible ?? 0;
  el.subtitle.textContent = state.subtitle || '';
  document.documentElement.style.colorScheme = state.theme === 'light' ? 'light' : 'dark';
  el.body.classList.toggle('light', state.theme === 'light');
  el.body.classList.toggle('festive', state.theme === 'festive');
  el.body.classList.toggle('rotate-90', state.rotation === 90);
  el.body.classList.toggle('rotate-180', state.rotation === 180);
  el.body.classList.toggle('rotate-270', state.rotation === 270);
  if (switched || failedVisual) applyVisual(state);
  currentPubId = state.publicationId;
  lastRevision = state.revision;
  el.card.animate([{ opacity: switched ? .35 : .96 }, { opacity: 1 }], { duration: switched ? 760 : 260 });
}

async function poll() {
  try {
    const res = await fetch('/api/screen', { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const state = await res.json();
    if (state.revision !== lastRevision || state.publicationId !== currentPubId) render(state);
    markOnline('轮询已同步');
  } catch (error) {
    el.meta.textContent = `网络中断，保留最后画面；图片损坏不影响签到：${error.message}`;
  }
}

function connect() {
  const source = new EventSource('/api/events?scope=public');
  source.addEventListener('hello', (event) => render(JSON.parse(event.data)));
  source.addEventListener('commit', (event) => {
    const message = JSON.parse(event.data);
    if (message.payload?.revision !== lastRevision || message.payload?.publicationId !== currentPubId) {
      render(message.payload);
    }
    markOnline(`实时事件 ${message.commit?.type || ''}`);
  });
  source.onerror = () => {
    el.meta.textContent = '实时连接断开，使用 5 秒轮询兜底，最后画面持续可见';
  };
}

connect();
setInterval(poll, 5000);
poll();
