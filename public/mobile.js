// 用户端：对话式 personal agent。每个任务 = 一句用户指令 + 一条 Agent 回复；
// 执行过程默认折叠成一行状态，需要时再展开。
const $ = s => document.querySelector(s);
const thread = $('#thread');
const LIVE = new Set(['received', 'parsing', 'dispatched', 'running']);
const FOLLOW_UP_CODES = new Set(['MISSING_MEETING_CODE', 'INVALID_MEETING_CODE']);
const STARTERS = [
  ['🎬 放个热门电影', '搜索一部热门电影并播放相关视频'],
  ['➕ 开个会', '创建一个腾讯会议'],
  ['📞 加入会议', '加入腾讯会议，会议码1234'],
  ['⏹ 全部关闭', '关闭'],
];
// 完成后可以一键跟进的操作（相当于替用户说下一句话）
const NEXT = {
  video: [['暂停', '暂停视频'], ['关闭视频', '关闭视频']],
  meeting_join: [['退出会议', '退出会议']],
  meeting_create: [['退出会议', '退出会议'], ['结束会议', '结束会议']],
};

// 设备绑定：扫码链接里带 ?t=，保存后从地址栏去掉
const params = new URLSearchParams(location.search);
let token = params.get('t');
if (token) {
  try { localStorage.setItem('lx_token', token); } catch {}
  history.replaceState(null, '', '/');
}
try { token = token || localStorage.getItem('lx_token'); } catch {}

let state = null;
let sending = false;
const openProcess = new Set(); // 用户手动展开过的执行过程

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = iso => new Date(iso).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const sec = ms => (ms / 1000).toFixed(1) + ' 秒';
const pretty = code => String(code).replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 2400);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Token': token },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '请求失败');
  return data;
}

// ---------- Agent 的话 ----------
function reply(t) {
  const a = baseReply(t);
  // 最近一条成功任务下方给出跟进操作
  if (t.status === 'success' && NEXT[t.intent?.type] && t.id === state.tasks.find(x => x.status === 'success')?.id) {
    a.links = [...(a.links || []), ...NEXT[t.intent.type].map(([label, text]) => [label, 'say:' + text])];
  }
  return a;
}

function baseReply(t) {
  const i = t.intent;
  const r = t.result || {};
  const e = t.error || {};
  switch (t.status) {
    case 'received':
    case 'parsing':
      return { text: '收到，我想想怎么做…' };
    case 'dispatched':
      return { text: state.device.busy ? '电脑正在忙上一件事，这件排在后面，马上就轮到。' : '好的，交给电脑去办。', links: [['取消', 'cancel']] };
    case 'running':
      if (i.type === 'video_control') return { text: { pause: '正在暂停视频。', resume: '正在继续播放。', close: '正在关闭视频。' }[i.params.action] };
      if (i.type === 'meeting_leave') return { text: '正在让电脑离开会议。' };
      if (i.type === 'meeting_end') return { text: '正在结束会议。' };
      if (i.type === 'close_auto') return { text: '我看看电脑上在做什么，然后帮你关掉。' };
      if (i.type === 'video') return { text: i.params.pickHot ? '我去挑一部最近的热门电影，在电脑上放给你看。' : `我在电脑上找《${esc(i.params.movie)}》的视频。` };
      if (i.type === 'meeting_join') return { text: `正在让电脑加入会议 <b>${pretty(i.params.meetingCode)}</b>。` };
      return { text: '正在电脑上开一个快速会议。' };
    case 'success':
      if (!NEXT[i.type]) {
        // 控制类任务：一句话确认；暂停后顺手给出「继续播放」
        const paused = i.type === 'video_control' && i.params.action === 'pause';
        return { text: `好了，${esc(r.summary)}。`, links: paused ? [['继续播放', 'say:继续播放']] : [] };
      }
      if (i.type === 'video') {
        return {
          text: `搞定了，电脑正在播放<b>《${esc(r.movie)}》</b>的相关视频。${r.movieSource ? `<span class="sub">（选自${esc(r.movieSource)}）</span>` : ''}`,
          attach: r.screenshot ? `<a href="${shotUrl(t)}" target="_blank"><img class="shot" src="${shotUrl(t)}" alt="电脑当前画面" loading="lazy"></a>` : '',
        };
      }
      if (i.type === 'meeting_join') {
        return { text: r.waitingRoom ? `电脑已经进入会议 <b>${pretty(r.meetingCode)}</b> 的等候室，等主持人同意就能入会。` : `电脑已经进入会议 <b>${pretty(r.meetingCode)}</b> 了。` };
      }
      return r.meetingCode
        ? { text: '会议开好了，把会议号发给大家就能加入：', attach: `<div class="code"><b>${pretty(r.meetingCode)}</b><button class="link primary" data-copy="${r.meetingCode}">复制</button></div>` }
        : { text: '会议开好了，会议号可以在电脑上查看。' };
    case 'need_input':
      return {
        text: `${esc(e.message)}${FOLLOW_UP_CODES.has(e.code) ? ' <span class="tone-warn">直接回复 9 位会议号就行。</span>' : ''}`,
        sub: FOLLOW_UP_CODES.has(e.code) ? '' : e.suggestion,
      };
    case 'failed':
      if (e.code === 'NOTHING_TO_CLOSE') return { text: esc(e.message) };
      return { text: `<span class="tone-bad">这次没办成：</span>${esc(e.message)}`, sub: e.suggestion, links: [['重试', 'retry']] };
    case 'cancelled':
      return { text: '好，已取消，电脑没有执行。' };
  }
  return { text: '' };
}

