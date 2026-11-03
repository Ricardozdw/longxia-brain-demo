// 运营后台：所有指标由任务明细实时计算
const $ = s => document.querySelector(s);
const STATUS = { received: '已接收', parsing: '理解中', dispatched: '已下发', running: '执行中', success: '成功', failed: '失败', need_input: '需补充', cancelled: '已取消' };
const SCENES = { video: '🎬 电影视频', meeting_join: '📞 加入会议', meeting_create: '➕ 创建会议', video_control: '⏯ 视频控制', meeting_leave: '📴 退出会议', meeting_end: '🛑 结束会议', close_auto: '⏹ 一键关闭' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

let token, state, filter = 'all';
let includeMock = true;
try { includeMock = localStorage.getItem('lx_mock') !== '0'; } catch {}

async function boot() {
  const res = await fetch('/api/bootstrap');
  if (!res.ok) {
    document.body.innerHTML = '<p style="padding:40px">请在运行龙虾脑的电脑上通过 http://localhost:4320/admin 打开后台。</p>';
    return;
  }
  const b = await res.json();
  token = b.token;
  const url = b.phoneUrls[0];
  if (url) {
    $('#phone-url').textContent = url.replace(/\?t=.*/, '');
    $('#phone-url').href = url;
    if (window.QRCode) new QRCode($('#qr'), { text: url, width: 300, height: 300, correctLevel: QRCode.CorrectLevel.M });
    else $('#qr').textContent = '二维码组件加载失败，请手动在手机输入下方地址';
  } else {
    $('#qr').textContent = '未检测到局域网，请连接 Wi-Fi';
  }
  const es = new EventSource(`/api/stream?view=admin&t=${encodeURIComponent(token)}`);
  es.onmessage = e => {
    state = JSON.parse(e.data);
    render();
  };
  es.onerror = () => {
    $('#device').className = 'pill off';
    $('#device').textContent = '服务未连接';
  };
}

function render() {
  const d = state.device;
  $('#device').className = 'pill ' + (d.online ? 'on' : 'off');
  $('#device').textContent = d.online ? `${d.name || '电脑'} · ${d.busy ? '执行中' : '在线'}` : '电脑离线';
  $('#parser').textContent = state.parser === 'llm' ? '意图解析：大模型 + 规则兜底' : '意图解析：本地规则';
  const hasMock = state.tasks.some(t => t.mock);
  $('#mock-toggle').hidden = !hasMock;
  $('#include-mock').checked = includeMock;
  const tasks = state.tasks.filter(t => includeMock || !t.mock);

  renderKpis(tasks);
  renderTrend(tasks);
  renderFunnel(tasks);
  renderScenarios(tasks);
  renderReasons(tasks);
  renderRows(tasks);
}

function renderKpis(tasks) {
  const done = tasks.filter(t => t.status === 'success');
  const failed = tasks.filter(t => t.status === 'failed');
  const need = tasks.filter(t => t.status === 'need_input');
  const understood = tasks.filter(t => t.intent);
  const avg = done.length ? done.reduce((s, t) => s + t.durationMs, 0) / done.length / 1000 : 0;
  const today = new Date().toDateString();
  const todayCount = tasks.filter(t => new Date(t.createdAt).toDateString() === today).length;
  const kpis = [
    { label: '任务总数', value: tasks.length, sub: `今日 ${todayCount} 个` },
    { label: '端到端完成率', value: pct(done.length, tasks.length), unit: '%', sub: `成功 ${done.length} / 全部 ${tasks.length}` },
    { label: '执行成功率', value: pct(done.length, done.length + failed.length), unit: '%', sub: '仅统计已下发到电脑的任务' },
    { label: '平均完成耗时', value: avg.toFixed(1), unit: '秒', sub: '从发出指令到完成' },
    { label: '指令理解率', value: pct(understood.length, tasks.length), unit: '%', sub: `需补充信息 ${need.length} 次` },
  ];
  $('#kpis').innerHTML = kpis.map(k => `
    <div class="kpi"><div class="label">${k.label}</div><div class="value">${k.value}${k.unit ? `<small>${k.unit}</small>` : ''}</div><div class="sub">${k.sub}</div></div>`).join('');
}

function renderTrend(tasks) {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    days.push({ d, key: d.toDateString(), ok: 0, bad: 0, warn: 0 });
  }
  for (const t of tasks) {
    const day = days.find(x => x.key === new Date(t.createdAt).toDateString());
    if (!day) continue;
    if (t.status === 'success') day.ok++;
    else if (t.status === 'failed') day.bad++;
    else if (t.status === 'need_input') day.warn++;
  }
  const max = Math.max(1, ...days.map(d => d.ok + d.bad + d.warn));
  const H = 160;
  $('#trend').innerHTML = days.map(d => {
    const total = d.ok + d.bad + d.warn;
    const seg = (n, cls) => (n ? `<div class="seg ${cls}" style="height:${Math.max(2, (n / max) * H)}px"></div>` : '');
    return `<div class="day" data-tip="${d.d.getMonth() + 1}/${d.d.getDate()}：成功 ${d.ok} · 失败 ${d.bad} · 需补充 ${d.warn}">
      <div class="total">${total || ''}</div><div class="stack">${seg(d.ok, 'ok')}${seg(d.bad, 'bad')}${seg(d.warn, 'warn')}</div></div>`;
  }).join('');
  const x = days.map(d => `<span>${d.d.getMonth() + 1}/${d.d.getDate()}</span>`).join('');
  let axis = $('#trend').nextElementSibling;
  if (!axis?.classList.contains('days-x')) {
    axis = document.createElement('div');
    axis.className = 'days-x';
    $('#trend').after(axis);
  }
  axis.innerHTML = x;
}

