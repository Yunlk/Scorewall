/* 判题队列视图（#56）—— JudgePresentation.drawSubmission / drawRight 的移植
 *
 * 行布局：
 *   名次      rowItalicsFont, x = BORDER + (w("199") - w(rank))/2, y = 5
 *   队名      rowFont, x = BORDER + w("199 ") + rowHeight
 *   解题/罚时 右对齐
 *   题目格子  y = rowHeight/2 + CUBE_INSET/2 + 3（注意是 half row）
 */

import { rel2sec, fmtClock } from './scoring.js';

const BORDER = 8;
const CUBE_INSET = 5;
const ARC = 7;
const ROWS = 12;

const FONT = '"ICPCFont", Arial, "Microsoft YaHei", sans-serif';
const f = (px, bold, italic) => `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${px}px ${FONT}`;

const C = {
  solved: 'rgb(0,230,0)',
  failed: 'rgb(240,0,0)',
  pending: 'rgb(66,114,245)',
  fts: 'rgb(0,100,0)',
  solvedDim: 'rgb(0,92,0)',
  cellBg: 'rgb(40,40,40)',
  cellText: 'rgba(196,196,196,0.69)',
  rowBg: 'rgb(60,60,60)',
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

// 与总榜同一套几何（AbstractScoreboardPresentation.setup）
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

/**
 * 画一帧判题队列。
 * @param rows [{ teamName, rank, solved, time, cells:[{solvedAt,pending,subs,lastAt}], probs:[...] }]
 *           rows 顺序就是行号（0 = 最上面）
 */
export function drawJudgeFrame(ctx, L, rows, probs, times, opts = {}) {
  const { W, H, headerH, titleH, rowH, cubeW, cubeH } = L;
  const measured = measureFor(ctx, L);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  // ---------- 标题带 ----------
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'center';
  const clockF = f(L.clockFont, true);
  const titleF = f(L.titleFont, true);
  const clockAsc = ascentOf(ctx, clockF) + 2;
  const titleAsc = ascentOf(ctx, titleF);

  ctx.fillStyle = opts.frozen ? 'rgb(255,223,54)' : '#fff';
  ctx.font = clockF;
  ctx.fillText(times.elapsedText, W / 12, clockAsc);
  ctx.fillText(times.remainText, W * 11 / 12, clockAsc);

  ctx.fillStyle = '#fff';
  ctx.font = titleF;
  ctx.fillText('Judge Queue', W / 2, titleAsc);

  // ---------- 行背景（只画偶数行） ----------
  const contentTop = titleH + headerH;
  for (let i = 0; i < ROWS; i += 2) {
    ctx.fillStyle = C.rowBg;
    ctx.fillRect(0, contentTop + i * rowH, W, rowH);
  }

  // ---------- 行 ----------
  const indent = BORDER + measured.w199sp + rowH;
  const rowH2 = Math.floor(rowH / 2);                 // drawRight: rowH = rowHeight/2
  const cellTop = contentTop + rowH2 + CUBE_INSET / 2 + 3;

  ctx.textAlign = 'left';
  rows.slice(0, ROWS).forEach((r, i) => {
    const yTop = contentTop + i * rowH;

    // 名次
    ctx.font = f(L.rowFont, true);
    ctx.fillStyle = '#fff';
    ctx.fillText(String(r.rank), BORDER + (measured.w199 - ctx.measureText(String(r.rank)).width) / 2,
      yTop + 5 + L.rowFont * 0.85);

    // 队名
    const nameX = BORDER + measured.w199sp + rowH;
    let fs = L.rowFont;
    const avail = W - BORDER * 2 - measured.w199_9_9999 - rowH;
    ctx.font = f(fs, true);
    const nw = ctx.measureText(r.teamName || '').width;
    if (nw > avail) fs = Math.max(fs * 0.55, fs * avail / nw);
    ctx.font = f(fs, true);
    ctx.fillText(r.teamName || '', nameX, yTop + 5 + L.rowFont * 0.85);

    // 解题数 / 罚时
    ctx.font = f(L.rowFont, true);
    if (r.solved > 0) {
      const s = String(r.solved);
      ctx.fillText(s, W - BORDER - measured.w9999sp - (measured.w99 + ctx.measureText(s).width) / 2,
        yTop + 5 + L.rowFont * 0.85);
    }
    if (r.time > 0) {
      const s = String(r.time);                     // ContestUtil.getTime -> 分钟
      ctx.fillText(s, W - BORDER - (measured.w9999 + ctx.measureText(s).width) / 2,
        yTop + 5 + L.rowFont * 0.85);
    }

    // 题目格子
    const cubTop = yTop + rowH2 + CUBE_INSET / 2 + 3;
    for (let j = 0; j < probs.length; j++) {
      const x = indent + j * (cubeW + CUBE_INSET);
      const isCurrent = r.currentProblem === j;
      const c = r.cells[j];

      if (isCurrent) {
        // 当前提交：状态色 + "次数-时间"
        const st = r.currentStatus;
        ctx.fillStyle = st === 'solved' ? C.solved : st === 'failed' ? C.failed : C.pending;
        roundRect(ctx, x, cubTop, cubeW, cubeH, ARC);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = f(L.statusFont, true);
        ctx.textAlign = 'center';
        ctx.fillText(r.currentText || '', x + cubeW / 2, cubTop + cubeH / 2 + 1);
        ctx.textAlign = 'left';
      } else if (c && c.solvedAt !== null) {
        // 已通过：半透明深绿，无文字
        ctx.fillStyle = C.solvedDim;
        roundRect(ctx, x, cubTop, cubeW, cubeH, ARC);
        ctx.fill();
      } else {
        // 空格子带题号
        ctx.fillStyle = C.cellBg;
        roundRect(ctx, x, cubTop, cubeW, cubeH, ARC);
        ctx.fill();
        ctx.fillStyle = C.cellText;
        ctx.font = f(L.problemFont, true);
        ctx.textAlign = 'center';
        ctx.fillText(probs[j].label, x + cubeW / 2, cubTop + cubeH / 2 + 1);
        ctx.textAlign = 'left';
      }
    }
  });
}

function measureFor(ctx, L) {
  const fr = f(L.rowFont, true);
  const w = s => { ctx.font = fr; return ctx.measureText(s).width; };
  return {
    w199: w('199'),
    w199sp: w('199 '),
    w9999: w('9999'),
    w9999sp: w(' 9999'),
    w99: w('99'),
    w199_9_9999: w('199 9 9999'),
  };
}

function ascentOf(ctx, font) {
  ctx.font = font;
  const m = ctx.measureText('Mg');
  return m.actualBoundingBoxAscent || m.fontBoundingBoxAscent || 0;
}

/** 把最近 N 条提交组织成行（静态种子，动画版走 JudgeQueue） */
export function seedRows(model, standings, limit = ROWS) {
  const { submissions, judgements, problems } = model;
  const probs = [...problems.values()].sort((a, b) => a.ordinal - b.ordinal);
  const pidx = new Map(probs.map((p, i) => [p.id, i]));
  const verdict = new Map();
  for (const j of judgements.values()) verdict.set(j.submission_id, j);

  const byTeam = new Map();
  for (const r of standings.rows) byTeam.set(r.team.id, r);

  const subs = [...submissions.values()]
    .sort((a, b) => rel2sec(b.contest_time) - rel2sec(a.contest_time))
    .slice(0, limit);

  return {
    probs,
    rows: subs.map(sub => {
      const st = byTeam.get(sub.team_id);
      const j = verdict.get(sub.id);
      const jtId = j ? j.judgement_type_id : null;
      const jt = jtId ? model.judgementTypes.get(jtId) : null;
      const status = !jt ? 'pending' : jt.solved ? 'solved' : jt.penalty ? 'failed' : 'pending';
      const pi = pidx.get(sub.problem_id) ?? -1;
      const sec = rel2sec(sub.contest_time);
      return {
        teamName: st ? st.team.name : sub.team_id,
        rank: st ? st.rank : '-',
        solved: st ? st.solved : 0,
        time: st ? Math.floor(st.penalty / 60) : 0,
        cells: st ? st.cells : probs.map(() => null),
        currentProblem: pi,
        currentStatus: status,
        currentText: String(Math.floor(sec / 60)),   // ContestUtil.getTime：只有分钟
      };
    }),
  };
}

export { BORDER, CUBE_INSET, ARC };
