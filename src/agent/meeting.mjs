// 场景二：加入 / 创建腾讯会议（macOS 客户端）。
// 通过腾讯会议的 wemeet:// 协议唤起客户端，再观察窗口变化确认结果。
// 系统权限越多，能拿到的结果越精确：
//   - 无权限：只能看到窗口尺寸 → 判断是否进入会中大窗口
//   - 辅助功能权限：读取窗口文字 → 识别错误弹窗、读取会议号
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { TaskFailure } from './errors.mjs';

const run = promisify(execFile);
const APP = '/Applications/TencentMeeting.app';
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 屏幕上腾讯会议的窗口（无需任何权限）
const WINDOWS_JXA = `
ObjC.import('CoreGraphics');
const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0))) || [];
JSON.stringify(all.filter(w => w.kCGWindowOwnerName === '腾讯会议' && w.kCGWindowLayer === 0)
  .map(w => ({ w: w.kCGWindowBounds.Width, h: w.kCGWindowBounds.Height, name: w.kCGWindowName || '' })));`;

async function windows() {
  const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', WINDOWS_JXA]);
  return JSON.parse(stdout);
}

// 读取腾讯会议窗口里的所有文字（需要辅助功能权限，没有则返回 null）
const TEXTS_JXA = `
const se = Application('System Events');
const p = se.processes.whose({ bundleIdentifier: 'com.tencent.meeting' })[0];
const out = [];
function walk(el, depth) {
  if (depth > 12 || out.length > 800) return;
  let kids = [];
  try { kids = el.uiElements(); } catch (e) { return; }
  for (const k of kids) {
    for (const prop of ['name', 'value', 'description', 'title']) {
      try { const v = k[prop](); if (typeof v === 'string' && v.trim()) out.push(v.trim()); } catch (e) {}
    }
    walk(k, depth + 1);
  }
}
for (const w of p.windows()) { try { out.push('#' + w.name()); } catch (e) {} walk(w, 0); }
JSON.stringify(out);`;

