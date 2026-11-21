/* 柱状图 —— AbstractChartPresentation(Type.BAR) + Series + ProblemSummaryChart 移植
 *
 * 源码：
 *   PresContest/.../core/chart/AbstractChartPresentation.java   坐标轴 / 网格 / 柱子 / 图例
 *   PresContest/.../core/chart/Series.java                      一组数据 + 每根柱的动画
 *   PresContest/.../chart/ProblemSummaryChart.java              两系列：提交数、通过数
 *   PresContest/.../core/transition/SmoothUtil.java             缓动曲线
 *
 * 两个系列：
 *   series[0] 总面积 = 题目颜色，值 = 提交总数
 *   series[1] 面积   = alphaDarker(题目色, 200, 0.8)，值 = 通过队伍数
 * 两根柱并排：ww = w*0.7，series0 右移 w*0.1，series1 左移 w*0.1。
 */

import { css, metrics, widthOf } from './judge-canvas.js';
import { Animator, Movement } from './judge-queue.js';
import { problemColor } from './problem-canvas.js';

const MARGIN = 10;
const GAP = 5;
const DEPTH = 20;
const INITIAL_DELAY = 250;
const FADE_IN_TIME = 3000;

export const CHART_REPEAT = 15000;      // AbstractChartPresentation.getRepeat()

const FAMILY = '"ICPCFont", Arial, "Microsoft YaHei", sans-serif';
const pf = (px, bold) => `${bold ? 'bold' : 'normal'} ${Math.round(px)}px ${FAMILY}`;

const DARK_GRAY = [64, 64, 64];
const LIGHT_GRAY = [192, 192, 192];
const WHITE = [255, 255, 255];

/** SmoothUtil.smooth：S 形缓动，两端慢中间快 */
export function smooth(x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const f = t => (t < 0 ? -Math.exp(1 / t) : t === 0 ? 0 : Math.exp(-1 / t));
  return f(x) / (f(x) + f(1 - x));
}

/** Utility.alphaDarker */
function alphaDarker(c, alpha, k) {
  return [
    Math.max(Math.trunc(c[0] * k), 0),
    Math.max(Math.trunc(c[1] * k), 0),
    Math.max(Math.trunc(c[2] * k), 0),
    alpha,
  ];
}

/** java.awt.Color.brighter() */
function brighter(c) {
  const FACTOR = 0.7;
  const i = Math.trunc(1 / (1 - FACTOR));
  let [r, g, b] = c;
  if (r === 0 && g === 0 && b === 0) return [i, i, i];
  if (r > 0 && r < i) r = i;
  if (g > 0 && g < i) g = i;
  if (b > 0 && b < i) b = i;
  const up = v => Math.min(Math.trunc(v / FACTOR), 255);
  return [up(r), up(g), up(b)];
}

/** Series.java */
class Series {
  constructor(paints) {
    this.paints = paints;                        // Paint[]，每根柱一个
    this.values = paints.map(() => 0);
    this.anim = null;
    this.title = null;
  }

  setValues(vals) {
    for (let i = 0; i < vals.length; i++) this.values[i] = vals[i];
    if (!this.anim) {
      this.anim = this.values.map(v => new Animator(v, new Movement(5, 30)));
    } else {
      for (let i = 0; i < vals.length; i++) this.anim[i].setTarget(vals[i]);
    }
  }

  getLength() { return this.values.length; }
  getValue(i) { return this.values[i]; }
  getAnimValue(i) { return this.anim[i].getValue(); }

  getPaint(i) {
    return i < this.paints.length ? this.paints[i] : this.paints[0];
  }

  /** Series.getOutline：黑用浅灰，其他用 brighter() */
  getOutline(i) {
    let p = this.paints[0];
    if (this.paints.length > 1) p = this.paints[i];
    if (p[0] === 0 && p[1] === 0 && p[2] === 0) {
      return [LIGHT_GRAY[0], LIGHT_GRAY[1], LIGHT_GRAY[2], p.length > 3 ? p[3] : 255];
    }
    return brighter(p);
  }

  /** NumberFormat 千分位 + 0 不显示 */
  getValueLabel(i) {
    const v = this.getValue(i);
    if (v === 0) return '';
    return String(Math.round(v));
  }

  incrementTimeMs(dt) {
    if (!this.anim) return;
    for (const a of this.anim) a.incrementTimeMs(dt);
  }
}

/** setSize 里的字体 */
export function chartLayout(W, H) {
  const dpi = 96;
  const labelHeight = H / 20;
  const inch = labelHeight / dpi;
  return {
    W, H,
    titleFont: pf(inch * 72 * 1.1, true),
    labelFont: pf(inch * 72 * 0.9, false),
    axisFont: pf(inch * 72 * 0.9, false),
  };
}

