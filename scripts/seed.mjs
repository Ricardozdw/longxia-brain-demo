// 生成过去 7 天的模拟历史任务（带 mock 标记），让运营看板在演示时有可读的数据。
// 后台可通过「包含模拟历史数据」开关排除它们；npm run seed -- --clear 可清除。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERRORS, STEPS } from '../src/intent.mjs';

const RUNTIME = join(dirname(dirname(fileURLToPath(import.meta.url))), '.runtime');
const FILE = join(RUNTIME, 'tasks.json');
mkdirSync(RUNTIME, { recursive: true });
let tasks = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : [];
tasks = tasks.filter(t => !t.mock);

if (!process.argv.includes('--clear')) {
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const TEMPLATES = [
    { w: 30, text: ['搜索一部热门电影并播放相关视频', '放个最近热门的电影预告', '我想看个电影'], type: 'video', summary: '挑选一部当前热门电影，并播放相关视频', ok: 0.9, fails: ['PLAYBACK_BLOCKED', 'NETWORK', 'NO_VIDEO_FOUND'], dur: [9, 18] },
    { w: 14, text: ['播放《哪吒之魔童闹海》的预告片', '帮我在B站搜流浪地球2的解说', '看看《封神》预告'], type: 'video', summary: '搜索指定电影并播放相关视频', ok: 0.88, fails: ['NO_VIDEO_FOUND', 'PLAYBACK_BLOCKED'], dur: [8, 15] },
    { w: 20, text: ['加入腾讯会议 834 562 109', '进会 615-220-937', '帮我入会，会议号 902117364'], type: 'meeting_join', summary: '在电脑上加入腾讯会议', ok: 0.85, fails: ['NOT_LOGGED_IN', 'TIMEOUT', 'EXEC_ERROR'], dur: [5, 11] },
    { w: 14, text: ['创建一个腾讯会议', '帮我开个会', '发起一个快速会议'], type: 'meeting_create', summary: '在电脑上创建一个腾讯会议', ok: 0.9, fails: ['NOT_LOGGED_IN', 'APP_NOT_INSTALLED'], dur: [6, 12] },
    { w: 8, text: ['加入腾讯会议，会议码1234', '加入会议 12345'], need: 'INVALID_MEETING_CODE' },
    { w: 5, text: ['帮我加入腾讯会议', '进一下会'], need: 'MISSING_MEETING_CODE' },
    { w: 7, text: ['帮我订一张去上海的机票', '把桌面上的文件发给老板', '打开微信给妈妈发消息'], need: 'UNSUPPORTED' },
    { w: 3, text: ['创建一个腾讯会议', '搜索一部热门电影并播放相关视频'], offline: true },
  ];
  const bag = TEMPLATES.flatMap(t => Array(t.w).fill(t));
  const err = code => ({ code, label: ERRORS[code].label, message: ERRORS[code].label, suggestion: ERRORS[code].suggestion });

  for (let day = 6; day >= 0; day--) {
    const count = 12 + Math.round((6 - day) * 2.2 + Math.random() * 6); // 逐日增长
    for (let i = 0; i < count; i++) {
      const tpl = pick(bag);
      const created = new Date();
      created.setDate(created.getDate() - day);
      created.setHours(9 + Math.floor(Math.random() * 13), Math.floor(Math.random() * 60), Math.floor(Math.random() * 60));
      if (created > new Date()) created.setTime(Date.now() - Math.random() * 3600_000);
      const t = { id: randomUUID(), mock: true, text: pick(tpl.text), source: 'mobile', createdAt: created.toISOString(), timeline: [], steps: [], result: {} };
      if (tpl.need) {
        Object.assign(t, { status: 'need_input', error: err(tpl.need), durationMs: 300 + Math.random() * 500 });
      } else if (tpl.offline) {
        Object.assign(t, { status: 'failed', intent: { type: 'video', summary: '' }, error: err('DEVICE_OFFLINE'), durationMs: 400 });
      } else {
        const ok = Math.random() < tpl.ok;
        const [a, b] = tpl.dur;
        t.intent = { type: tpl.type, summary: tpl.summary, parser: 'rules' };
        t.dispatchedAt = new Date(created.getTime() + 500).toISOString();
        t.steps = STEPS[tpl.type].map(s => ({ ...s, state: ok ? 'done' : 'pending' }));
        t.durationMs = Math.round((a + Math.random() * (b - a)) * 1000);
        t.status = ok ? 'success' : 'failed';
        if (ok) t.result = { summary: tpl.summary.replace('在电脑上', '电脑已') };
        else t.error = err(pick(tpl.fails));
      }
      t.updatedAt = t.finishedAt = new Date(created.getTime() + t.durationMs).toISOString();
      tasks.push(t);
    }
  }
  tasks.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

writeFileSync(FILE, JSON.stringify(tasks, null, 1));
console.log(process.argv.includes('--clear') ? '已清除模拟数据' : `已生成模拟数据，当前共 ${tasks.length} 条任务（请重启服务生效）`);