function hbars(el, rows, { red = false, unit = '' } = {}) {
  if (!rows.length) {
    el.innerHTML = '<div class="empty-note">暂无数据</div>';
    return;
  }
  const max = Math.max(1, ...rows.map(r => r.value));
  el.innerHTML = rows.map(r => `
    <div class="hb" data-tip="${esc(r.tip || `${r.label}：${r.value}${unit}`)}">
      <span class="hb-label">${esc(r.label)}</span>
      <div class="track"><div class="fill ${red ? 'red' : ''}" style="width:${(r.value / max) * 100}%"></div></div>
      <span class="hb-val">${r.value}${r.extra ? ` <small>${r.extra}</small>` : ''}</span>
    </div>`).join('');
}

function renderFunnel(tasks) {
  const n = tasks.length;
  const understood = tasks.filter(t => t.intent).length;
  const dispatched = tasks.filter(t => t.dispatchedAt).length;
  const success = tasks.filter(t => t.status === 'success').length;
  hbars($('#funnel'), [
    { label: '用户发出指令', value: n, extra: '100%' },
    { label: '成功理解意图', value: understood, extra: pct(understood, n) + '%' },
    { label: '下发到电脑', value: dispatched, extra: pct(dispatched, n) + '%' },
    { label: '执行成功', value: success, extra: pct(success, n) + '%' },
  ]);
}

function renderScenarios(tasks) {
  const rows = Object.entries(SCENES).map(([type, label]) => {
    const list = tasks.filter(t => t.intent?.type === type);
    const ok = list.filter(t => t.status === 'success');
    const fin = list.filter(t => ['success', 'failed'].includes(t.status)).length;
    const avg = ok.length ? (ok.reduce((s, t) => s + t.durationMs, 0) / ok.length / 1000).toFixed(1) + ' 秒' : '—';
    const rate = pct(ok.length, fin);
    return `<tr><td>${label}</td><td class="num">${list.length}</td>
      <td class="num"><span class="rate"><i style="width:${rate}%"></i></span>${fin ? rate + '%' : '—'}</td><td class="num">${avg}</td></tr>`;
  });
  $('#scenarios').innerHTML = `<tr><th>场景</th><th>任务数</th><th>执行成功率</th><th>平均耗时</th></tr>${rows.join('')}`;
}

function renderReasons(tasks) {
  const map = {};
  for (const t of tasks) {
    if (!t.error || t.status === 'cancelled') continue;
    map[t.error.label] = (map[t.error.label] || 0) + 1;
  }
  const total = Object.values(map).reduce((a, b) => a + b, 0);
  const rows = Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, 7)
    .map(([label, value]) => ({ label, value, extra: pct(value, total) + '%' }));
  hbars($('#reasons'), rows, { red: true });
}

function renderRows(tasks) {
  const list = tasks.filter(t => filter === 'all' || t.status === filter).slice(0, 80);
  $('#rows').innerHTML = list.map(t => {
    const when = new Date(t.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const outcome = t.status === 'success' ? t.result?.summary : t.error ? `${t.error.label}：${t.error.message}` : '';
    return `<tr>
      <td class="t">${when}</td>
      <td class="cmd">${esc(t.text)}${t.mock ? '<span class="mock">模拟</span>' : ''}</td>
      <td>${t.intent ? SCENES[t.intent.type] : '<span class="muted">未识别</span>'}</td>
      <td><span class="st ${t.status}">${STATUS[t.status]}</span></td>
      <td class="t">${t.durationMs ? (t.durationMs / 1000).toFixed(1) + 's' : '—'}</td>
      <td>${esc(outcome)}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="empty-note">暂无任务</td></tr>';
}

$('#include-mock').addEventListener('change', e => {
  includeMock = e.target.checked;
  try { localStorage.setItem('lx_mock', includeMock ? '1' : '0'); } catch {}
  render();
});
$('#filters').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll('#filters button').forEach(x => x.classList.toggle('on', x === b));
  render();
});

// 悬停提示
const tip = $('#tip');
document.addEventListener('mousemove', e => {
  const el = e.target.closest('[data-tip]');
  if (!el) return (tip.hidden = true);
  tip.textContent = el.dataset.tip;
  tip.hidden = false;
  tip.style.left = e.clientX + 12 + 'px';
  tip.style.top = e.clientY + 12 + 'px';
});

boot();
