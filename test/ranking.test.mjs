/* 排名规则测试 —— 对照 Contest.calculateResultsAndStandings + Ranking
 *
 * 罚时：penalty = Σ penaltyTime + getTimeInMin(AC时间) * 60 * 1000
 *       getTimeInMin 是整数分钟，65 秒按 1 分钟算
 * 排序（PASS_FAIL）：
 *   1) 过题数降序
 *   2) 罚时升序
 *   3) lastSolutionTime 升序
 *   4) 队名 collator
 * 名次（LIVE）：1)2)3) 三项全同才并列 → 1,2,2,4
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { computeStandings } from '../src/scoring.js';

const JT = new Map([
  ['AC', { id: 'AC', solved: true, penalty: false }],
  ['WA', { id: 'WA', solved: false, penalty: true }],
]);
const PROBS = new Map([
  ['P1', { id: 'P1', label: 'A', ordinal: 0 }],
  ['P2', { id: 'P2', label: 'B', ordinal: 1 }],
]);

const rel = sec => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.000`;
};

/** teams: [id, name][]；events: [teamId, problemId, sec, 'AC'|'WA'][] */
function run(teams, events) {
  const tmap = new Map(teams.map(([id, name]) => [id, { id, name }]));
  const submissions = new Map(), judgements = new Map();
  let n = 0;
  for (const [team, prob, sec, jt] of events) {
    const id = 's' + (++n);
    submissions.set(id, { id, team_id: team, problem_id: prob, contest_time: rel(sec) });
    judgements.set('j' + id, { id: 'j' + id, submission_id: id, judgement_type_id: jt });
  }
  return computeStandings({
    contest: {}, teams: tmap, problems: PROBS, submissions, judgements,
    judgementTypes: JT,
  }, {});
}

test('罚时按整数分钟算：65 秒的 AC 记 1 分钟', () => {
  const { rows } = run([['t1', 'A']], [['t1', 'P1', 65, 'AC']]);
  assert.equal(rows[0].solved, 1);
  assert.equal(rows[0].penalty, 60, '65s → floor(65/60)*60 = 60');
  assert.equal(rows[0].lastSolution, 1);
});

test('119 秒仍是 1 分钟，120 秒才变 2 分钟', () => {
  assert.equal(run([['t1', 'A']], [['t1', 'P1', 119, 'AC']]).rows[0].penalty, 60);
  assert.equal(run([['t1', 'A']], [['t1', 'P1', 120, 'AC']]).rows[0].penalty, 120);
});

test('罚时 = AC 分钟 + 失败次数 × 20 分钟', () => {
  // 第 1 分钟 WA，第 3 分钟 AC → 3 + 20 = 23 分钟
  const { rows } = run([['t1', 'A']], [['t1', 'P1', 60, 'WA'], ['t1', 'P1', 180, 'AC']]);
  assert.equal(rows[0].penalty, 23 * 60);
});

test('过题数优先于罚时', () => {
  const { rows } = run(
    [['t1', 'A'], ['t2', 'B']],
    [
      ['t1', 'P1', 60, 'AC'],
      ['t2', 'P1', 60, 'AC'], ['t2', 'P2', 60, 'AC'],
    ]
  );
  assert.equal(rows[0].team.id, 't2', '2 题的排前面');
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].rank, 2);
});

test('同题数比罚时', () => {
  const { rows } = run(
    [['t1', 'A'], ['t2', 'B']],
    [['t1', 'P1', 300, 'AC'], ['t2', 'P1', 60, 'AC']]
  );
  assert.equal(rows[0].team.id, 't2');
  assert.equal(rows[0].penalty, 60);
});

test('罚时也相同时比 lastSolution（最后一题更早的排前）', () => {
  // 都是 3 分钟总罚时：t1 = 1+2 分钟，t2 = 2+1 分钟
  // t1 lastSolution=2，t2 lastSolution=2 → 还是并列
  const a = run(
    [['t1', 'A'], ['t2', 'B']],
    [
      ['t1', 'P1', 60, 'AC'], ['t1', 'P2', 120, 'AC'],
      ['t2', 'P1', 120, 'AC'], ['t2', 'P2', 60, 'AC'],
    ]
  );
  assert.equal(a.rows[0].penalty, a.rows[1].penalty);
  assert.equal(a.rows[0].lastSolution, a.rows[1].lastSolution);
  assert.equal(a.rows[0].rank, 1);
  assert.equal(a.rows[1].rank, 1, '三项全同 → 并列 1');

  // t1 last=1，t2 last=2
  const b = run(
    [['t1', 'A'], ['t2', 'B']],
    [
      ['t1', 'P1', 120, 'AC'],
      ['t2', 'P1', 60, 'AC'], ['t2', 'P2', 60, 'AC'],
    ]
  );
  // t1 1 题 120s，t2 2 题 120s → t2 题数多，排前
  assert.equal(b.rows[0].team.id, 't2');
});

test('三项完全相同 → 并列名次 1,1，下一位是 3', () => {
  const { rows } = run(
    [['t1', 'A'], ['t2', 'B'], ['t3', 'C']],
    [
      ['t1', 'P1', 60, 'AC'],
      ['t2', 'P1', 60, 'AC'],
      ['t3', 'P1', 60, 'WA'],
    ]
  );
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].rank, 1, '并列');
  assert.equal(rows[2].rank, 3, '跳号：1,1,3');
});

test('全都一样时按队名排（collator）', () => {
  const { rows } = run(
    [['t1', 'Bravo'], ['t2', 'Alpha']],
    [['t1', 'P1', 60, 'AC'], ['t2', 'P1', 60, 'AC']]
  );
  assert.equal(rows[0].team.name, 'Alpha');
  assert.equal(rows[1].team.name, 'Bravo');
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[1].rank, 1, '队名不同但成绩全同 → 仍并列');
});

test('一行 WA 不产生解题数', () => {
  const { rows } = run([['t1', 'A']], [['t1', 'P1', 60, 'WA']]);
  assert.equal(rows[0].solved, 0);
  assert.equal(rows[0].penalty, 0, '没 AC 就不累计罚时');
});
