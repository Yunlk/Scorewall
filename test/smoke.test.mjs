import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { computeStandings, rel2sec, fmtClock, resolveUrl } from '../src/scoring.js';

const here = dirname(fileURLToPath(import.meta.url));
const load = n => JSON.parse(readFileSync(join(here, 'fixtures/contest', n + '.json'), 'utf8'));
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
