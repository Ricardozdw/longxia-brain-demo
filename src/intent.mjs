// 意图解析：把一句自然语言变成结构化任务。
// 默认使用本地规则（零成本、可解释、稳定）；配置了大模型时优先用模型，失败自动回退到规则。

export const INTENTS = {
  video: '搜索电影并播放视频',
  meeting_join: '加入腾讯会议',
  meeting_create: '创建腾讯会议',
  video_control: '控制视频播放',
  meeting_leave: '退出腾讯会议',
  meeting_end: '结束腾讯会议',
  close_auto: '关闭当前任务',
};

// 每类任务在手机上展示的执行步骤（电脑端按 key 回传进度）
export const STEPS = {
  video: [
    { key: 'pick', label: '确定要看的电影' },
    { key: 'browser', label: '打开电脑浏览器' },
    { key: 'search', label: '搜索相关视频' },
    { key: 'play', label: '打开视频并播放' },
    { key: 'verify', label: '确认正在播放' },
  ],
  meeting_join: [
    { key: 'check', label: '检查腾讯会议' },
    { key: 'launch', label: '唤起腾讯会议并入会' },
    { key: 'verify', label: '确认入会结果' },
  ],
  meeting_create: [
    { key: 'check', label: '检查腾讯会议' },
    { key: 'launch', label: '发起快速会议' },
    { key: 'verify', label: '获取会议号' },
  ],
  video_control: [
    { key: 'check', label: '找到正在播放的视频' },
    { key: 'act', label: '执行操作' },
  ],
  meeting_leave: [
    { key: 'check', label: '确认电脑在会议中' },
    { key: 'act', label: '离开会议' },
    { key: 'verify', label: '确认已退出' },
  ],
  meeting_end: [
    { key: 'check', label: '确认电脑在会议中' },
    { key: 'act', label: '结束会议' },
    { key: 'verify', label: '确认已结束' },
  ],
  close_auto: [
    { key: 'check', label: '查看电脑上正在进行的事' },
    { key: 'act', label: '关闭' },
    { key: 'verify', label: '确认已关闭' },
  ],
};

// 统一的异常码：手机端展示文案、后台看板统计失败原因都基于它
export const ERRORS = {
  EMPTY_INPUT: { label: '输入为空', suggestion: '试试说「搜索一部热门电影并播放相关视频」' },
  UNSUPPORTED: { label: '暂不支持的指令', suggestion: '目前可以帮你：看电影视频、加入或创建腾讯会议' },
  MISSING_MEETING_CODE: { label: '缺少会议号', suggestion: '请补充 9 位会议号，例如「加入腾讯会议 123 456 789」' },
  INVALID_MEETING_CODE: { label: '会议号格式错误', suggestion: '请核对会议号后重新发送，例如「加入腾讯会议 123 456 789」' },
  DEVICE_OFFLINE: { label: '电脑离线', suggestion: '请确认电脑已开机并运行龙虾脑助手，然后点重试' },
  APP_NOT_INSTALLED: { label: '电脑未安装所需应用', suggestion: '请先在电脑上安装腾讯会议' },
  ALREADY_IN_MEETING: { label: '电脑正在会议中', suggestion: '请先在电脑上离开当前会议，再点重试' },
  NOTHING_TO_CLOSE: { label: '没有可操作的内容', suggestion: '电脑上目前没有正在播放的视频或进行中的会议' },
  NOT_LOGGED_IN: { label: '应用未登录', suggestion: '请先在电脑上登录腾讯会议，再点重试' },
  NO_VIDEO_FOUND: { label: '未找到相关视频', suggestion: '换一个电影名试试，例如「播放《哪吒之魔童闹海》预告片」' },
  PLAYBACK_BLOCKED: { label: '视频未能自动播放', suggestion: '视频页已打开，可在电脑上手动点击播放' },
  NETWORK: { label: '网络异常', suggestion: '请检查电脑网络后重试' },
  TIMEOUT: { label: '执行超时', suggestion: '电脑响应过慢，请查看电脑屏幕状态后重试' },
  EXEC_ERROR: { label: '执行出错', suggestion: '请重试；如果反复出现，请查看电脑端日志' },
};

