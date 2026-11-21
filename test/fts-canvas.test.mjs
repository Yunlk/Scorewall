/* First to Solve 榜单测试 —— 对照 FirstToSolvePresentation
 *
 * 关键行为：
 *   - 首杀的 target 行 = fts.indexOf(problemId)，按上榜顺序排
 *   - 新记录起点 = max(上一行+1, teamsPerScreen+2) = 屏幕下方
 *   - 非首杀停留 TIME_TO_KEEP_SOLVED=8000 后滑到 teamsPerScreen*2 并移除
 *   - 同一道题只上榜一次
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { FtsQueue, TIME_TO_KEEP_SOLVED, TEAMS_PER_SCREEN, ROW_MOVEMENT, getTime } from '../src/fts-canvas.js';

const sub = (id, prob, sec = 600) => ({
  id, problem_id: prob, team_id: 't' + id,
  contest_time: `0:${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}.000`,
});

function makeQueue() {
  const judged = new Set();
  const fts = new Set();
  const q = new FtsQueue({ judged: s => judged.has(s.id), isFts: s => fts.has(s.id) });
  return { q, judged, fts };
}

function advance(q, ms, step = 50) {
  let t = 0;
  while (t < ms) { const dt = Math.min(step, ms - t); q.update(dt); t += dt; }
}

test('ROW_MOVEMENT 是 (4,7)，和判题队列的 (5,9) 不同', () => {
  assert.equal(ROW_MOVEMENT.acceleration, 4);
  assert.equal(ROW_MOVEMENT.maxSpeed, 7);
});

test('新记录从屏幕下方进场', () => {
  const { q } = makeQueue();
  const sr = q.handle(sub('s1', 'A'));
  assert.equal(sr.anim.getValue(), TEAMS_PER_SCREEN + 2);
  assert.equal(sr.age, 0);
});

test('同一题只上榜一次', () => {
  const { q } = makeQueue();
  assert.equal(q.handleFts('A', true, true), true);
  assert.equal(q.handleFts('A', true, true), false, '第二次应被拒');
  assert.deepEqual(q.fts, ['A']);
  assert.equal(q.has('A'), true);
});

test('未判或非首杀不上榜', () => {
  const { q } = makeQueue();
  assert.equal(q.handleFts('A', false, true), false, '非首杀');
  assert.equal(q.handleFts('A', true, false), false, '未判');
  assert.deepEqual(q.fts, []);
});

test('首杀按上榜顺序摆行（不是按题号）', () => {
  const { q, judged, fts } = makeQueue();

  // 故意倒序上榜：C 先、A 后
  for (const p of ['C', 'A', 'B']) {
    const s = sub('s' + p, p);
    q.handle(s);
    q.handleFts(p, true, true);
    judged.add(s.id);
    fts.add(s.id);
  }

  q.update(0, true);          // force → 直接摆位
  const order = q.records.map(r => r.submission.problem_id);
  assert.deepEqual(order, ['C', 'A', 'B']);
  assert.deepEqual(q.records.map(r => r.anim.getTarget()), [0, 1, 2]);
});

test('首杀行会一直停在 fts 索引位', () => {
  const { q, judged, fts } = makeQueue();
  const s = sub('s1', 'A');
  q.handle(s);
  q.handleFts('A', true, true);
  judged.add(s.id);
  fts.add(s.id);

  q.update(0, true);
  assert.equal(q.records[0].anim.getTarget(), 0);

  advance(q, 30000);
  assert.equal(q.records.length, 1, '首杀不能被移除');
  assert.ok(Math.abs(q.records[0].anim.getValue()) < 0.01);
});

test('非首杀的记录 8 秒后滑出并移除', () => {
  const { q, judged, fts } = makeQueue();
  const s = sub('s2', 'A');
  q.handle(s);
  judged.add(s.id);            // 已判
  // 不加入 fts → 不是首杀

  q.update(0, true);
  advance(q, TIME_TO_KEEP_SOLVED + 6000);
  assert.equal(q.records.length, 0, '应被移除');
});

test('非首杀在 8 秒内不会被移除', () => {
  const { q, judged } = makeQueue();
  const s = sub('s3', 'A');
  q.handle(s);
  judged.add(s.id);

  advance(q, TIME_TO_KEEP_SOLVED - 500);
  assert.equal(q.records.length, 1);
});

test('未判的记录不会被移除', () => {
  const { q } = makeQueue();
  q.handle(sub('s4', 'A'));
  advance(q, 30000);
  assert.equal(q.records.length, 1);
});

test('getTime：毫秒转整数分钟', () => {
  assert.equal(getTime(0), '0');
  assert.equal(getTime(59_999), '0');
  assert.equal(getTime(60_000), '1');
  assert.equal(getTime(605_000), '10');
});
