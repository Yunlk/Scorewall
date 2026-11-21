/* 柱状图测试 —— 对照 AbstractChartPresentation / Series / ProblemSummaryChart
 *
 * 关键数值：
 *   maximum = ceil(maxValue * 1.1)          updateMaxTarget
 *   刻度     m = (int)max/4 取到 5 的倍数   initLines
 *   两根柱   ww = w*0.7，series0 右移 w*0.1，series1 左移 w*0.1
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BarChart, makeProblemChart, smooth, chartLayout, CHART_REPEAT,
  INITIAL_DELAY, FADE_IN_TIME,
} from '../src/chart-canvas.js';

const probs = [
  { id: 'A', label: 'A', rgb: '#FF7109' },
  { id: 'B', label: 'B', rgb: '#008100' },
  { id: 'C', label: 'C', rgb: '#0096FF' },
];

/** problemStats 的返回格式：[attempts, accepted, rejected, ftsMs] */
const stats = [
  [168, 160, 8, 60000],
  [35, 34, 1, 120000],
  [0, 0, 0, -1],
];

test('smooth：0→0，1→1，中点对称', () => {
  assert.equal(smooth(0), 0);
  assert.equal(smooth(-1), 0);
  assert.equal(smooth(1), 1);
  assert.equal(smooth(2), 1);
  assert.ok(Math.abs(smooth(0.5) - 0.5) < 1e-6, '中点应为 0.5');
  assert.ok(Math.abs(smooth(0.5 - 0.1) + smooth(0.5 + 0.1) - 1) < 1e-6, '应中心对称');
  for (let x = 0; x <= 1; x += 0.05) {
    assert.ok(smooth(x) >= 0 && smooth(x) <= 1, `x=${x} 越界`);
  }
});

test('maximum = ceil(最大值 × 1.1)', () => {
  const chart = makeProblemChart(1920, 1080, probs, stats, p => [0, 200, 0]);
  assert.equal(chart.series[0].getValue(0), 168);
  assert.equal(chart.series[1].getValue(0), 160);
  assert.equal(chart.maximum.getValue(), 185, 'ceil(168*1.1) = 185');
});

test('刻度：185 → [45, 90, 135, 180]', () => {
  const chart = makeProblemChart(1920, 1080, probs, stats, p => [0, 200, 0]);
  assert.deepEqual(chart.lines, [45, 90, 135, 180]);
  assert.equal(chart.lineDelta, 45);
});

test('小数据不出 0 刻度（m 至少为 1）', () => {
  const small = [[2, 1, 1, -1], [0, 0, 0, -1], [0, 0, 0, -1]];
  const chart = makeProblemChart(1920, 1080, probs, small, p => [0, 200, 0]);
  // max = ceil(2*1.1) = 3；m = 3/4 = 0 → 兜底 1；n = 3
  assert.equal(chart.maximum.getValue(), 3);
  assert.deepEqual(chart.lines, [1, 2, 3]);
  assert.ok(chart.lines.every(v => v >= 1));
});

test('两个系列：attempts 用题目原色，solved 用 alphaDarker(200, 0.8)', () => {
  const chart = makeProblemChart(1920, 1080, probs, stats, p => [255, 113, 9]);
  assert.deepEqual(chart.series[0].getPaint(0), [255, 113, 9]);
  const solved = chart.series[1].getPaint(0);
  assert.deepEqual(solved.slice(0, 3), [204, 90, 7], '255/113/9 × 0.8 取整');
  assert.equal(solved[3], 200, 'alpha 固定 200');
});

test('系列标题对齐源码文案', () => {
  const chart = makeProblemChart(1920, 1080, probs, stats, p => [0, 0, 255]);
  assert.equal(chart.series[0].title, '# of submissions');
  assert.equal(chart.series[1].title, '# of solved submissions');
});

test('getOutline：黑色柱用浅灰，其他用 brighter()', () => {
  const chart = makeProblemChart(1920, 1080, probs, stats, p => [0, 0, 0]);
  const o = chart.series[0].getOutline(0);
  assert.deepEqual(o.slice(0, 3), [192, 192, 192], '纯黑改用 LIGHT_GRAY');
});

test('值标签：0 不显示', () => {
  const chart = makeProblemChart(1920, 1080, probs, stats, p => [0, 0, 255]);
  assert.equal(chart.series[0].getValueLabel(2), '', 'C 题 0 次提交不写标签');
  assert.equal(chart.series[0].getValueLabel(0), '168');
});

test('resize 只换几何，不动动画状态', () => {
  const chart = makeProblemChart(1920, 1080, probs, stats, p => [0, 0, 255]);
  const t = chart.maximum.xTarget;
  chart.resize(960, 540);
  assert.equal(chart.W, 960);
  assert.equal(chart.maximum.xTarget, t, '不能把 maximum 重置');
});

test('常量与源码一致', () => {
  assert.equal(CHART_REPEAT, 15000);
  assert.equal(INITIAL_DELAY, 250);
  assert.equal(FADE_IN_TIME, 3000);
  const L = chartLayout(1920, 1080);
  assert.match(L.titleFont, /bold \d+px/);
  assert.match(L.labelFont, /normal \d+px/);
});
