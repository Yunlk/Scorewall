/* 判题队列视图（#56）—— JudgePresentation.drawSubmission / drawRight 移植
 *
 * 行内结构（坐标以该行左上角为原点）：
 *   名次   TextImage.drawString(rank, x, 5)              → 顶边 5，基线 5+ascent
 *   队名   TextHelper.drawString(name, xx, ascent+5, w)   → 基线 ascent+5
 *   解题   TextImage.drawString(n, ..., 5)                → 顶边 5
 *   罚时   TextImage.drawString(t, ..., 5)                → 顶边 5
 *   格子   y = rowHeight/2 + CUBE_INSET/2 + 3
 *
 * 渲染约定：每行独立 ctx.save()/restore()，唯一出口，textAlign 进出行都复位。
 */

import { rel2sec } from './scoring.js';

const BORDER = 8;
const CUBE_INSET = 5;
const ARC = 7;
const ROWS = 12;
const FONT_FAMILY = '"ICPCFont", Arial, "Microsoft YaHei", sans-serif';
const f = (px, bold) => `${bold ? 'bold ' : ''}${px}px ${FONT_FAMILY}`;

const C = {
  solved: 'rgb(0,230,0)',
  failed: 'rgb(240,0,0)',
  pending: 'rgb(66,114,245)',
  solvedDim: 'rgb(0,92,0)',            // Utility.darker(SOLVED_COLOR, 0.4f)
  cellBg: 'rgb(40,40,40)',
  cellText: 'rgba(196,196,196,0.69)',
  rowBg: 'rgb(60,60,60)',
  frozenClock: 'rgb(255,223,54)',
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 与总榜同源的几何（AbstractScoreboardPresentation.setup） */
export function judgeLayout(W, H, nProb) {
  const headerH = Math.floor(H / 50);
  const titleH = Math.floor(H / 30);
  const rowH = (H - headerH - titleH) / ROWS;
  const size0 = Math.trunc(H * 72 * 0.028 / 96);
  const base = (H / ROWS) * 36 * 0.95 / 96;
  const cubeH = Math.floor(rowH / 2.5) - CUBE_INSET;
  let cubeW = Math.floor(((rowH / 1.8) - CUBE_INSET) * 10);
  while (cubeW > 30 && (cubeW + CUBE_INSET) * nProb > W - rowH * 3 - 70) cubeW -= 2;
  return {
    W, H, headerH, titleH, rowH, cubeH, cubeW, nProb,
    rowFont: base * 1.25,
    statusFont: base * 0.7,
    problemFont: base * 0.5,
    headerFont: Math.min(size0, base * 0.85),
    titleFont: size0 * 2.2,
    clockFont: size0 * 1.25,
  };
}

function ascentOf(ctx, font) {
  ctx.font = font;
  const m = ctx.measureText('Mg');
  return m.actualBoundingBoxAscent || m.fontBoundingBoxAscent || 0;
}

function widthOf(ctx, font, s) {
  ctx.font = font;
  return ctx.measureText(String(s)).width;
}

/** 画一帧。rows 顺序 = Java List 顺序（老的在前）；可带 y（小数行号）与 alpha */
export function drawJudgeFrame(ctx, L, rows, probs, times, opts = {}) {
  const { W, H, headerH, titleH, rowH, cubeW, cubeH } = L;
  const contentTop = titleH + headerH;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  // ---------- 标题带 ----------
  const clockF = f(L.clockFont, true);
  const titleF = f(L.titleFont, true);
  const clockAsc = ascentOf(ctx, clockF) + 2;
  const titleAsc = ascentOf(ctx, titleF);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = opts.frozen ? C.frozenClock : '#fff';
  ctx.font = clockF;
  ctx.fillText(times.elapsedText, W / 12, clockAsc);
  ctx.fillText(times.remainText, W * 11 / 12, clockAsc);
  ctx.fillStyle = '#fff';
  ctx.font = titleF;
  ctx.fillText('Judge Queue', W / 2, titleAsc);

  // ---------- 行背景（只画偶数行） ----------
  for (let i = 0; i < ROWS; i += 2) {
    ctx.fillStyle = C.rowBg;
    ctx.fillRect(0, contentTop + i * rowH, W, rowH);
  }

  // ---------- 度量（Java 用 FontMetrics 现算） ----------
  const fr = f(L.rowFont, true);
  const w199 = widthOf(ctx, fr, '199');
  const w199sp = widthOf(ctx, fr, '199 ');
  const w9999 = widthOf(ctx, fr, '9999');
  const w9999sp = widthOf(ctx, fr, ' 9999');
  const w99 = widthOf(ctx, fr, '99');
  const w199_9_9999 = widthOf(ctx, fr, '199 9 9999');

  const indent = BORDER + w199sp + rowH;
  const cellDy = Math.floor(rowH / 2) + CUBE_INSET / 2 + 3;
  const asc = ascentOf(ctx, fr);
  const nameBaseline = asc + 5;          // TextHelper: ascent + 5
  const topBaseline = 5 + asc;           // TextImage: 顶边 5

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const y = contentTop + (r.y !== undefined ? r.y : i) * rowH;
    if (y + rowH < contentTop || y > contentTop + ROWS * rowH) continue;

    ctx.save();
    ctx.globalAlpha = r.alpha === undefined ? 1 : r.alpha;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // 名次
    const rank = String(r.rank);
    ctx.font = fr;
    ctx.fillStyle = '#fff';
    ctx.fillText(rank, BORDER + (w199 - widthOf(ctx, fr, rank)) / 2, y + topBaseline);

    // 队名（超宽按 TextHelper 缩字号）
    const nameX = BORDER + w199sp + rowH;
    const avail = W - BORDER * 2 - w199_9_9999 - rowH;
    let fs = L.rowFont;
    const nw = widthOf(ctx, f(fs, true), r.teamName || '');
    if (nw > avail) fs = Math.max(fs * 0.55, fs * avail / nw);
    ctx.font = f(fs, true);
    ctx.fillStyle = '#fff';
    ctx.fillText(r.teamName || '', nameX, y + nameBaseline);

    // 解题数
    ctx.font = fr;
    ctx.fillStyle = '#fff';
    if (r.solved > 0) {
      const s = String(r.solved);
      ctx.fillText(s, W - BORDER - w9999sp - (w99 + widthOf(ctx, fr, s)) / 2, y + topBaseline);
    }
    // 罚时（ContestUtil.getTime → 整数分钟）
    if (r.time > 0) {
      const s = String(r.time);
      ctx.fillText(s, W - BORDER - (w9999 + widthOf(ctx, fr, s)) / 2, y + topBaseline);
    }

    // 题目格子
    const cubTop = y + cellDy;
    const cellMid = cubTop + cubeH / 2;
    for (let j = 0; j < probs.length; j++) {
      const x = indent + j * (cubeW + CUBE_INSET);
      const isCurrent = r.currentProblem === j;
      const c = r.cells ? r.cells[j] : null;

      if (isCurrent) {
        const st = r.currentStatus;
        ctx.fillStyle = st === 'solved' ? C.solved : st === 'failed' ? C.failed : C.pending;
        roundRect(ctx, x, cubTop, cubeW, cubeH, ARC);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = f(L.statusFont, true);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(r.currentText || '', x + cubeW / 2, cellMid);
      } else if (c && c.solvedAt !== null) {
        ctx.fillStyle = C.solvedDim;
        roundRect(ctx, x, cubTop, cubeW, cubeH, ARC);
        ctx.fill();
      } else {
        ctx.fillStyle = C.cellBg;
        roundRect(ctx, x, cubTop, cubeW, cubeH, ARC);
        ctx.fill();
        ctx.fillStyle = C.cellText;
        ctx.font = f(L.problemFont, false);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(probs[j].label, x + cubeW / 2, cellMid);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }

    ctx.restore();
  }
}

/** 一条提交 → 一行 */
export function rowOf(sub, model, byTeam, pidx) {
  const st = byTeam.get(sub.team_id);
  let jtId = null;
  for (const j of model.judgements.values()) {
    if (j.submission_id === sub.id) { jtId = j.judgement_type_id; break; }
  }
  const jt = jtId ? model.judgementTypes.get(jtId) : null;
  const status = !jt ? 'pending' : jt.solved ? 'solved' : jt.penalty ? 'failed' : 'pending';
  const sec = rel2sec(sub.contest_time);
  return {
    teamName: st ? st.team.name : sub.team_id,
    rank: st ? st.rank : '-',
    solved: st ? st.solved : 0,
    time: st ? Math.floor(st.penalty / 60) : 0,
    cells: st ? st.cells : null,
    currentProblem: pidx.get(sub.problem_id) ?? -1,
    currentStatus: status,
    currentText: String(Math.floor(sec / 60)),
  };
}

/** 最近 N 条提交铺成行（Java List：老的在前） */
export function seedRows(model, standings, limit = ROWS) {
  const { submissions, problems } = model;
  const probs = [...problems.values()].sort((a, b) => a.ordinal - b.ordinal);
  const pidx = new Map(probs.map((p, i) => [p.id, i]));
  const byTeam = new Map(standings.rows.map(r => [r.team.id, r]));

  const subs = [...submissions.values()]
    .sort((a, b) => rel2sec(b.contest_time) - rel2sec(a.contest_time))
    .slice(0, limit)
    .reverse();

  return { probs, rows: subs.map(s => rowOf(s, model, byTeam, pidx)) };
}

export { BORDER, CUBE_INSET, ARC, ROWS };