function shotUrl(t) {
  return `/api/shots/${t.id}.png?t=${encodeURIComponent(token)}`;
}

function processHtml(t) {
  if (!t.steps?.length || !t.dispatchedAt) return ''; // 没下发到电脑的任务没有执行过程
  const live = LIVE.has(t.status);
  const current = t.steps.find(s => s.state === 'running') || t.steps.find(s => s.state === 'pending');
  const doneCount = t.steps.filter(s => s.state === 'done').length;
  let label;
  if (live) label = `<span class="spin"></span>${esc(current?.label || '准备中')} · ${Math.min(doneCount + 1, t.steps.length)}/${t.steps.length}`;
  else label = `执行过程 · ${t.steps.length} 步${t.durationMs ? ' · ' + sec(t.durationMs) : ''}`;
  const open = openProcess.has(t.id) ? ' open' : '';
  return `<details class="process${live ? ' live' : ''}" data-id="${t.id}"${open}><summary>${label}</summary><ol>
    ${t.steps.map(s => `<li class="${s.state}"><span>${esc(s.label)}</span>${s.detail ? `<em>${esc(s.detail)}</em>` : ''}</li>`).join('')}
  </ol></details>`;
}

function turnHtml(t) {
  const a = reply(t);
  const links = (a.links || []).map(([label, act]) => `<button class="link${act === 'retry' ? ' primary' : ''}" data-act="${esc(act)}" data-id="${t.id}">${label}</button>`).join('');
  return `<section class="turn" data-id="${t.id}">
    <div class="me"><time>${clock(t.createdAt)}</time><p>${esc(t.text)}</p></div>
    <div class="agent"><span class="avatar">🦞</span><div class="body">
      <p class="say ${a.tone ? 'tone-' + a.tone : ''}">${a.text}</p>
      ${a.sub ? `<p class="say sub">${esc(a.sub)}</p>` : ''}
      ${a.attach ? `<div class="attach">${a.attach}</div>` : ''}
      ${processHtml(t)}
      ${links ? `<div class="links">${links}</div>` : ''}
    </div></div>
  </section>`;
}

function helloHtml() {
  return `<section class="turn hello"><div class="agent"><span class="avatar">🦞</span><div class="body">
    <h1>嗨，我是你的龙虾脑</h1>
    <p>告诉我想让电脑做什么，我来操作，做完告诉你结果。</p>
    <p>现在我会：在电脑上放电影视频、加入或创建腾讯会议。</p>
  </div></div></section>`;
}

function awaitingFollowUp() {
  const last = state?.tasks[0];
  return last && last.status === 'need_input' && FOLLOW_UP_CODES.has(last.error?.code) ? last : null;
}

// ---------- 渲染 ----------
function renderDevice(device) {
  const el = $('#device');
  const text = el.querySelector('span');
  if (!device) { el.className = 'off'; text.textContent = '服务未连接'; }
  else if (!device.online) { el.className = 'off'; text.textContent = '电脑离线'; }
  else if (device.busy) { el.className = 'on busy'; text.textContent = '正在电脑上执行…'; }
  else { el.className = 'on'; text.textContent = `已连接 ${(device.name || '我的电脑').replace(/（macOS）$/, '')}`; }
}

