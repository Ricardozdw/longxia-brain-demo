// 龙虾脑服务端：接收手机指令 → 解析意图 → 下发给电脑端助手 → 汇总状态推回手机和后台。
// 零框架依赖，数据保存在 .runtime/tasks.json。
import http from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { parseIntent, IntentError, ERRORS, STEPS, INTENTS, llmEnabled } from './intent.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME = join(ROOT, '.runtime');
const PORT = Number(process.env.PORT || 4320);
const TASKS_FILE = join(RUNTIME, 'tasks.json');
const TOKEN_FILE = join(RUNTIME, 'token');
const META_FILE = join(RUNTIME, 'meta.json'); // 对话清空时间等用户偏好
const HEARTBEAT_TIMEOUT = 12_000; // 超过 12 秒没心跳视为电脑离线
const RUN_TIMEOUT = 120_000; // 单个任务最长执行时间
const PICKUP_TIMEOUT = 15_000; // 下发后电脑迟迟不领取

mkdirSync(RUNTIME, { recursive: true });
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(9).toString('base64url'), { mode: 0o600 });
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();

// ---------- 数据 ----------
let tasks = existsSync(TASKS_FILE) ? JSON.parse(readFileSync(TASKS_FILE, 'utf8')) : [];
let meta = existsSync(META_FILE) ? JSON.parse(readFileSync(META_FILE, 'utf8')) : {};
let device = { online: false, lastSeen: null, name: null, apps: {}, busy: false };
const queue = []; // 等待电脑领取的任务 id
let agentWaiter = null; // 电脑端长轮询

const now = () => new Date().toISOString();
const FINAL = new Set(['success', 'failed', 'need_input', 'cancelled']);

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    writeFileSync(TASKS_FILE + '.tmp', JSON.stringify(tasks, null, 1));
    renameSync(TASKS_FILE + '.tmp', TASKS_FILE);
  }, 200);
}

// 服务重启时，未完成的任务不自动重做（避免重复入会等副作用），标记为中断
for (const t of tasks) {
  if (!FINAL.has(t.status)) finish(t, 'failed', { error: errorOf('EXEC_ERROR', '服务重启，任务被中断，请重试。') }, false);
}

function errorOf(code, message) {
  const meta = ERRORS[code] || ERRORS.EXEC_ERROR;
  return { code: ERRORS[code] ? code : 'EXEC_ERROR', label: meta.label, message: message || meta.label, suggestion: meta.suggestion };
}

function log(t, message, level = 'info') {
  t.timeline.push({ at: now(), message, level });
  t.updatedAt = now();
}

function setStatus(t, status, message) {
  t.status = status;
  if (message) log(t, message);
  save();
  broadcast();
}

function finish(t, status, { error, result } = {}, notify = true) {
  t.status = status;
  t.finishedAt = now();
  t.durationMs = new Date(t.finishedAt) - new Date(t.createdAt);
  if (error) {
    t.error = error;
    log(t, error.message, 'error');
    for (const s of t.steps || []) if (s.state === 'running') s.state = 'failed';
  }
  if (result) {
    t.result = { ...t.result, ...result };
    if (result.summary) log(t, result.summary, 'success');
  }
  const i = queue.indexOf(t.id);
  if (i >= 0) queue.splice(i, 1);
  save();
  if (notify) broadcast();
}

// ---------- 任务生命周期 ----------
// 多轮补充：上一条在等会议号，用户只回了一串数字 → 接着上一条理解
function contextualText(text, followUpId) {
  const prev = tasks.find(t => t.id === followUpId);
  const waitingCode = prev?.status === 'need_input' && ['MISSING_MEETING_CODE', 'INVALID_MEETING_CODE'].includes(prev.error?.code);
  if (waitingCode && /\d/.test(text) && !/会议|电影|视频|播放|看/.test(text)) return `加入腾讯会议 ${text}`;
  return text;
}

async function createTask(text, source = 'mobile', followUpId) {
  const t = {
    id: randomUUID(),
    text: String(text ?? '').trim().slice(0, 200),
    source,
    status: 'received',
    createdAt: now(),
    updatedAt: now(),
    timeline: [],
    steps: [],
    result: {},
  };
  tasks.push(t);
  log(t, '已收到指令');
  setStatus(t, 'parsing', '正在理解你的指令');

  try {
    t.intent = await parseIntent(contextualText(t.text, followUpId));
  } catch (e) {
    const code = e instanceof IntentError ? e.code : 'EXEC_ERROR';
    finish(t, 'need_input', { error: errorOf(code, e.message) });
    return t;
  }
  t.steps = STEPS[t.intent.type].map(s => ({ ...s, state: 'pending' }));
  log(t, `理解为：${t.intent.summary}`);

  if (!isOnline()) {
    finish(t, 'failed', { error: errorOf('DEVICE_OFFLINE', '电脑当前离线，任务未下发。') });
    return t;
  }
  queue.push(t.id);
  setStatus(t, 'dispatched', device.busy || queue.length > 1 ? '已下发，电脑正在处理上一个任务，稍后开始' : '已下发到电脑');
  t.dispatchedAt = now();
  wakeAgent();
  return t;
}

