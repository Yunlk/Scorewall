/* 单题统计 —— ProblemSummaryPresentation + ProblemSummary 移植
 *
 * 源码：
 *   presentations/ProblemSummaryPresentation.java   网格布局 + 飞入 + 统计汇总
 *   presentations/ProblemSummary.java               单个题目方块
 *   internal/Problem.java#getColorVal               题目颜色解析
 *   ContestModel/ICPCColors#getContrastColor        描边色
 *
 * 版面（没有标题、没有时钟，全屏铺方块）：
 *   rows: 题数 ≥12 → 4 行；≥9 → 3 行；≥4 → 2 行；否则 1 行
 *   每行 numPerRow = ceil((n+1)/rows) 个，最后多一个空格子
 *   格子内：左上角大题号，右侧四行统计（Attempts / Accepted / Rejected / FTS 时间）
 */

import { PALETTE, css, metrics, widthOf, roundRectPath } from './judge-canvas.js';

const MARGIN = 5;          // ProblemSummaryPresentation.MARGIN
const FLY_IN = 250;        // ProblemSummaryPresentation.FLY_IN
const FAMILY = '"ICPCFont", Arial, "Microsoft YaHei", sans-serif';
const bf = px => `bold ${Math.round(px)}px ${FAMILY}`;

const LIGHT_GRAY = [192, 192, 192];
const DARK_GRAY = [64, 64, 64];

/** Problem.getColorVal() —— 只看 rgb 字段，3/4/6/7 位十六进制 */
export function problemColor(p) {
  const raw = p && p.rgb;
  if (typeof raw !== 'string') return [0, 0, 0];
  const len = raw.length;
  if (!(len === 3 || len === 4 || len === 6 || len === 7)) return [0, 0, 0];

  // Java 是 Integer.parseInt，遇到非法十六进制会抛异常 → 落回 BLACK
  let s = raw;
  if (len === 3 || len === 4) {
    if (len === 4) s = s.substring(1);
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return [0, 0, 0];
    return [r, g, b];
  }

  if (len === 7) s = s.substring(1);
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return [0, 0, 0];
  return [r, g, b];
}

/** ContestModel/ICPCColors.getContrastColor：按亮度选黑/白 */
function contrastColor(c) {
  const y = Math.trunc((299 * c[0] + 587 * c[1] + 114 * c[2]) / 1000);
  return y >= 128 ? [0, 0, 0] : [255, 255, 255];
}

/** java.awt.Color.brighter()：FACTOR = 0.7 */
function brighter(c) {
  const FACTOR = 0.7;
  const i = Math.trunc(1 / (1 - FACTOR));      // 3
  let [r, g, b] = c;
  if (r === 0 && g === 0 && b === 0) return [i, i, i];
  if (r > 0 && r < i) r = i;
  if (g > 0 && g < i) g = i;
  if (b > 0 && b < i) b = i;
  const up = v => Math.min(Math.trunc(v / FACTOR), 255);
  return [up(r), up(g), up(b)];
}

/** ProblemSummaryPresentation.setSize —— 网格 */
export function problemLayout(W, H, nProb) {
  const GAP = Math.trunc(H / 50);
  let rows = 1;
  if (nProb >= 12) rows = 4;
  else if (nProb >= 9) rows = 3;
  else if (nProb >= 4) rows = 2;

  if (nProb === 0) return { W, H, cells: [], nProb };

  const numPerRow = Math.ceil((nProb + 1) / rows);
  const wid = Math.trunc((W - MARGIN * 2 - GAP * (numPerRow - 1)) / numPerRow);
  const hei = Math.trunc((H - MARGIN * 2 - GAP * (rows - 1)) / rows);

  const cells = [];
  for (let i = 0; i < nProb + 1; i++) {
    cells.push({
      x: MARGIN + (i % numPerRow) * (wid + GAP),
      y: MARGIN + Math.trunc(i / numPerRow) * (hei + GAP),
      w: wid,
      h: hei,
    });
  }
  return { W, H, cells, nProb, rows, numPerRow };
}

/**
 * 统计某一题（ProblemSummaryPresentation.paint:93-109）
 * @returns [attempts, accepted, rejected, ftsMs]
 *   attempts  = Σ numSubmissions           （含 pending）
 *   accepted  = AC 的队伍数
 *   rejected  = SOLVED 队的 numJudged-1  +  FAILED 队的 numJudged
 *   ftsMs     = 一血的时间（毫秒），没有则 -1
 */
export function problemStats(byProblem) {
  let attempts = 0, accepted = 0, rejected = 0, ftsMs = -1;

  for (const c of byProblem) {
    if (!c) continue;
    attempts += c.subs || 0;
    rejected += c.attempts || 0;          // SOLVED 时 = numJudged-1，FAILED 时 = numJudged
    if (c.solvedAt !== null && c.solvedAt !== undefined) {
      accepted++;
      if (c.isFTS) ftsMs = c.solvedAt * 1000;
    }
  }
  return [attempts, accepted, rejected, ftsMs];
}

/** 把一个圆角矩形铺上颜色并写居中白字（ProblemSummary.draw） */
function pill(ctx, color, x, y, w, h, arc, text, font, fm) {
  ctx.fillStyle = css(color);
  roundRectPath(ctx, x, y, w, h, arc);
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.font = font;
  const tw = widthOf(ctx, font, text);
  ctx.fillText(text, x + (w - tw) / 2, y + (h + fm.asc) / 2 - 1);
}