// 用户停留在底部时，新内容（包括后加载的截图）出现后保持贴底
let stick = true;
thread.addEventListener('scroll', () => {
  stick = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 120;
});
thread.addEventListener('load', () => { if (stick) thread.scrollTop = thread.scrollHeight; }, true);

let lastIds = '';
function render() {
  renderDevice(state.device);
  const nearBottom = stick;
  const tasks = [...state.tasks].reverse(); // 时间正序
  thread.innerHTML = helloHtml() + tasks.map(turnHtml).join('');
  const ids = tasks.map(t => t.id).join();
  if (ids !== lastIds) {
    thread.lastElementChild?.classList.add('new');
    thread.scrollTop = thread.scrollHeight;
  } else if (nearBottom) {
    thread.scrollTop = thread.scrollHeight;
  }
  lastIds = ids;

  $('#clear').hidden = !tasks.some(t => !LIVE.has(t.status));
  const follow = awaitingFollowUp();
  $('#input').placeholder = follow ? '回复 9 位会议号，例如 123 456 789' : '想让电脑做什么？';
  $('#chips').innerHTML = follow ? '' : STARTERS.map(([label, text]) => `<button data-text="${esc(text)}">${label}</button>`).join('');
}

function connect() {
  if (!token) {
    thread.innerHTML = `<section class="turn hello"><div class="agent"><span class="avatar">🦞</span><div class="body">
      <h1>先把我和你的电脑连起来</h1>
      <p>在电脑上打开龙虾脑后台（localhost:4320/admin），用手机扫描页面上的二维码就好。</p></div></div></section>`;
    $('#composer').hidden = true;
    return;
  }
  es?.close();
  es = new EventSource(`/api/stream?view=mobile&t=${encodeURIComponent(token)}`);
  es.onmessage = e => {
    state = JSON.parse(e.data);
    render();
  };
  es.onerror = () => {
    renderDevice(null);
    // 浏览器放弃自动重连时（服务重启、手机休眠后），自己隔几秒再连
    if (es.readyState === EventSource.CLOSED) setTimeout(connect, 3000);
  };
}
let es = null;
// 手机切回前台时，连接可能已被系统断开，直接重连拿最新状态
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && token) connect();
});

async function submit(text) {
  text = text.trim();
  if (!text || sending) return;
  sending = true;
  $('#send').disabled = true;
  try {
    const follow = awaitingFollowUp();
    await api('/api/tasks', { text, followUp: follow?.id });
    $('#input').value = '';
    autosize();
  } catch (e) {
    toast(e.message);
  } finally {
    sending = false;
    $('#send').disabled = false;
  }
}

function autosize() {
  const el = $('#input');
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

$('#form').addEventListener('submit', e => {
  e.preventDefault();
  submit($('#input').value);
});
$('#input').addEventListener('input', autosize);
$('#input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit($('#input').value);
  }
});
$('#chips').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (b) submit(b.dataset.text);
});
thread.addEventListener('toggle', e => {
  const d = e.target;
  if (!d.matches?.('details.process')) return;
  if (d.open) openProcess.add(d.dataset.id);
  else openProcess.delete(d.dataset.id);
}, true);
thread.addEventListener('click', async e => {
  const b = e.target.closest('button');
  if (!b) return;
  try {
    if (b.dataset.act?.startsWith('say:')) return submit(b.dataset.act.slice(4));
    if (b.dataset.act === 'retry') await api(`/api/tasks/${b.dataset.id}/retry`);
    if (b.dataset.act === 'cancel') await api(`/api/tasks/${b.dataset.id}/cancel`);
    if (b.dataset.copy) {
      await navigator.clipboard?.writeText(b.dataset.copy).catch(() => {});
      toast('会议号已复制');
    }
  } catch (err) {
    toast(err.message);
  }
});

// 清空对话：点一次进入确认态，3 秒内再点才执行
$('#clear').addEventListener('click', async () => {
  const b = $('#clear');
  if (!b.classList.contains('confirm')) {
    b.classList.add('confirm');
    b.textContent = '确认清空？';
    clearTimeout(b.t);
    b.t = setTimeout(() => {
      b.classList.remove('confirm');
      b.textContent = '🗑 清空记录';
    }, 3000);
    return;
  }
  clearTimeout(b.t);
  b.classList.remove('confirm');
  b.textContent = '🗑 清空记录';
  try {
    await api('/api/clear');
    toast('对话记录已清空');
  } catch (e) {
    toast(e.message);
  }
});

connect();