function isOnline() {
  return Boolean(device.lastSeen && Date.now() - new Date(device.lastSeen) < HEARTBEAT_TIMEOUT);
}

function wakeAgent() {
  if (!agentWaiter || !queue.length) return;
  const t = tasks.find(x => x.id === queue[0]);
  queue.shift();
  const { res, timer } = agentWaiter;
  clearTimeout(timer);
  agentWaiter = null;
  t.startedAt = now();
  setStatus(t, 'running', '电脑已开始执行');
  json(res, 200, { task: { id: t.id, text: t.text, intent: t.intent } });
}

function onAgentEvent(t, ev) {
  if (FINAL.has(t.status)) return;
  if (ev.kind === 'step') {
    const step = t.steps.find(s => s.key === ev.key);
    if (step) {
      step.state = ev.state;
      if (ev.message && ev.state !== 'running') step.detail = String(ev.message).slice(0, 200);
    }
    if (ev.message) log(t, ev.message, ev.state === 'failed' ? 'warn' : 'info');
    if (ev.data) t.result = { ...t.result, ...ev.data };
    save();
    broadcast();
  } else if (ev.kind === 'result') {
    if (ev.ok) {
      for (const s of t.steps) if (s.state !== 'done') s.state = 'done';
      finish(t, 'success', { result: { ...ev.data, summary: ev.summary } });
    } else {
      if (ev.data) t.result = { ...t.result, ...ev.data };
      finish(t, 'failed', { error: errorOf(ev.errorCode, ev.message) });
    }
  }
}

// 看门狗：电脑掉线 / 超时
setInterval(() => {
  const online = isOnline();
  if (device.online !== online) {
    device.online = online;
    broadcast();
  }
  for (const t of tasks) {
    if (t.status === 'running' && Date.now() - new Date(t.startedAt) > RUN_TIMEOUT) {
      finish(t, 'failed', { error: errorOf('TIMEOUT', '电脑执行超时（超过 2 分钟），结果未确认。') });
    }
    if (t.status === 'running' && !online) {
      finish(t, 'failed', { error: errorOf('DEVICE_OFFLINE', '执行过程中电脑断开连接，请查看电脑状态后重试。') });
    }
    if (t.status === 'dispatched' && !online && Date.now() - new Date(t.dispatchedAt) > PICKUP_TIMEOUT) {
      finish(t, 'failed', { error: errorOf('DEVICE_OFFLINE', '电脑长时间未响应，任务已取消下发。') });
    }
  }
}, 2000);

// ---------- 实时推送（SSE） ----------
const clients = new Set();
function publicTask(t) {
  const { timeline, ...rest } = t;
  return { ...rest, timeline: timeline.slice(-30), intentLabel: t.intent ? INTENTS[t.intent.type] : null };
}
function snapshot(view) {
  // 用户清空对话只影响对话视图；进行中的任务保留，后台统计数据不受影响
  const visible = tasks.filter(t => !t.mock && (!meta.clearedAt || t.createdAt > meta.clearedAt || !FINAL.has(t.status)));
  const list = view === 'admin' ? tasks : visible.slice(-20);
  return {
    device: { ...device, online: isOnline() },
    parser: llmEnabled() ? 'llm' : 'rules',
    queue: queue.length,
    tasks: list.map(publicTask).reverse(),
  };
}
let broadcastTimer = null;
function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    for (const c of clients) c.res.write(`data: ${JSON.stringify(snapshot(c.view))}\n\n`);
  }, 50);
}

