/* 判题队列颜色测试 —— 对照 ShadedRectangle.getPaint + ICPCColors
 *
 * 关键：JudgePresentation.drawRight:368 传给 ShadedRectangle 的 time 恒为 0，
 * 于是 k = (0*45/1000) % 30 = 0，永远取 ICPCColors.XXX[0]（未衰减的原色）。
 *
 *   ICPCColors.SOLVED[0]  = rgb(0,230,0)   alpha 255
 *   ICPCColors.FAILED[0]  = rgb(240,0,0)
 *   ICPCColors.PENDING[0] = rgb(66,114,245)
 *   ICPCColors.FIRST_TO_SOLVE[0] = rgb(0,100,0)
 *
 * recent → GradientPaint(原色 → darker(0.55))；!recent → 纯色 XXX[CCOUNT/3]
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { pulseK, cellPaint, judgeLayout } from '../src/judge-canvas.js';

test('k 是 0..14 的三角波（总榜用，判题队列恒为 0）', () => {
  assert.equal(pulseK(0), 0);
  assert.equal(pulseK(100), 4);
  assert.equal(pulseK(200), 9);
  assert.equal(pulseK(334), 14);
  assert.equal(pulseK(667), 0);

  for (let t = 0; t < 2000; t += 17) {
    const k = pulseK(t);
    assert.ok(k >= 0 && k <= 14, `t=${t} k=${k} 越界`);
  }
});

test('k=0 时是未衰减的原色（这是判题队列的实际取色）', () => {
  assert.equal(cellPaint('solved', true, false, 0).top, 'rgba(0,230,0,1)');
  assert.equal(cellPaint('failed', true, false, 0).top, 'rgba(240,0,0,1)');
  assert.equal(cellPaint('pending', true, false, 0).top, 'rgba(66,114,245,1)');
  assert.equal(cellPaint('solved', true, true, 0).top, 'rgba(0,100,0,1)', 'FTS 用暗绿原色');
});

test('recent 时底部是 darker(原色, 0.55)', () => {
  assert.equal(cellPaint('solved', true, false, 0).bottom, 'rgba(0,126,0,1)');   // 230*0.55
  assert.equal(cellPaint('failed', true, false, 0).bottom, 'rgba(132,0,0,1)');   // 240*0.55
  assert.equal(cellPaint('pending', true, false, 0).bottom, 'rgba(36,62,134,1)'); // 66/114/245 *0.55
});

test('非 recent 用 k=CCOUNT/3=5 的纯色', () => {
  const s = cellPaint('solved', false, false, 0);
  assert.ok(s.solid, '应返回纯色');
  assert.equal(s.top, undefined);
  // g = 230*(9/14) + 115*(5/14) ≈ 189
  const m = s.solid.match(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/);
  assert.equal(Number(m[1]), 0);
  assert.ok(Math.abs(Number(m[2]) - 189) <= 1, `绿应约 189，实际 ${m[2]}`);
  assert.ok(Math.abs(Number(m[4]) - 0.823) < 0.01, `alpha 应约 0.82，实际 ${m[4]}`);

  // 与 time 无关
  assert.equal(cellPaint('solved', false, false, 0).solid, cellPaint('solved', false, false, 99999).solid);
});

test('布局：12 行 + 表头 + 标题占满整屏', () => {
  const L = judgeLayout(1920, 1080, 14);
  assert.equal(L.headerH, 21);
  assert.equal(L.titleH, 36);
  assert.ok(Math.abs(L.rowH * 12 - (1080 - 21 - 36)) < 1e-6, '12 行应铺满内容区');
  assert.ok(L.cubeW > 30, '14 题时格子仍应有宽度');
  assert.ok((L.cubeW + 5) * 14 <= 1920 - L.rowH * 3 - 70, '格子总宽不能溢出');
});
