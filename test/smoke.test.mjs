import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeStandings, rel2sec, fmtClock, resolveUrl } from '../src/scoring.js';
import { makeState, freezeAtSec, isJudgementHidden } from '../src/state.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = n => JSON.parse(readFileSync(join(here, 'fixtures/smoke', n + '.json'), 'utf8'));
const toMap = arr => new Map(arr.map(x => [x.id, x]));

function model() {
  return {
    contest: load('contest'),
    teams: toMap(load('teams')),
    problems: toMap(load('problems')),
    submissions: toMap(load('submissions')),
    judgements: toMap(load('judgements')),
    judgementTypes: toMap(load('judgement-types')),
  };
}

test('RelativeTime 解析', () => {
  assert.equal(rel2sec('0:01:00.000'), 60);
  assert.equal(rel2sec('1:02:03.500'), 3723);
});

test('时钟格式（负值只在 h===0 时加负号）', () => {
  assert.equal(fmtClock(-57000), '-0:00:57');
  assert.equal(fmtClock(-3700000), '1:01:40');   // h>0 不加负号（源码如此）
  assert.equal(fmtClock(57000), '0:00:57');
});

test('URL 解析对齐 getResolvedURL', () => {
  const base = 'http://h:8081/api/contests/1';
  assert.equal(resolveUrl(base, '/presentation/a.png'), 'http://h:8081/presentation/a.png');
  assert.equal(resolveUrl(base, 'presentation/a.png'), 'http://h:8081/api/contests/1/presentation/a.png');
  assert.equal(resolveUrl(base, 'https://x/y.png'), 'https://x/y.png');
});

test('排名与罚时（含 CE 不计罚时、pending 不影响）', () => {
  const { rows } = computeStandings(model());
  const byName = Object.fromEntries(rows.map(r => [r.team.name, r]));

  assert.equal(byName.Alpha.solved, 1);
  assert.equal(byName.Alpha.penalty, 60);

  assert.equal(byName.Beta.solved, 1);
  assert.equal(byName.Beta.penalty, 300 + 2 * 1200, '两次 WA 各罚 20 分钟');

  assert.equal(byName.Gamma.solved, 1);
  assert.equal(byName.Gamma.penalty, 120, 'CE 不计罚时');

  // pending 的那题不算通过
  assert.equal(byName.Gamma.cells[1].solvedAt, null);
  assert.equal(byName.Gamma.cells[1].pending, true);

  // 排名：Alpha(60) < Gamma(120) < Beta(2700)
  assert.deepEqual(rows.map(r => r.team.name), ['Alpha', 'Gamma', 'Beta']);
  assert.deepEqual(rows.map(r => r.rank), [1, 2, 3]);
});

test('已通过后再次提交被忽略', () => {
  const m = model();
  m.submissions.set('s9', { id: 's9', team_id: 't1', problem_id: 'A', contest_time: '0:30:00.000' });
  m.judgements.set('j9', { id: 'j9', submission_id: 's9', judgement_type_id: 'WA' });
  const rows = computeStandings(m).rows;
  const alpha = rows.find(r => r.team.name === 'Alpha');
  assert.equal(alpha.solved, 1);
  assert.equal(alpha.penalty, 60, '通过后的失败不计罚时');
});


test('state 判据（源码：字段有无，不是布尔）', () => {
  const running = makeState({ started: '2026-01-01T00:00:00.000Z' });
  assert.equal(running.isRunning(), true);
  assert.equal(running.isFrozen(), false);

  const frozen = makeState({ started: '2026-01-01T00:00:00.000Z', frozen: '2026-01-01T04:00:00.000Z' });
  assert.equal(frozen.isRunning(), true);
  assert.equal(frozen.isFrozen(), true);

  const ended = makeState({ started: '2026-01-01T00:00:00.000Z', ended: '2026-01-01T05:00:00.000Z' });
  assert.equal(ended.isRunning(), false);

  const thawed = makeState({ frozen: '2026-01-01T04:00:00.000Z', thawed: '2026-01-01T05:00:00.000Z' });
  assert.equal(thawed.isFrozen(), false);
});

test('FreezeFilter：封榜后提交的判题被隐藏', () => {
  const st = makeState({ started: '2026-01-01T00:00:00.000Z', frozen: '2026-01-01T04:00:00.000Z' });
  const at = freezeAtSec(5 * 3600 * 1000, 3600 * 1000);   // 5h 比赛，封榜 1h → 4h 处
  assert.equal(at, 4 * 3600);
  assert.equal(isJudgementHidden(st, 3 * 3600, at), false);   // 封榜前
  assert.equal(isJudgementHidden(st, 4 * 3600, at), true);    // 正好封榜（>=）
  assert.equal(isJudgementHidden(st, 5 * 3600, at), true);    // 封榜后

  // 没封榜就不隐藏
  const running = makeState({ started: '2026-01-01T00:00:00.000Z' });
  assert.equal(isJudgementHidden(running, 5 * 3600, at), false);
});

test('封榜时排名不把封榜后的 AC 算进去', () => {
  const m = model();
  // t1 在 4:30 又过一题，但封榜起点是 4h
  m.submissions.set('s10', { id: 's10', team_id: 't1', problem_id: 'C', contest_time: '4:30:00.000' });
  m.judgements.set('j10', { id: 'j10', submission_id: 's10', judgement_type_id: 'AC' });
  const st = makeState({ started: '2026-01-01T00:00:00.000Z', frozen: '2026-01-01T04:00:00.000Z' });
  const at = freezeAtSec(5 * 3600 * 1000, 3600 * 1000);

  const open = computeStandings(m).rows.find(r => r.team.name === 'Alpha');
  assert.equal(open.solved, 2, '未封榜时算 2 题');

  const frozen = computeStandings(m, {
    hideJudgement: sub => isJudgementHidden(st, rel2sec(sub.contest_time), at),
  }).rows.find(r => r.team.name === 'Alpha');
  assert.equal(frozen.solved, 1, '封榜后只算 1 题');
});