// ---------- HTTP ----------
function json(res, code, data) {
  if (res.headersSent || res.writableEnded) return; // 长轮询等场景下连接可能已被应答
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
async function readBody(req) {
  let s = '';
  for await (const chunk of req) {
    s += chunk;
    if (s.length > 20_000) throw new Error('请求过大');
  }
  return s ? JSON.parse(s) : {};
}
const isLocal = req => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
const authed = (req, url) => (req.headers['x-token'] || url.searchParams.get('t')) === TOKEN;

function lanUrls() {
  return Object.entries(networkInterfaces())
    .filter(([name]) => /^en\d/.test(name))
    .flatMap(([, list]) => list)
    .filter(a => a.family === 'IPv4' && !a.internal)
    .map(a => `http://${a.address}:${PORT}/?t=${TOKEN}`);
}

const STATIC = {
  '/': 'mobile.html',
  '/admin': 'admin.html',
  '/mobile.js': 'mobile.js',
  '/admin.js': 'admin.js',
  '/style.css': 'style.css',
  '/admin.css': 'admin.css',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;
  try {
    if (req.method === 'GET' && STATIC[path]) {
      const file = STATIC[path];
      res.writeHead(200, { 'Content-Type': MIME[extname(file)], 'Cache-Control': 'no-store' });
      return res.end(readFileSync(join(ROOT, 'public', file)));
    }

    // 后台页面在电脑本机打开时自动获取访问凭证，并生成手机扫码链接
    if (path === '/api/bootstrap') {
      if (!isLocal(req)) return json(res, 403, { error: '请在电脑本机打开后台' });
      return json(res, 200, { token: TOKEN, phoneUrls: lanUrls() });
    }

    // ---- 电脑端助手通道 ----
    if (path.startsWith('/agent/')) {
      if (req.headers['x-token'] !== TOKEN) return json(res, 401, { error: 'unauthorized' });
      if (path === '/agent/heartbeat' && req.method === 'POST') {
        const b = await readBody(req);
        const wasOnline = isOnline();
        device = { ...device, ...b, lastSeen: now(), online: true };
        if (!wasOnline) broadcast();
        return json(res, 200, { ok: true });
      }
      if (path === '/agent/next' && req.method === 'GET') {
        if (agentWaiter) {
          clearTimeout(agentWaiter.timer);
          json(agentWaiter.res, 200, { task: null });
        }
        const timer = setTimeout(() => {
          if (agentWaiter?.res === res) agentWaiter = null;
          json(res, 200, { task: null });
        }, 20_000);
        agentWaiter = { res, timer };
        req.on('close', () => {
          if (agentWaiter?.res === res) {
            clearTimeout(timer);
            agentWaiter = null;
          }
        });
        return wakeAgent();
      }
      const m = path.match(/^\/agent\/tasks\/([\w-]+)\/events$/);
      if (m && req.method === 'POST') {
        const t = tasks.find(x => x.id === m[1]);
        if (!t) return json(res, 404, { error: 'not found' });
        onAgentEvent(t, await readBody(req));
        return json(res, 200, { ok: true, cancelled: t.status === 'cancelled' });
      }
      return json(res, 404, { error: 'not found' });
    }

    // ---- 手机端 / 后台接口 ----
    if (path.startsWith('/api/')) {
      if (!authed(req, url)) return json(res, 401, { error: '设备未绑定，请扫描电脑上的二维码打开' });

      if (path === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
        const client = { res, view: url.searchParams.get('view') === 'admin' ? 'admin' : 'mobile' };
        clients.add(client);
        res.write(`data: ${JSON.stringify(snapshot(client.view))}\n\n`);
        const ping = setInterval(() => res.write(': ping\n\n'), 15000);
        req.on('close', () => {
          clearInterval(ping);
          clients.delete(client);
        });
        return;
      }
      if (path === '/api/tasks' && req.method === 'POST') {
        const b = await readBody(req);
        const active = tasks.filter(t => ['parsing', 'dispatched', 'running'].includes(t.status)).length;
        if (active >= 5) return json(res, 429, { error: '排队任务太多了，请等当前任务完成后再试' });
        return json(res, 201, publicTask(await createTask(b.text, 'mobile', b.followUp)));
      }
      if (path === '/api/clear' && req.method === 'POST') {
        meta.clearedAt = now();
        writeFileSync(META_FILE, JSON.stringify(meta));
        broadcast();
        return json(res, 200, { ok: true });
      }
      const m = path.match(/^\/api\/tasks\/([\w-]+)\/(retry|cancel)$/);
      if (m && req.method === 'POST') {
        const t = tasks.find(x => x.id === m[1]);
        if (!t) return json(res, 404, { error: '任务不存在' });
        if (m[2] === 'retry') return json(res, 201, publicTask(await createTask(t.text, 'retry')));
        if (t.status !== 'dispatched') return json(res, 409, { error: '任务已开始执行，无法取消' });
        finish(t, 'cancelled', { error: { code: 'CANCELLED', label: '用户取消', message: '你已取消该任务，电脑未执行。' } });
        return json(res, 200, publicTask(t));
      }
      const shot = path.match(/^\/api\/shots\/([\w-]+)\.png$/);
      if (shot) {
        const file = join(RUNTIME, 'shots', `${shot[1]}.png`);
        if (!existsSync(file)) return json(res, 404, { error: '暂无截图' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=3600' });
        return res.end(readFileSync(file));
      }
      return json(res, 404, { error: '接口不存在' });
    }
    json(res, 404, { error: '页面不存在' });
  } catch (e) {
    console.error(e);
    json(res, 400, { error: e.message });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🦞 龙虾脑服务已启动`);
  console.log(`   后台看板（电脑浏览器打开）：http://localhost:${PORT}/admin`);
  for (const u of lanUrls()) console.log(`   手机访问（同一 Wi-Fi）：${u}`);
  console.log(`   意图解析：${llmEnabled() ? '大模型 + 规则兜底' : '本地规则'}\n`);
});
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `端口 ${PORT} 已被占用，请先关闭之前启动的服务。` : e.message);
  process.exit(1);
});