/**
 * 一张柱状图。跨帧保存动画状态，所以要做成对象。
 */
export class BarChart {
  constructor(W, H, title, verticalAxisTitle) {
    this.W = W;
    this.H = H;
    this.L = chartLayout(W, H);
    this.title = title;
    this.verticalAxisTitle = verticalAxisTitle;
    this.horizontalAxisTitle = null;
    this.labels = [];

    this.series = null;
    this.xPoints = [];
    this.lines = null;
    this.lineDelta = 0;
    this.rect = null;
    this.showValueLabels = true;

    this.maximum = new Animator(0, new Movement(5, 20));
    this.startedAt = 0;            // 页面里代表 totalTime 的零点
  }

  /** 尺寸变了只更新几何，不重置动画时间轴 */
  resize(W, H) {
    this.W = W;
    this.H = H;
    this.L = chartLayout(W, H);
  }

  /** setupChart() */
  setSeries(labels, paintsPerSeries) {
    this.labels = labels;
    this.series = paintsPerSeries.map(p => new Series(p));
  }

  /** updateData() */
  updateData(valuesPerSeries) {
    if (!this.series) return;
    valuesPerSeries.forEach((vals, i) => this.series[i].setValues(vals));
    this.updateMaxTarget();
    this.initLines();
  }

  /** aboutToShow():130-134 —— 图表刚出现时把最大刻度对齐，不要从 0 长上来 */
  resetAnim() {
    this.updateMaxTarget();
    this.maximum.resetToTarget();
    this.initLines();
  }

  incrementTimeMs(dt) {
    if (!this.series) return;
    this.updateMaxTarget();
    this.maximum.incrementTimeMs(dt);
    this.initLines();
    for (const s of this.series) s.incrementTimeMs(dt);
  }

  updateMaxTarget() {
    if (!this.series) return;
    let f = 0;
    for (const s of this.series) {
      for (let i = 0; i < s.getLength(); i++) f = Math.max(f, s.getValue(i));
    }
    f *= this.showValueLabels ? 1.1 : 1.01;
    this.maximum.setTarget(Math.ceil(f));
  }

  initLines() {
    const max = this.maximum.getValue();
    if (max < 1) { this.lines = null; return; }

    const mt = Math.trunc(max);
    let m = Math.trunc(mt / 4);
    if (m % 5 !== 0) m = Math.trunc(m / 5) * 5;
    if (m < 1) m = 1;

    const n = Math.trunc(mt / m);
    const lines = [];
    for (let i = 0; i < n; i++) lines.push(m * (i + 1));
    this.lines = lines;
    this.lineDelta = m;
  }

  initXPoints() {
    if (!this.series || !this.rect) { this.xPoints = []; return; }
    const size = this.series[0].getLength();
    if (!size) { this.xPoints = []; return; }
    const w = this.rect.w / size;
    this.xPoints = [];
    for (let i = 0; i < size; i++) this.xPoints.push(Math.trunc(w * i + w / 2));
  }

  /** getPoints：返回每根柱顶的 y（相对 rect），含生长动画 */
  getPoints(series, growOnStart, tRepeat) {
    const size = series.getLength();
    const max = this.maximum.getValue();
    const out = new Array(size);
    for (let i = 0; i < size; i++) {
      const val = series.getAnimValue(i);
      let h = max > 0 ? (this.rect.h * val) / max : 0;
      if (growOnStart) {
        if (tRepeat < INITIAL_DELAY) h = 0;
        else if (tRepeat < INITIAL_DELAY + FADE_IN_TIME) {
          h *= smooth((tRepeat - INITIAL_DELAY) / FADE_IN_TIME);
        }
      }
      out[i] = this.rect.h - h;
    }
    return out;
  }