async function windowTexts() {
  try {
    const { stdout } = await run('osascript', ['-l', 'JavaScript', '-e', TEXTS_JXA], { timeout: 8000 });
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

const isMeetingWindow = w => w.w >= 900 || w.h >= 620; // 首页约 720×480，会中窗口明显更大
const FAIL_TEXTS = ['会议不存在', '会议号不存在', '无效的会议号', '会议已结束', '会议已过期', '加入会议失败', '无法加入', '网络连接失败'];

async function ensureApp(step) {
  step('check', 'running');
  if (!existsSync(APP)) throw new TaskFailure('APP_NOT_INSTALLED', '电脑上没有找到腾讯会议客户端。');
  const before = await windows();
  if (before.some(isMeetingWindow)) {
    throw new TaskFailure('ALREADY_IN_MEETING', '电脑上已经在一个会议中了，为避免打断当前会议，本次没有执行。');
  }
  step('check', 'done', '腾讯会议已安装');
  return before;
}

async function waitForMeeting(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let texts = null;
  while (Date.now() < deadline) {
    await sleep(1000);
    const wins = await windows();
    texts = await windowTexts();
    const failure = texts && FAIL_TEXTS.find(f => texts.some(t => t.includes(f)));
    if (failure) return { ok: false, reason: failure };
    if (texts && texts.some(t => /密码/.test(t)) && !wins.some(isMeetingWindow)) return { ok: false, reason: '该会议需要密码，请在电脑上输入' };
    if (texts && texts.some(t => /等候室|等待主持人/.test(t))) return { ok: true, waitingRoom: true, texts };
    if (wins.some(isMeetingWindow)) return { ok: true, texts };
  }
  return { ok: false, timeout: true, texts };
}

function findMeetingCode(texts) {
  for (const t of texts || []) {
    const m = t.match(/(?<!\d)(\d{3}[\s-]?\d{3}[\s-]?\d{3})(?!\d)/);
    if (m) return m[1].replace(/[\s-]/g, '');
  }
  return null;
}

export async function joinMeeting(task, { step }) {
  const code = task.intent.params.meetingCode;
  const pretty = code.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
  await ensureApp(step);

  step('launch', 'running');
  await run('open', [`wemeet://page/inmeeting?meeting_code=${code}`]);
  step('launch', 'done', `已唤起腾讯会议，正在加入 ${pretty}`);

  step('verify', 'running');
  const r = await waitForMeeting(25000);
  if (!r.ok) {
    if (r.reason) throw new TaskFailure('EXEC_ERROR', `腾讯会议提示：${r.reason}`);
    throw new TaskFailure('TIMEOUT', '25 秒内没有进入会议，可能是会议号无效、需要密码或未登录，请查看电脑屏幕。');
  }
  const note = r.waitingRoom ? '已进入等候室，等待主持人同意' : '已进入会议';
  step('verify', 'done', note);
  return { summary: `电脑${note}（会议号 ${pretty}）`, data: { meetingCode: code, waitingRoom: Boolean(r.waitingRoom) } };
}

// 首页「快速会议」按钮是自绘控件，读不到无障碍信息，按窗口内相对位置点击（适配 3.x 版首页 720×480 布局）。
// 点击前确认该位置最上层确实是腾讯会议窗口；被其他窗口挡住时用腾讯会议自带的「隐藏其它」腾出视野。
const CLICK_HOME_JXA = `
ObjC.import('CoreGraphics');
function run(argv) {
  const [rx, ry] = argv.map(Number);
  const se = Application('System Events');
  const p = se.processes.whose({ bundleIdentifier: 'com.tencent.meeting' })[0];
  const pid = p.unixId();
  const home = () => p.windows().find(w => { const s = w.size(); return w.name() === '腾讯会议' && s[0] >= 600 && s[0] <= 1000 && s[1] >= 400 && s[1] <= 700; });
  const activate = () => { try { home().actions.byName('AXRaise').perform(); } catch (e) {} p.frontmost = true; delay(0.6); };
  const topPidAt = (x, y) => {
    const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0))) || [];
    const hit = all.find(w => { const b = w.kCGWindowBounds; return w.kCGWindowLayer === 0 && w.kCGWindowAlpha > 0 && x >= b.X && x <= b.X + b.Width && y >= b.Y && y <= b.Y + b.Height; });
    return hit ? hit.kCGWindowOwnerPID : null;
  };
  activate();
  if (!home()) return 'NO_HOME';
  const target = () => { const [x, y] = home().position(); const [w, h] = home().size(); return [x + w * rx, y + h * ry]; };
  let [x, y] = target();
  if (topPidAt(x, y) !== pid) {
    try { p.menuBars[0].menuBarItems.byName('腾讯会议').menus[0].menuItems.byName('隐藏其它').click(); } catch (e) {}
    delay(0.6);
    activate();
    [x, y] = target();
    if (topPidAt(x, y) !== pid) return 'COVERED';
  }
  const pt = $.CGPointMake(x, y);
  for (const type of [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {
    $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, type, pt, $.kCGMouseButtonLeft));
    delay(0.05);
  }
  return 'CLICKED';
}`;

async function clickHome(rx, ry) {
  try {
    return (await run('osascript', ['-l', 'JavaScript', '-e', CLICK_HOME_JXA, String(rx), String(ry)], { timeout: 10000 })).stdout.trim();
  } catch (e) {
    if (/不允许辅助访问|assistive access|-25211/i.test(String(e.stderr || e.message))) {
      throw new TaskFailure('EXEC_ERROR', '电脑缺少「辅助功能」权限，无法自动点击，请在系统设置中为终端开启。');
    }
    throw e;
  }
}

export async function createMeeting(task, { step }) {
  await ensureApp(step);

  step('launch', 'running');
  await run('open', ['-a', APP]);
  await sleep(800);
  const clicked = await clickHome(0.347, 0.33);
  if (clicked === 'COVERED') throw new TaskFailure('EXEC_ERROR', '腾讯会议窗口被其他窗口挡住了，请在电脑上把它切到前台后重试。');
  if (clicked !== 'CLICKED') throw new TaskFailure('NOT_LOGGED_IN', '没有找到腾讯会议首页，请确认已登录并停留在首页。');
  step('launch', 'done', '已点击「快速会议」');

  step('verify', 'running');
  const r = await waitForMeeting(25000);
  if (!r.ok) {
    if (r.reason) throw new TaskFailure('EXEC_ERROR', `腾讯会议提示：${r.reason}`);
    throw new TaskFailure('NOT_LOGGED_IN', '没有成功创建会议，请确认电脑上的腾讯会议已登录。');
  }
  // 会中界面刚出现时文字可能还没渲染完，多读几次
  let code = findMeetingCode(r.texts);
  for (let i = 0; !code && i < 5; i++) {
    await sleep(1000);
    code = findMeetingCode(await windowTexts());
  }
  step('verify', 'done', code ? `会议号：${code}` : '会议已创建，会议号请在电脑上查看');
  const pretty = code?.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
  return {
    summary: code ? `会议已创建，会议号 ${pretty}，可转发给参会人` : '会议已创建并进入会中',
    data: { meetingCode: code },
  };
}

// 离开 / 结束会议：点会中窗口的关闭按钮（无障碍可用），在弹出的自绘小窗里按位置点击。
// 主持人弹窗（高约 174）三个按钮：全员结束会议 / 离开会议 / 取消；参会者弹窗只有：离开会议 / 取消。
// 按钮间距 49pt，第一个按钮中心距弹窗顶部约 37pt。
const LEAVE_JXA = `
ObjC.import('CoreGraphics');
function run(argv) {
  const want = argv[0];
  const se = Application('System Events');
  const p = se.processes.whose({ bundleIdentifier: 'com.tencent.meeting' })[0];
  const meetingWin = () => p.windows().find(w => { const s = w.size(); return s[0] >= 900 || s[1] >= 620; });
  const mw = meetingWin();
  if (!mw) return 'NOT_IN_MEETING';
  p.frontmost = true;
  try { mw.actions.byName('AXRaise').perform(); } catch (e) {}
  delay(0.4);
  const findDialog = () => p.windows().find(w => { const s = w.size(); return s[0] >= 150 && s[0] <= 300 && s[1] >= 80 && s[1] <= 240; });
  // 弹窗可能已经开着（再点关闭按钮会把它收起），所以先找，没有再点
  let dlg = findDialog();
  if (!dlg) mw.buttons().find(b => { try { return b.description() === '关闭按钮'; } catch (e) { return false; } }).click();
  for (let i = 0; i < 10 && !dlg; i++) {
    delay(0.2);
    dlg = findDialog();
  }
  if (!dlg) return 'NO_DIALOG';
  const [x, y] = dlg.position(); const [w, h] = dlg.size();
  const isHost = h >= 150;
  let offset, did;
  if (want === 'end' && isHost) { offset = 37; did = 'END'; }
  else { offset = isHost ? 86 : 37; did = isHost ? 'LEAVE' : 'LEAVE_GUEST'; }
  const pt = $.CGPointMake(x + w / 2, y + offset);
  for (const type of [$.kCGEventLeftMouseDown, $.kCGEventLeftMouseUp]) {
    $.CGEventPost($.kCGHIDEventTap, $.CGEventCreateMouseEvent(null, type, pt, $.kCGMouseButtonLeft));
    delay(0.05);
  }
  return did;
}`;

export async function inMeeting() {
  return (await windows()).some(isMeetingWindow);
}

async function exitMeeting(task, { step }, want) {
  step('check', 'running');
  if (!(await inMeeting())) throw new TaskFailure('NOTHING_TO_CLOSE', '电脑当前不在会议中。');
  step('check', 'done', '电脑正在会议中');

  step('act', 'running');
  let did;
  try {
    did = (await run('osascript', ['-l', 'JavaScript', '-e', LEAVE_JXA, want], { timeout: 10000 })).stdout.trim();
  } catch (e) {
    if (/不允许辅助访问|assistive access|-25211/i.test(String(e.stderr || e.message))) {
      throw new TaskFailure('EXEC_ERROR', '电脑缺少「辅助功能」权限，无法自动操作，请在系统设置中为终端开启。');
    }
    throw e;
  }
  if (did === 'NOT_IN_MEETING') throw new TaskFailure('NOTHING_TO_CLOSE', '电脑当前不在会议中。');
  if (did === 'NO_DIALOG') throw new TaskFailure('EXEC_ERROR', '没有弹出离会确认框，请在电脑上手动离开会议。');
  const label = { END: '已点击「全员结束会议」', LEAVE: '已点击「离开会议」', LEAVE_GUEST: '已点击「离开会议」' }[did];
  step('act', 'done', label);

  step('verify', 'running');
  for (let i = 0; i < 16; i++) {
    await sleep(500);
    if (!(await inMeeting())) {
      step('verify', 'done', '会议窗口已关闭');
      const summary = did === 'END' ? '会议已结束，所有人都已离开' : want === 'end' ? '你不是主持人，无法结束会议，已帮你离开会议' : '电脑已离开会议';
      return { summary, data: {} };
    }
  }
  throw new TaskFailure('TIMEOUT', '已点击离开，但会议窗口仍在，可能需要指定新主持人，请在电脑上确认。');
}

export const leaveMeeting = (task, ctx) => exitMeeting(task, ctx, 'leave');
export const endMeeting = (task, ctx) => exitMeeting(task, ctx, 'end');
