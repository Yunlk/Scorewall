/* 单题统计测试 —— 对照 ProblemSummaryPresentation / ProblemSummary
 *
 * 布局：题数 ≥12 → 4 行；≥9 → 3 行；≥4 → 2 行；否则 1 行
 *       每行 ceil((n+1)/rows) 个，最后多一个空格子
 * 统计：attempts = Σ numSubmissions；accepted = AC 队伍数
 *       rejected = Σ(SOLVED ? numJudged-1 : FAILED ? numJudged : 0)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  problemColor, problemLayout, problemStats, problemRepeat, FLY_IN, MARGIN,
  parseHex, makeColorFn,
} from '../src/problem-canvas.js';

test('题目颜色：支持 3/4/6/7 位十六进制', () => {
  assert.deepEqual(problemColor({ rgb: '#FF7109' }), [255, 113, 9]);
  assert.deepEqual(problemColor({ rgb: 'FF7109' }), [255, 113, 9]);
  assert.deepEqual(problemColor({ rgb: '#F00' }), [255, 0, 0]);
  assert.deepEqual(problemColor({ rgb: '#008100' }), [0, 129, 0]);
  assert.deepEqual(problemColor({ rgb: '#fff' }), [255, 255, 255]);
});

test('题目颜色：非法值回落黑色（源码 catch → Color.BLACK）', () => {
  assert.deepEqual(problemColor({ rgb: '#GGGGGG' }), [0, 0, 0]);
  assert.deepEqual(problemColor({ rgb: 'red' }), [0, 0, 0]);   // 长度 3 但非法
  assert.deepEqual(problemColor({ rgb: '' }), [0, 0, 0]);
  assert.deepEqual(problemColor({}), [0, 0, 0]);
  assert.deepEqual(problemColor(null), [0, 0, 0]);
});

test('行数按题数分档', () => {
  assert.equal(problemLayout(1920, 1080, 3).rows, 1);
  assert.equal(problemLayout(1920, 1080, 4).rows, 2);
  assert.equal(problemLayout(1920, 1080, 8).rows, 2);
  assert.equal(problemLayout(1920, 1080, 9).rows, 3);
  assert.equal(problemLayout(1920, 1080, 11).rows, 3);
  assert.equal(problemLayout(1920, 1080, 12).rows, 4);
  assert.equal(problemLayout(1920, 1080, 14).rows, 4);
});

test('格子数 = 题数 + 1（末尾多一个空格子）', () => {
  assert.equal(problemLayout(1920, 1080, 5).cells.length, 6);
  assert.equal(problemLayout(1920, 1080, 14).cells.length, 15);
  assert.equal(problemLayout(1920, 1080, 0).cells.length, 0);
});

test('14 题 = 4 行 4 列，且不溢出画面', () => {
  const L = problemLayout(1920, 1080, 14);
  assert.equal(L.numPerRow, 4);
  assert.equal(L.cells.length, 15);

  for (const c of L.cells) {
    assert.ok(c.x >= MARGIN - 0.01, `x=${c.x} 越界`);
    assert.ok(c.y >= MARGIN - 0.01, `y=${c.y} 越界`);
    assert.ok(c.x + c.w <= 1920 - MARGIN + 0.01, `右边越界：${c.x + c.w}`);
    assert.ok(c.y + c.h <= 1080 - MARGIN + 0.01, `下边越界：${c.y + c.h}`);
  }

  // 第 0 格与第 1 格之间应该正好隔一个 GAP
  const gap = Math.trunc(1080 / 50);
  assert.equal(L.cells[1].x - (L.cells[0].x + L.cells[0].w), gap);
});

test('统计汇总：attempts / accepted / rejected / fts', () => {
  const list = [
    { subs: 3, attempts: 2, solvedAt: 10, isFTS: true },   // AC，之前 2 次失败
    { subs: 2, attempts: 0, solvedAt: 20 },                 // 一把过
    { subs: 1, attempts: 1, solvedAt: null },               // 还没过
    null,                                                   // 没碰过这题
  ];
  const [attempts, accepted, rejected, ftsMs] = problemStats(list);
  assert.equal(attempts, 6, 'subs 求和');
  assert.equal(accepted, 2, 'AC 队伍数');
  assert.equal(rejected, 3, '2 + 0 + 1');
  assert.equal(ftsMs, 10000, 'FTS 是 10 秒 → 10000ms');
});

test('没有一血时 fts 保持 -1', () => {
  const [, , , fts] = problemStats([{ subs: 1, attempts: 1, solvedAt: null }]);
  assert.equal(fts, -1);
});

test('CE 这类不计罚时的失败不进入 rejected', () => {
  // attempts 只统计 jt.isPenalty() 的失败，CE 两者都不是
  const [, accepted, rejected] = problemStats([
    { subs: 3, attempts: 1, solvedAt: 30 },   // 2 次 CE + 1 次 WA + AC
  ]);
  assert.equal(accepted, 1);
  assert.equal(rejected, 1, '只算计入罚时的那一次');
});

test('循环时长 = (题数+1)*1000 + 5000', () => {
  assert.equal(problemRepeat(5), 6 * 1000 + 5000);
  assert.equal(problemRepeat(14), 15 * 1000 + 5000);
  assert.equal(FLY_IN, 250);
});

test('色板解析：黑是合法颜色，不能被当成失败', () => {
  assert.deepEqual(parseHex('#000000'), [0, 0, 0]);
  assert.deepEqual(parseHex('000000'), [0, 0, 0]);
  assert.deepEqual(parseHex('#FF7109'), [255, 113, 9]);
  assert.deepEqual(parseHex('  #f00 '), [255, 0, 0]);
  assert.equal(parseHex('#GGG'), null);
  assert.equal(parseHex('red'), null);
  assert.equal(parseHex(''), null);
  assert.equal(parseHex(null), null);
});

test('配色 data：直接用题目自带的 rgb', () => {
  const fn = makeColorFn('data', []);
  assert.deepEqual(fn({ id: 'A', rgb: '#FF7109' }, 0), [255, 113, 9]);
  assert.deepEqual(fn({ id: 'B', rgb: '#008100' }, 1), [0, 129, 0]);
});

test('配色 random：稳定、互不相同、亮度可控', () => {
  const fn = makeColorFn('random', []);
  const probs = Array.from({ length: 14 }, (_, i) => ({ id: 'P' + i }));

  const first = probs.map((p, i) => fn(p, i));
  const again = probs.map((p, i) => fn(p, i));
  assert.deepEqual(first, again, '同一题多次取值必须一致');

  const keys = new Set(first.map(c => c.join(',')));
  assert.equal(keys.size, 14, '14 题应该有 14 种颜色');

  // 亮度落在合理区间，不能全黑或全白
  for (const [r, g, b] of first) {
    const y = (299 * r + 587 * g + 114 * b) / 1000;
    assert.ok(y > 40 && y < 220, `亮度 ${y.toFixed(0)} 越界`);
  }
});

test('配色 custom：按题号循环取色板', () => {
  const fn = makeColorFn('custom', ['#FF0000', '#00FF00', '#0000FF']);
  const got = [0, 1, 2, 3, 4].map(i => fn({ id: 'P' + i }, i));
  assert.deepEqual(got, [
    [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 0, 0], [0, 255, 0],
  ]);
});

test('配色 custom 但色板为空时回落 data', () => {
  const fn = makeColorFn('custom', []);
  assert.deepEqual(fn({ id: 'A', rgb: '#FF7109' }, 0), [255, 113, 9]);
});