  /**
   * paintBackgroundRect：画标题 / 网格 / 轴标签，并把绘图区算出来
   * @returns rect
   */
  paintBackgroundRect(ctx, tRepeat) {
    const { W, H, L } = this;
    const r = { x: MARGIN, y: MARGIN, w: W - MARGIN * 2, h: H - MARGIN * 2 };

    // 标题
    if (this.title) {
      const m = metrics(ctx, L.titleFont);
      ctx.font = L.titleFont;
      ctx.fillStyle = '#fff';
      const tw = widthOf(ctx, L.titleFont, this.title);
      ctx.fillText(this.title, W / 2 - tw / 2, m.asc + GAP);
      const ind = m.height + GAP * 3;
      r.y += ind;
      r.h -= ind;
    }

    // 左边留白：看最大刻度文字多宽
    ctx.font = L.labelFont;
    let lm = metrics(ctx, L.labelFont);
    let ind = 0;
    const lines = this.lines || [];
    const numLines = lines.length;
    for (let i = 0; i < numLines; i++) {
      ind = Math.max(ind, widthOf(ctx, L.labelFont, String(lines[numLines - i - 1])));
    }
    ind += 5;

    // 纵轴标题（逆时针 90°）
    if (this.verticalAxisTitle) {
      ctx.font = L.axisFont;
      const hm = metrics(ctx, L.axisFont);
      ind += hm.height + GAP;
      ctx.save();
      ctx.translate(hm.height, (H + widthOf(ctx, L.axisFont, this.verticalAxisTitle)) / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.fillStyle = '#fff';
      ctx.fillText(this.verticalAxisTitle, 0, 0);
      ctx.restore();
      r.w -= hm.height + GAP;
    }

    r.x += ind;
    r.w -= ind;

    // 底部：横轴标题
    if (this.horizontalAxisTitle) {
      ctx.font = L.axisFont;
      const hm = metrics(ctx, L.axisFont);
      r.h -= hm.height + GAP;
      const tw = widthOf(ctx, L.axisFont, this.horizontalAxisTitle);
      ctx.fillStyle = '#fff';
      ctx.fillText(this.horizontalAxisTitle, ind + (W - ind - tw) / 2, r.y + r.h + hm.asc + GAP);
    }

    ctx.font = L.labelFont;
    lm = metrics(ctx, L.labelFont);
    r.h -= lm.asc + 8;

    // 网格线
    const max = this.maximum.getValue();
    for (let i = 0; i < numLines; i++) {
      const y = r.y + r.h - Math.trunc((r.h * lines[numLines - i - 1]) / max);
      ctx.fillStyle = css(DARK_GRAY);
      ctx.fillRect(r.x, y, r.w, 1);
    }

    // 左侧刻度
    ctx.fillStyle = '#fff';
    for (let i = 0; i <= numLines; i++) {
      let y = r.y + r.h;
      if (i < numLines) y = r.y + r.h - Math.trunc((r.h * lines[numLines - i - 1]) / max);
      const s = i < numLines ? String(lines[numLines - i - 1]) : '0';
      ctx.fillText(s, r.x - widthOf(ctx, L.labelFont, s) - 7, y + lm.asc / 2);
    }

    // 底部题号
    this.rect = r;
    this.initXPoints();
    ctx.fillStyle = '#fff';
    const by = r.y + r.h + lm.asc + 8;
    for (let i = 0; i < this.xPoints.length; i++) {
      const s = this.labels[i];
      if (s != null) {
        ctx.fillText(s, r.x + this.xPoints[i] - widthOf(ctx, L.labelFont, s) / 2, by);
      }
    }

    return r;
  }

  /** drawString3D：先画两笔黑色偏移，再画正字 */
  drawValueLabel(ctx, s, x, y, alpha) {
    const a = Math.max(0, Math.min(255, alpha));
    ctx.fillStyle = `rgba(0,0,0,${(Math.trunc(a / 3) / 255).toFixed(3)})`;
    ctx.fillText(s, x - 1, y - 1);
    ctx.fillText(s, x + 1, y + 1);
    ctx.fillStyle = a < 255 ? `rgba(255,255,255,${(a / 255).toFixed(3)})` : '#fff';
    ctx.fillText(s, x, y);
  }

  /** paintBarSeries */
  paintBarSeries(ctx, series, ser, numSeries, tRepeat, tTotal) {
    const size = series.getLength();
    if (!size) return;

    const w = this.rect.w / size;
    let ww = Math.trunc(w * 0.8);
    const pp = this.getPoints(series, true, tRepeat);

    const px = this.xPoints.slice();
    const py = pp.slice();

    if (numSeries > 1) {
      ww = Math.trunc(w * 0.7);
      for (let j = 0; j < px.length; j++) {
        if (ser === 0) px[j] += Math.trunc(w * 0.1);
        else if (ser === 1) px[j] -= Math.trunc(w * 0.1);
      }
    }

    for (let i = 0; i < size; i++) {
      const hh = this.rect.h - py[i];

      // 阴影
      ctx.fillStyle = 'rgba(0,0,0,0.251)';           // new Color(0,0,0,64)
      ctx.fillRect(px[i] - Math.trunc(ww / 2) - 1, py[i] - 1, ww + 3, hh + 2);

      // 柱体
      ctx.fillStyle = css(series.getPaint(i));
      ctx.fillRect(px[i] - Math.trunc(ww / 2), py[i], ww, hh);

      // 描边
      ctx.strokeStyle = css(series.getOutline(i));
      ctx.lineWidth = 2;
      ctx.strokeRect(px[i] - Math.trunc(ww / 2), py[i], ww, hh);
      ctx.lineWidth = 1;
    }

    // 值标签：3 秒后淡入
    const time = tTotal / 1000;
    if (this.showValueLabels && time > 3) {
      const a = Math.min(255, Math.trunc((time - 3) * 125));
      for (let i = 0; i < size; i++) {
        const s = series.getValueLabel(i);
        if (!s) continue;
        ctx.font = this.L.labelFont;
        const m = metrics(ctx, this.L.labelFont);
        this.drawValueLabel(ctx, s, px[i] - widthOf(ctx, this.L.labelFont, s) / 2,
          py[i] - m.desc - 4, a);
      }
    }
  }

  /** paintLegend：右下角，前 6 秒淡入淡出 */
  paintLegend(ctx, tRepeat) {
    if (!this.series || this.series.length < 2) return;

    const size = this.series.length;
    const titles = this.series.map(s => s.title || '');

    ctx.font = this.L.axisFont;
    const m = metrics(ctx, this.L.axisFont);
    const fh = m.height;
    const h = MARGIN * 2 + MARGIN * (size - 1) + fh * size;
    let w = 0;
    for (let i = 0; i < size; i++) {
      w = Math.max(w, MARGIN * 2 + fh + MARGIN + widthOf(ctx, this.L.axisFont, titles[i]));
    }

    const right = (this.W - this.rect.x - this.rect.w) / 2;
    ctx.save();
    ctx.translate(this.W - right - w, this.rect.y + right);

    // 背景 + 边框
    ctx.fillStyle = 'rgba(0,0,0,0.753)';             // new Color(0,0,0,192)
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

    ctx.translate(MARGIN, MARGIN);
    let y = 0;
    for (const s of this.series) {
      const paint = s.getPaint(0);
      ctx.fillStyle = css(paint);
      ctx.fillRect(0, y, fh, fh);

      ctx.strokeStyle = css(s.getOutline(0));
      ctx.lineWidth = 2;
      ctx.strokeRect(0, y, fh, fh);
      ctx.lineWidth = 1;

      ctx.fillStyle = '#fff';
      ctx.font = this.L.axisFont;
      ctx.fillText(s.title || '', MARGIN + fh, y + m.asc + 1);
      y += fh + MARGIN;
    }

    ctx.restore();
  }

  /**
   * paint()
   * @param tRepeat 循环时间（0..CHART_REPEAT）
   * @param tTotal  图表总运行时间（值标签淡入用）
   */
  draw(ctx, tRepeat, tTotal) {
    const { W, H, L } = this;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    if (!this.series) return;

    this.paintBackgroundRect(ctx, tRepeat);

    // 基线
    ctx.fillStyle = '#fff';
    ctx.fillRect(this.rect.x, this.rect.y + this.rect.h, this.rect.w, 1);

    ctx.save();
    ctx.translate(this.rect.x, this.rect.y);
    for (let i = 0; i < this.series.length; i++) {
      this.paintBarSeries(ctx, this.series[i], i, this.series.length, tRepeat, tTotal);
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, this.rect.h, this.rect.w, 1);
    ctx.restore();

    // 图例：0~1500 淡入，4500~6000 淡出
    if (tRepeat < 6000) {
      let a = 1;
      if (tRepeat > 0 && tRepeat < 1500) a = tRepeat / 1500;
      else if (tRepeat > 4500) a = (6000 - tRepeat) / 1500;
      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, a));
      this.paintLegend(ctx, tRepeat);
      ctx.restore();
    }
  }
}

/** ProblemSummaryChart：两系列 */
export function makeProblemChart(W, H, probs, statsList, colorOf) {
  const chart = new BarChart(W, H, 'Attempts & Solutions by Problem', '# of submissions');

  const labels = probs.map(p => p.label || '');
  const colorAttempt = probs.map((p, i) => (colorOf ? colorOf(p, i) : problemColor(p)));
  const colorSolved = colorAttempt.map(c => alphaDarker(c, 200, 0.8));

  chart.setSeries(labels, [colorAttempt, colorSolved]);
  chart.series[0].title = '# of submissions';
  chart.series[1].title = '# of solved submissions';

  const attempts = statsList.map(s => s[0]);
  const solved = statsList.map(s => s[1]);
  chart.updateData([attempts, solved]);
  chart.resetAnim();
  return chart;
}

export { MARGIN, GAP, DEPTH, INITIAL_DELAY, FADE_IN_TIME };
