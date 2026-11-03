import test from 'node:test';
import assert from 'node:assert/strict';
import { parseByRules, IntentError } from '../src/intent.mjs';

const codeOf = fn => {
  try { fn(); } catch (e) { assert.ok(e instanceof IntentError); return e.code; }
  assert.fail('应当抛出 IntentError');
};

test('场景一：泛指热门电影时自动挑片', () => {
  const r = parseByRules('搜索一部热门电影并播放相关视频');
  assert.equal(r.type, 'video');
  assert.equal(r.params.pickHot, true);
  assert.equal(r.params.movie, null);
});

test('场景一：指定片名时保留片名', () => {
  assert.equal(parseByRules('播放《流浪地球2》的预告片').params.movie, '流浪地球2');
  assert.equal(parseByRules('帮我在B站搜一下哪吒之魔童闹海的解说视频').params.movie, '哪吒之魔童闹海');
  assert.equal(parseByRules('我想看个电影').params.pickHot, true);
});

test('场景二：加入会议需要 9 位会议号', () => {
  const r = parseByRules('加入腾讯会议，会议号 123 456 789');
  assert.equal(r.type, 'meeting_join');
  assert.equal(r.params.meetingCode, '123456789');
  assert.equal(parseByRules('进会 123-456-789').params.meetingCode, '123456789');
  assert.equal(codeOf(() => parseByRules('加入腾讯会议，会议码1234')), 'INVALID_MEETING_CODE');
  assert.equal(codeOf(() => parseByRules('帮我加入腾讯会议')), 'MISSING_MEETING_CODE');
});

test('场景二：创建会议', () => {
  assert.equal(parseByRules('创建一个腾讯会议').type, 'meeting_create');
  assert.equal(parseByRules('帮我开个会').type, 'meeting_create');
});

test('边界：空输入与不支持的指令', () => {
  assert.equal(codeOf(() => parseByRules('  ')), 'EMPTY_INPUT');
  assert.equal(codeOf(() => parseByRules('帮我订一张去上海的机票')), 'UNSUPPORTED');
});

test('控制：关闭、退出、暂停', () => {
  assert.equal(parseByRules('退出会议').type, 'meeting_leave');
  assert.equal(parseByRules('离开腾讯会议').type, 'meeting_leave');
  assert.equal(parseByRules('结束会议').type, 'meeting_end');
  assert.equal(parseByRules('关闭视频').params.action, 'close');
  assert.equal(parseByRules('别放了，关掉电影').params.action, 'close');
  assert.equal(parseByRules('暂停').params.action, 'pause');
  assert.equal(parseByRules('继续播放').params.action, 'resume');
  assert.equal(parseByRules('关闭').type, 'close_auto');
  assert.equal(parseByRules('退出').type, 'close_auto');
  assert.equal(parseByRules('帮我都关了吧').type, 'close_auto');
  // 不误伤正常指令
  assert.equal(parseByRules('加入腾讯会议 123456789').type, 'meeting_join');
  assert.equal(parseByRules('创建一个腾讯会议').type, 'meeting_create');
});