export class IntentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const GENERIC_MOVIE = /^(一部|一个|个|部)?(最近|当下|现在|最新|正在)?(热门|热映|好看|火|流行|高分)?(的)?(电影|影片|片子)?$/;

function extractMeetingDigits(text) {
  // 允许「123 456 789」「123-456-789」等分组写法
  const runs = text.match(/\d[\d\s-]*\d|\d/g) || [];
  const codes = runs.map(r => r.replace(/[\s-]/g, '')).filter(Boolean);
  return codes.sort((a, b) => b.length - a.length)[0] || null;
}

function extractMovieTitle(text) {
  const quoted = text.match(/[《「“"'](.+?)[》」”"']/);
  if (quoted) return quoted[1].trim();
  const residue = text
    .replace(/[，,。.!！?？]/g, ' ')
    .replace(/(请|帮我|帮忙|麻烦|给我|我想|我要|想要|能不能|可以)/g, '')
    .replace(/(在|去|用)?(B站|b站|哔哩哔哩|bilibili|腾讯视频|浏览器|电脑)(上|里)?/gi, '')
    .replace(/(搜索|搜一下|搜一搜|搜|查找|找一下|找|打开|播放|放一下|放|看看|看一下|看)/g, ' ')
    .replace(/(并且|并|然后|再|和)/g, ' ')
    .replace(/(相关的?视频|的?预告片?|的?解说|的?片段|的?花絮|视频)/g, ' ')
    .split(/\s+/)
    .map(s => s.replace(/^(一部|一个|个|部)/, '').replace(/的$/, '').trim())
    .filter(Boolean);
  const candidate = residue.find(s => !GENERIC_MOVIE.test(s));
  if (!candidate) return null;
  return candidate.replace(/(这部|那部)?(电影|影片)$/, '').trim() || null;
}

export function parseByRules(input) {
  const text = String(input ?? '').trim();
  if (!text) throw new IntentError('EMPTY_INPUT', '请先输入你想让电脑做的事。');
  if (text.length > 200) throw new IntentError('UNSUPPORTED', '指令太长了，请用一句话描述（200 字以内）。');

  // 控制类指令（关闭、退出、暂停…）优先判断，避免「退出会议」被当成「加入会议」
  const control = parseControl(text);
  if (control) return control;

  if (/会议|开(个|一个|一场|场)?会|入会|进会|wemeet|meeting/i.test(text)) {
    const wantsJoin = /加入|参加|进入|进到|进|入会|接入/.test(text);
    const wantsCreate = /创建|新建|发起|开(一个|个|一场|场)?会|开(一个|个|一场)?腾讯会议|建(一个|个)?|快速会议|预约/.test(text);
    const digits = extractMeetingDigits(text);
    if (wantsCreate && !wantsJoin && !digits) {
      return { type: 'meeting_create', params: {}, summary: '在电脑上创建一个腾讯会议，并把会议号发回手机' };
    }
    if (!digits) throw new IntentError('MISSING_MEETING_CODE', '要加入哪个会议呢？请告诉我会议号。');
    if (!/^\d{9}$/.test(digits)) {
      throw new IntentError('INVALID_MEETING_CODE', `会议号「${digits}」是 ${digits.length} 位，腾讯会议号应为 9 位数字。`);
    }
    const pretty = digits.replace(/(\d{3})(\d{3})(\d{3})/, '$1 $2 $3');
    return { type: 'meeting_join', params: { meetingCode: digits }, summary: `在电脑上加入腾讯会议 ${pretty}` };
  }

  if (/电影|影片|预告|视频|播放|放一|看/.test(text)) {
    const title = extractMovieTitle(text);
    return {
      type: 'video',
      params: { movie: title, pickHot: !title },
      summary: title ? `搜索《${title}》并播放相关视频` : '挑选一部当前热门电影，并播放相关视频',
    };
  }

  throw new IntentError('UNSUPPORTED', '这件事我暂时还不会做。');
}

function parseControl(text) {
  const aboutMeeting = /会议|会$|开会|入会/.test(text);
  const aboutVideo = /视频|播放|电影|预告|浏览器|片子/.test(text);
  if (aboutMeeting && /结束|解散/.test(text)) {
    return { type: 'meeting_end', params: {}, summary: '结束电脑上正在进行的腾讯会议（全员结束）' };
  }
  if (aboutMeeting && /退出|离开|挂断|挂了|关闭|关掉|关了|不开了/.test(text)) {
    return { type: 'meeting_leave', params: {}, summary: '让电脑离开当前腾讯会议' };
  }
  if (/暂停/.test(text)) return { type: 'video_control', params: { action: 'pause' }, summary: '暂停电脑上正在播放的视频' };
  if (/继续播放|继续放|接着放|接着播|恢复播放/.test(text)) {
    return { type: 'video_control', params: { action: 'resume' }, summary: '继续播放电脑上的视频' };
  }
  const closeWord = /关闭|关掉|关了|退出|停止|停掉|别放了|不看了|不放了|结束/.test(text);
  if (closeWord && aboutVideo) return { type: 'video_control', params: { action: 'close' }, summary: '关闭电脑上正在播放的视频' };
  // 只说「关闭 / 退出」：由电脑端判断当前在做什么再关闭
  if (closeWord && text.replace(/[，,。.!！\s]|请|帮我|把|都|全部|一下|吧|它|掉/g, '').length <= 4) {
    return { type: 'close_auto', params: {}, summary: '关闭电脑上正在进行的视频或会议' };
  }
  return null;
}

// 可选：兼容 OpenAI Chat Completions 协议的大模型（DeepSeek / 通义 / Kimi 等均可）
async function parseByLLM(text) {
  const { LLM_API_URL: url, LLM_API_KEY: key, LLM_MODEL: model } = process.env;
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            '你是任务解析器，只输出一个 JSON 对象，不要输出其他内容。可选结构：' +
            '{"type":"video","movie":"电影名，没指定则为null"}；' +
            '{"type":"meeting_join","meetingCode":"用户给出的会议号数字，原样保留"}；' +
            '{"type":"meeting_create"}；' +
            '{"type":"control"}（关闭/退出/暂停/继续播放/离开或结束会议等控制类指令）；' +
            '{"type":"unsupported"}。',
        },
        { role: 'user', content: text },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}`);
  const data = await res.json();
  const obj = JSON.parse(data.choices[0].message.content.replace(/^```(json)?|```$/g, '').trim());
  // 模型结果只作为「理解」，最终仍走规则校验，避免模型幻觉直接驱动电脑
  if (obj.type === 'video') return parseByRules(obj.movie ? `播放《${obj.movie}》相关视频` : '搜索一部热门电影并播放相关视频');
  if (obj.type === 'meeting_join') return parseByRules(`加入腾讯会议 ${obj.meetingCode ?? ''}`);
  if (obj.type === 'meeting_create') return parseByRules('创建一个腾讯会议');
  if (obj.type === 'control') return parseByRules(text);
  throw new IntentError('UNSUPPORTED', '这件事我暂时还不会做。');
}

export const llmEnabled = () => Boolean(process.env.LLM_API_URL && process.env.LLM_API_KEY && process.env.LLM_MODEL);

export async function parseIntent(text) {
  if (llmEnabled()) {
    try {
      return { ...(await parseByLLM(text)), parser: 'llm' };
    } catch (e) {
      if (e instanceof IntentError) throw e;
      // 模型不可用时静默回退，不影响用户
    }
  }
  return { ...parseByRules(text), parser: 'rules' };
}