/**
 * 单个方块（ProblemSummary.paint）
 *
 * p == null（末尾那个占位格）时 `color` 字段是 null，`g.setColor(null)` 不生效，
 * 于是保留的是 gg 的初始颜色 —— 父 g 在整个循环里没 setColor 过，所以是黑色。
 * 注意每个格子都是 g.create() 的独立副本，状态不会在格子间流传。
 */
function drawCell(ctx, r, p, stats) {
  const W = r.w, H = r.h;
  const ARC = Math.trunc((W + H) / 50);

  ctx.save();
  ctx.translate(r.x, r.y);

  const color = p ? problemColor(p) : [0, 0, 0];
  ctx.fillStyle = css(color);
  roundRectPath(ctx, 0, 0, W, H, ARC);
  ctx.fill();

  // 只有真题才描边（LIGHT_GRAY 1.5px）
  if (p) {
    ctx.strokeStyle = css(LIGHT_GRAY);
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, 0.75, 0.75, W - 1.5, H - 1.5, ARC);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  const margin = Math.trunc(H / 20);
  const bigFont = bf(H * 5 / 6);
  const bigM = metrics(ctx, bigFont);

  // 题号：先 4 个对角偏移画描边色，再正中画 brightColor
  if (p) {
    const label = p.label || '';
    const isWhite = color[0] === 255 && color[1] === 255 && color[2] === 255;
    ctx.font = bigFont;
    ctx.fillStyle = css(isWhite ? DARK_GRAY : contrastColor(color));
    for (const i of [-1, 0, 1]) {
      for (const j of [-1, 0, 1]) {
        if (i !== 0 && j !== 0) ctx.fillText(label, margin + i, margin + j + bigM.asc);
      }
    }
    ctx.fillStyle = css(brighter(color));
    ctx.fillText(label, margin, margin + bigM.asc);
  }

  // 右侧统计区
  const font = bf(H / 8);
  const fm = metrics(ctx, font);
  const margin2 = Math.trunc(H / 15);
  const w = Math.trunc((W * 3) / 9) - margin * 2;
  const x = W - margin - w - margin2;
  const y = margin + margin2;
  const h = Math.trunc((H - margin * 2 - margin2 * 3 - margin2 * 2) / 4);
  const arc2 = Math.trunc(w / 10);

  ctx.font = font;

  if (!stats) {
    // 无数据：只写四个灰色标签，右对齐
    ctx.fillStyle = css(LIGHT_GRAY);
    ['Attempts', 'Accepted', 'Rejected', 'First to Solve time'].forEach((s, k) => {
      ctx.fillText(s, x + w - widthOf(ctx, font, s), y + (h + margin2) * k + fm.asc);
    });
    ctx.restore();
    return;
  }

  const [attempts, accepted, rejected, fts] = stats;

  // 有任意数据就先铺一层暗底
  if (attempts > 0 || accepted > 0 || rejected > 0 || fts > -1) {
    const dark = [Math.trunc(color[0] / 3), Math.trunc(color[1] / 3), Math.trunc(color[2] / 3)];
    ctx.fillStyle = css(dark);
    roundRectPath(ctx, x - margin2, y - margin2, w + margin2 * 2,
      h * 4 + margin2 * 3 + margin2 * 2, ARC);
    ctx.fill();
  }

  if (attempts > 0) pill(ctx, PALETTE.PENDING[5], x, y, w, h, arc2, String(attempts), font, fm);
  if (accepted > 0) pill(ctx, PALETTE.SOLVED[5], x, y + h + margin2, w, h, arc2, String(accepted), font, fm);
  if (rejected > 0) pill(ctx, PALETTE.FAILED[5], x, y + (h + margin2) * 2, w, h, arc2, String(rejected), font, fm);

  if (fts > -1) {
    const yy = y + (h + margin2) * 3;
    pill(ctx, PALETTE.FTS[5], x, yy, w, h, arc2, String(Math.floor(fts / 60000)), font, fm);
    // 一血额外套一圈亮绿
    ctx.strokeStyle = css(PALETTE.SOLVED_COLOR);
    ctx.lineWidth = 1.5;
    roundRectPath(ctx, x, yy, w, h, arc2);
    ctx.stroke();
    ctx.lineWidth = 1;
  }

  ctx.restore();
}

/**
 * 画一帧
 * @param probs  [{id,label,rgb,...}]
 * @param statsList 与 probs 等长，每项是 problemStats() 的结果；null 表示还没数据
 * @param tMs   本轮循环已过的时间（0 .. repeat）
 */
export function drawProblemFrame(ctx, L, probs, statsList, tMs) {
  const { W, H, cells } = L;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  for (let i = 0; i < cells.length; i++) {
    if (tMs <= i * FLY_IN) break;              // 还没轮到的先不画（源码是 break，不是 continue）

    const p = i < probs.length ? probs[i] : null;
    const stats = i < probs.length ? statsList[i] : null;

    ctx.save();
    if (tMs < (i + 1) * FLY_IN) {
      // 飞入：透明度 0→1，位置从右下 offset 移到位
      const f = Math.max(0, Math.min(1, (tMs - i * FLY_IN) / FLY_IN));
      ctx.globalAlpha = f;
      const dx = Math.trunc(((1 - f) * W) / 30);
      ctx.translate(dx, dx);
    }
    drawCell(ctx, cells[i], p, stats);
    ctx.restore();
  }
}

/** 一轮循环时长（ProblemSummaryPresentation.getRepeat） */
export function problemRepeat(nProb) {
  return (nProb + 1) * 1000 + 5000;
}

export { MARGIN, FLY_IN };
