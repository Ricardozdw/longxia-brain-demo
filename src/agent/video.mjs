// 场景一：搜索电影并在电脑浏览器中播放相关视频（哔哩哔哩公开视频）。
import { chromium } from 'playwright-core';
import { join } from 'node:path';
import { getHotMovies } from './hot-movies.mjs';
import { TaskFailure } from './errors.mjs';

let context = null;
let closing = null; // 后台关闭中的浏览器，重新打开前要等它释放用户目录

// 默认最大化；录屏等场景可用 BROWSER_WINDOW=x,y,宽,高 指定播放窗口位置
function windowArgs() {
  const [x, y, w, h] = (process.env.BROWSER_WINDOW || '').split(',').map(Number);
  return w ? [`--window-position=${x},${y}`, `--window-size=${w},${h}`] : ['--start-maximized'];
}

async function getBrowser(profileDir) {
  if (context) return context;
  await closing;
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chrome', // 直接使用电脑上已安装的 Google Chrome
    headless: false,
    viewport: null,
    args: ['--autoplay-policy=no-user-gesture-required', '--no-first-run', ...windowArgs()],
  });
  context.on('close', () => (context = null));
  return context;
}

export async function runVideo(task, { step, runtimeDir }) {
  // 1. 确定电影
  step('pick', 'running');
  let movie = task.intent.params.movie;
  if (!movie) {
    const hot = await getHotMovies();
    movie = hot.list[0].title;
    const rate = hot.list[0].rate ? `，评分 ${hot.list[0].rate}` : '';
    step('pick', 'done', `从${hot.source}选中《${movie}》${rate}`, { movie, movieSource: hot.source });
  } else {
    step('pick', 'done', `按你的要求搜索《${movie}》`, { movie });
  }

  // 2. 打开浏览器
  step('browser', 'running');
  let page;
  try {
    const ctx = await getBrowser(join(runtimeDir, 'chrome-profile'));
    page = ctx.pages()[0] || (await ctx.newPage());
    await page.bringToFront();
  } catch (e) {
    throw new TaskFailure('EXEC_ERROR', '无法启动 Chrome 浏览器，请确认电脑已安装 Google Chrome。');
  }
  step('browser', 'done', '已打开 Chrome 浏览器');

  // 3. 搜索
  step('search', 'running');
  const keyword = `${movie} 预告片`;
  try {
    await page.goto(`https://search.bilibili.com/all?keyword=${encodeURIComponent(keyword)}`, { timeout: 20000, waitUntil: 'domcontentloaded' });
    await page.waitForSelector('a[href*="/video/BV"]', { state: 'attached', timeout: 15000 });
  } catch {
    throw new TaskFailure('NETWORK', '视频网站打开失败，请检查电脑网络。');
  }
  const candidate = await page.evaluate(() => {
    for (const a of document.querySelectorAll('a[href*="/video/BV"]')) {
      const title = (a.querySelector('h3')?.getAttribute('title') || a.querySelector('h3')?.textContent || a.title || '').trim();
      if (title.length > 3) return { url: a.href.split('?')[0], title };
    }
    return null;
  });
  if (!candidate) throw new TaskFailure('NO_VIDEO_FOUND', `没有搜到《${movie}》的相关视频。`);
  step('search', 'done', `在哔哩哔哩搜索「${keyword}」，选中：${candidate.title}`, { videoTitle: candidate.title, videoUrl: candidate.url });

  // 4. 打开并播放
  step('play', 'running');
  try {
    await page.goto(candidate.url, { timeout: 20000, waitUntil: 'domcontentloaded' });
    await page.waitForSelector('video', { state: 'attached', timeout: 15000 });
  } catch {
    throw new TaskFailure('NETWORK', '视频页面加载超时，请检查电脑网络。');
  }
  const startAt = await page.evaluate(async () => {
    const v = document.querySelector('video');
    try { await v.play(); } catch {}
    return v.currentTime;
  });
  step('play', 'done', '视频页已打开，开始播放');

  // 5. 校验：播放进度在增长才算成功，而不是“点了播放”就算
  step('verify', 'running');
  const shot = join(runtimeDir, 'shots', `${task.id}.png`);
  try {
    await page.waitForFunction(t => {
      const v = document.querySelector('video');
      return v && !v.paused && v.currentTime > t + 1;
    }, startAt, { timeout: 15000 });
  } catch {
    await page.screenshot({ path: shot }).catch(() => {});
    throw new TaskFailure('PLAYBACK_BLOCKED', '视频页已打开，但没有检测到播放，可能需要在电脑上手动点一下播放。', { screenshot: true });
  }
  // 切到网页全屏，观看体验更好（失败不影响结果）
  await page.evaluate(() => document.querySelector('.bpx-player-ctrl-web')?.click()).catch(() => {});
  await page.waitForTimeout(1500);
  await page.screenshot({ path: shot });
  step('verify', 'done', '已确认视频正在播放');
  return {
    summary: `电脑正在播放《${movie}》相关视频`,
    data: { screenshot: true, videoTitle: candidate.title, videoUrl: candidate.url, movie },
  };
}

export const isVideoOpen = () => Boolean(context);

// 控制正在播放的视频：暂停 / 继续 / 关闭（关闭即关掉龙虾脑打开的浏览器窗口）
export async function controlVideo(task, { step }) {
  const action = task.intent.params.action;
  step('check', 'running');
  const page = context?.pages()[0];
  if (!page) throw new TaskFailure('NOTHING_TO_CLOSE', '电脑上没有龙虾脑打开的视频。');
  const title = await page.title().catch(() => '');
  step('check', 'done', title ? `当前页面：${title.replace(/_哔哩哔哩.*$/, '')}` : '找到了播放窗口');

  step('act', 'running');
  if (action === 'close') {
    // 先关页面（窗口立刻消失），浏览器进程在后台退出，避免用户干等
    const ctx = context;
    context = null;
    await Promise.all(ctx.pages().map(p => p.close({ runBeforeUnload: false }).catch(() => {})));
    closing = ctx.close().catch(() => {});
    step('act', 'done', '已关闭播放窗口');
    return { summary: '已关闭电脑上的视频', data: {} };
  }
  const paused = await page.evaluate(a => {
    const v = document.querySelector('video');
    if (!v) return null;
    if (a === 'pause') v.pause();
    else v.play();
    return v.paused;
  }, action);
  if (paused === null) throw new TaskFailure('NOTHING_TO_CLOSE', '当前页面没有视频。');
  step('act', 'done', paused ? '视频已暂停' : '视频继续播放');
  return { summary: paused ? '视频已暂停' : '视频继续播放了', data: {} };
}
