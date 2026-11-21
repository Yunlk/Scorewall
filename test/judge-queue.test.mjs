/* 判题队列状态机测试 —— 对照 JudgePresentation.java 的行为
 *
 * 覆盖：
 *   - 新记录从屏幕下方（teamsPerScreen+2）进场
 *   - 判题后进入 MOVE_UP / MOVE_DOWN
 *   - 停留时长到期后滑出并从列表移除
 *   - 满 12 行后新记录排在屏幕外
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  JudgeQueue, Animator, Movement, Action, TEAMS_PER_SCREEN,
  TIME_TO_KEEP_SOLVED, TIME_TO_KEEP_FAILED, TIME_TO_FADE_RECENT,
} from '../src/judge-queue.js';

function makeQueue() {
  const status = new Map();          // submission_id -> 'solved' | 'failed'
  const q = new JudgeQueue({
    judged: s => status.has(s.id),
    solved: s => status.get(s.id) === 'solved',
    frozen: () => false,
  });
  return { q, status };
}

const sub = (id, t = 0) => ({ id, contest_time: t, team_id: 't' + id, problem_id: 'p1' });

/** 推进若干毫秒，返回推进后的时间 */
function advance(q, ms, step = 50) {
  let t = 0;
  while (t < ms) {
    const dt = Math.min(step, ms - t);
    q.update(dt);
    t += dt;
  }
  return t;
}

test('Animator: 梯形曲线从 14 走到 0', () => {
  const a = new Animator(TEAMS_PER_SCREEN + 2, new Movement(5, 9));
  a.setTarget(0);
  assert.equal(a.getValue(), TEAMS_PER_SCREEN + 2);
  a.incrementTimeMs(1673 / 2);
  const mid = a.getValue();
  assert.ok(mid > 0 && mid < TEAMS_PER_SCREEN + 2, `中途应在区间内，实际 ${mid}`);
  a.incrementTimeMs(4000);
  assert.equal(a.getValue(), 0);
});

test('新记录从屏幕下方进场', () => {
  const { q } = makeQueue();
  const sr = q.add(sub('s1'));
  assert.equal(sr.anim.getValue(), TEAMS_PER_SCREEN + 2, '起点 = teamsPerScreen+2');
  advance(q, 4000);
  assert.ok(Math.abs(sr.anim.getValue()) < 0.01, `应滑到第 0 行，实际 ${sr.anim.getValue()}`);
});

test('判题后进入 MOVE_UP 并最终移除', () => {
  const { q, status } = makeQueue();
  const sr = q.add(sub('s1'));
  advance(q, 4000);
  assert.equal(sr.action, null);

  status.set('s1', 'solved');
  advance(q, 50);
  assert.equal(sr.action, Action.MOVE_UP);

  // AC 停留 11s 后开始滑出，滑出过程约 3.1s
  advance(q, TIME_TO_KEEP_SOLVED + 5000);
  assert.equal(q.records.length, 0, 'MOVE_UP 走完应被移除');
});

test('WA 进入 MOVE_DOWN 并淡出移除', () => {
  const { q, status } = makeQueue();
  const sr = q.add(sub('s1'));
  advance(q, 4000);

  status.set('s1', 'failed');
  advance(q, 50);
  assert.equal(sr.action, Action.MOVE_DOWN);

  advance(q, TIME_TO_KEEP_FAILED + 6000);
  assert.equal(q.records.length, 0, 'MOVE_DOWN 走完应被移除');
});

test('未判不会离开队列', () => {
  const { q } = makeQueue();
  q.add(sub('s1'));
  advance(q, 30000);
  assert.equal(q.records.length, 1);
  assert.equal(q.records[0].action, null);
});

test('满 12 行后新记录排到屏幕外', () => {
  const { q } = makeQueue();
  for (let i = 0; i < TEAMS_PER_SCREEN; i++) q.add(sub('a' + i));
  q.updateTargets(true);
  for (let i = 0; i < TEAMS_PER_SCREEN; i++) {
    assert.equal(q.records[i].anim.getTarget(), i, `第 ${i} 条应在第 ${i} 行`);
  }

  const extra = q.add(sub('b0'));
  assert.equal(extra.anim.getTarget(), TEAMS_PER_SCREEN, '第 13 条排在屏幕外');
});

test('MOVE_UP 让后面的行整体上移', () => {
  const { q, status } = makeQueue();
  for (let i = 0; i < 3; i++) q.add(sub('r' + i));
  q.updateTargets(true);
  assert.deepEqual(q.records.map(r => r.anim.getTarget()), [0, 1, 2]);

  status.set('r0', 'solved');
  advance(q, 50);
  // r0 进入 MOVE_UP 后仍占位；停留到期才让出位置
  advance(q, TIME_TO_KEEP_SOLVED + 100);
  assert.equal(q.records[1].anim.getTarget(), 0, 'r1 应上移到第 0 行');
  assert.equal(q.records[2].anim.getTarget(), 1, 'r2 应上移到第 1 行');
});

test('frozen 时不暴露判题结果，超时淡出', () => {
  const status = new Map();
  const q = new JudgeQueue({
    judged: s => status.has(s.id),
    solved: s => status.get(s.id) === 'solved',
    frozen: () => true,
  });
  const sr = q.add(sub('s1'));
  status.set('s1', 'solved');
  advance(q, 50);
  assert.equal(sr.action, null, '封榜时不应进入 MOVE_UP');

  advance(q, 14000 + 50);
  assert.equal(sr.action, Action.MOVE_OUT);
  advance(q, TIME_TO_FADE_RECENT + 100);
  assert.equal(q.records.length, 0);
});
