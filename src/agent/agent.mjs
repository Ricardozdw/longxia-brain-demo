// 电脑端助手：保持心跳、领取任务、执行并逐步回传进度。
// 真实产品里它是安装在用户电脑上的常驻客户端，这里与服务端跑在同一台 Mac 上。
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runVideo, controlVideo, isVideoOpen } from './video.mjs';
import { joinMeeting, createMeeting, leaveMeeting, endMeeting, inMeeting } from './meeting.mjs';
import { TaskFailure } from './errors.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const RUNTIME = join(ROOT, '.runtime');
const SERVER = process.env.SERVER_URL || `http://127.0.0.1:${process.env.PORT || 4320}`;
mkdirSync(join(RUNTIME, 'shots'), { recursive: true });

// 只说「关闭 / 退出」时，看电脑上正在进行什么：先离开会议，再关闭视频
async function closeAuto(task, ctx) {
  const { step } = ctx;
  step('check', 'running');
  const meeting = await inMeeting();
  const video = isVideoOpen();
  if (!meeting && !video) throw new TaskFailure('NOTHING_TO_CLOSE', '电脑上目前没有正在播放的视频或进行中的会议。');
  step('check', 'done', [meeting && '会议进行中', video && '视频在播放'].filter(Boolean).join('，'));
  const done = [];
  const quiet = () => {}; // 子步骤合并到本任务的步骤里展示
  step('act', 'running');
  if (meeting) {
    await leaveMeeting(task, { step: quiet });
    done.push('离开了会议');
  }
  if (video) {
    await controlVideo({ ...task, intent: { params: { action: 'close' } } }, { step: quiet });
    done.push('关闭了视频');
  }
  step('act', 'done', done.join('，'));
  step('verify', 'done', '电脑上已没有进行中的视频或会议');
  return { summary: `已${done.join('，')}`, data: {} };
}

const RUNNERS = {
  video: runVideo,
  meeting_join: joinMeeting,
  meeting_create: createMeeting,
  video_control: controlVideo,
  meeting_leave: leaveMeeting,
  meeting_end: endMeeting,
  close_auto: closeAuto,
};
let busy = false;

function token() {
  return readFileSync(join(RUNTIME, 'token'), 'utf8').trim();
}

async function call(path, body) {
  const res = await fetch(SERVER + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Token': token() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`${path} → HTTP ${res.status}`);
  return res.json();
}

async function heartbeat() {
  try {
    await call('/agent/heartbeat', {
      name: `${hostname().replace(/\.local$/, '')}（macOS）`,
      busy,
      apps: {
        chrome: existsSync('/Applications/Google Chrome.app'),
        tencentMeeting: existsSync('/Applications/TencentMeeting.app'),
      },
    });
  } catch {
    // 服务端未启动时静默重试
  }
}

async function execute(task) {
  busy = true;
  heartbeat();
  console.log(`▶ 执行任务：${task.text}`);
  const send = ev => call(`/agent/tasks/${task.id}/events`, ev).catch(() => {});
  const step = (key, state, message, data) => {
    console.log(`  [${key}] ${state}${message ? ' · ' + message : ''}`);
    send({ kind: 'step', key, state, message, data });
  };
  try {
    const r = await RUNNERS[task.intent.type](task, { step, runtimeDir: RUNTIME });
    await send({ kind: 'result', ok: true, summary: r.summary, data: r.data });
    console.log(`✔ ${r.summary}`);
  } catch (e) {
    const known = e instanceof TaskFailure;
    if (!known) console.error(e);
    await send({ kind: 'result', ok: false, errorCode: known ? e.code : 'EXEC_ERROR', message: known ? e.message : '执行过程中出现意外错误。', data: e.data });
    console.log(`✖ ${e.message}`);
  } finally {
    busy = false;
    heartbeat();
  }
}

async function loop() {
  for (;;) {
    try {
      const { task } = await call('/agent/next');
      if (task) await execute(task);
    } catch {
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

console.log(`🖥  电脑端助手已启动，连接 ${SERVER}`);
heartbeat();
setInterval(() => {
  // 由一键启动拉起时，启动器意外退出（被强杀、终端关闭）后自动退出，避免残留
  if (process.env.LONGXIA_LAUNCHED && process.ppid === 1) process.exit(0);
  heartbeat();
}, 4000);
loop();
