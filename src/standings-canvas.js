/* 总榜 canvas 渲染 —— 对齐上游 Source
 *
 *   AbstractScoreboardPresentation.drawHeader() / paintImpl() / drawTeamAndProblemGrid() / drawStatsRow()
 *   AbstractScrollingScoreboardPresentation.paintBarsAndScroll() / getScroll()
 *
 * 立即模式：每帧整屏重画，几何在 layout() 里按 (W,H) 一次算好。
 */

import { drawTeamLogo } from './team-logo.js';

const ROWS = 12, CUBE_INSET = 5, BORDER = 8, ARC = 7;
const MS_PER_PAGE = 12000, SCROLL_MS = 1500;

const FONT = '\"ICPCFont\", Arial, \"Microsoft YaHei\", sans-serif';
const f = (px, bold, italic) => `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${px}px ${FONT}`;

export function makeLayout(W, H, nProb) {
  const headerH = Math.floor(H / 50);
  const titleH = Math.floor(H / 30);
  const rowH = (H - headerH - titleH) / ROWS;
  // 源码：base 用 H/teamsPerScreen，不是真实 rowHeight；size0 先取整
  const size0 = Math.trunc(H * 72 * 0.028 / 96);
  const base = (H / ROWS) * 36 * 0.95 / 96;
  const cubeH = Math.floor(rowH / 2.5) - CUBE_INSET;
  let cubeW = Math.floor(((rowH / 1.8) - CUBE_INSET) * 10);
  while (cubeW > 30 && (cubeW + CUBE_INSET) * nProb > W - rowH * 3 - 70) cubeW -= 2;

  return {
    W, H, headerH, titleH, rowH, cubeH, cubeW, nProb,
    rowFont: base * 1.25,
    rowItalics: base * 1.25,   // 同 rowFont，无斜体
    statusFont: base * 0.7,
    problemFont: base * 0.5,
    headerFont: Math.min(size0, base * 0.85),
    headerItalics: Math.min(size0, base * 0.85),   // 同 headerFont，无斜体
    titleFont: size0 * 2.2,     // TitledPresentation：size*2.2，size 已截断
    clockFont: size0 * 1.25,    // TitledPresentation：size*1.25
    indent: BORDER + 0 + 0,      // 下面补
  };
}

function measure(ctx, text, font) {
  ctx.font = font;
  return ctx.measureText(String(text)).width;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const COLORS = {
  solved: 'rgb(0,230,0)',
  failed: 'rgb(240,0,0)',
  pending: 'rgb(66,114,245)',
  fts: 'rgb(0,100,0)',
  cellBg: 'rgb(40,40,40)',
  cellText: 'rgba(196,196,196,0.69)',
  rowBg: 'rgb(60,60,60)',
  statsText: 'rgb(128,128,128)',
};

/**
 * 画一帧。
 * @param ctx 2d context
 * @param L   makeLayout 的结果
 * @param rows computeStandings().rows
 * @param probs 题目数组（有序）
 * @param times {elapsed, remain}
 * @param scrollPx 当前滚动偏移（像素）
 * @param perProblem [{pending, solved}] 每题的统计
 */
export function drawFrame(ctx, L, rows, probs, times, scrollPx, perProblem, fadeAlpha = 1, opts = {}) {
  const { W, H, headerH, titleH, rowH, cubeW, cubeH } = L;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const indent = BORDER + measure(ctx, '199 ', f(L.rowFont, true)) + rowH;

  // ---------- 标题带（TitledPresentation） ----------
  // 源码：drawString(s, x, fm.getAscent())，时钟 +CLOCK_MARGIN(2)
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  const ascentOf = (font) => {
    ctx.font = font;
    const m = ctx.measureText('Mg');
    return m.actualBoundingBoxAscent || m.fontBoundingBoxAscent || 0;
  };
  const clockF = f(L.clockFont, true);
  const titleF = f(L.titleFont, true);
  const clockAsc = ascentOf(clockF) + 2;
  const titleAsc = ascentOf(titleF);

  // TitledPresentation：封榜时时钟用 ICPCColors.YELLOW
  ctx.fillStyle = opts.frozen ? 'rgb(255,223,54)' : '#fff';
  ctx.font = clockF;
  ctx.textAlign = 'center';
  ctx.fillText(times.elapsedText, W / 12, clockAsc);
  ctx.fillText(times.remainText, W * 11 / 12, clockAsc);
  ctx.fillStyle = '#fff';
  ctx.font = titleF;
  ctx.fillText('Current Standings', W / 2, titleAsc);
  ctx.textAlign = 'left';

  // ---------- 表头（drawHeader）—— 位于标题带之下 ----------
  // 规则：每个字符串用它实际绘制的那个字号去量，不要交叉
  const fr = f(L.rowFont, true);                 // 数字用 rowFont
  const fh = f(L.headerFont, true);              // NAME / TIME
  const fhi = f(L.headerItalics, true);          // 源码无斜体
  const w = (txt, font) => measure(ctx, txt, font);

  const w199 = w('199', fr);
  const w199sp = w('199 ', fr);
  const w9999 = w('9999', fr);
  const w9999sp = w(' 9999', fr);
  const w99 = w('99', fr);

  ctx.fillStyle = '#000';
  ctx.fillRect(0, titleH, W, headerH + 2);
  const hy = titleH + headerH - 3;   // 源码：表头带内 y = headerHeight - 3
  ctx.fillStyle = '#fff';

  ctx.font = fhi;
  ctx.fillText('Rank', BORDER + (w199 - w('Rank', fhi)) / 2, hy);
  ctx.font = fh;
  ctx.fillText('Name', BORDER + w199sp + rowH, hy);
  ctx.font = fhi;
  ctx.fillText('Solved', W - BORDER - w9999sp - (w('Solved', fhi) + w99) / 2, hy);
  ctx.font = fh;
  ctx.fillText('Time', W - BORDER - (w('Time', fh) + w9999) / 2, hy);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, titleH + headerH - 1, W, 1);

  // ---------- 内容区（paintBarsAndScroll） ----------
  const contentTop = titleH + headerH;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, contentTop, W, H - contentTop);
  ctx.clip();
  ctx.globalAlpha = fadeAlpha;
  ctx.translate(0, contentTop - scrollPx);

  const barH = rowH;
  const totalBars = rows.length + 1;            // +1 = 统计行
  for (let i = 0; i < totalBars; i++) {
    if (i % 2 === 0) {                          // 只画偶数行
      ctx.fillStyle = COLORS.rowBg;
      ctx.fillRect(0, i * barH, W, barH);
    }
  }

  // 队伍（倒序画，和源码一致）
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    const y = i * barH;
    // 滚动后可见窗口是 [scrollPx, scrollPx + contentH]
    const contentH = H - contentTop;
    if (y + barH <= scrollPx || y >= scrollPx + contentH) continue;
    drawRow(ctx, L, r, probs, y, indent, opts.now || 0, opts.elapsedSec, opts.orgs, opts);
  }

  // ---------- 底部两行统计（drawStatsRow） ----------
  const sy = rows.length * barH;
  const statY = (int => 0)(0) + Math.floor(rowH * 0.6);
  ctx.font = f(L.statusFont, true);   // ShadedRectangle 内部用 statusFont
  ctx.textAlign = 'center';
  ctx.fillStyle = COLORS.statsText;
  for (let p = 0; p < probs.length; p++) {
    const x = indent + p * (cubeW + CUBE_INSET);
    const st = (perProblem && perProblem[p]) || { pending: 0, solved: 0 };

    // 上格：待判数
    const y1 = sy + statY + CUBE_INSET / 2 - 1 - Math.floor(cubeH * 5 / 4);
    if (st.pending > 0) {
      ctx.fillStyle = COLORS.pending;
      roundRect(ctx, x, y1, cubeW, cubeH, ARC); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(String(st.pending), x + cubeW / 2, y1 + cubeH / 2 + 1);
    } else {
      ctx.fillStyle = COLORS.cellBg;
      roundRect(ctx, x, y1, cubeW, cubeH, ARC); ctx.fill();
    }

    // 下格：通过数
    const y2 = sy + statY + CUBE_INSET / 2 - 1;
    if (st.solved > 0) {
      ctx.fillStyle = COLORS.solved;
      roundRect(ctx, x, y2, cubeW, cubeH, ARC); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.fillText(String(st.solved), x + cubeW / 2, y2 + cubeH / 2 + 1);
    } else {
      ctx.fillStyle = COLORS.cellBg;
      roundRect(ctx, x, y2, cubeW, cubeH, ARC); ctx.fill();
    }
  }
  ctx.textAlign = 'left';

  ctx.restore();

  ctx.save();
  ctx.globalAlpha = fadeAlpha;
  drawLegend(ctx, W, H);
  ctx.restore();
}


/** 右下角图例（Legend.drawLegend）—— 字号固定 24，不随屏幕缩放 */
const LEGEND = {
  MARGIN: 15, H_SPACING: 10, V_SPACING: 15, FONT_PX: 24,
  TEXT: ['First to Solve', 'Solved Problem', 'Rejected Submission', 'Pending Submission'],
};

export function drawLegend(ctx, W, H, bottomOff = 200) {
  const { MARGIN, H_SPACING, V_SPACING, FONT_PX, TEXT } = LEGEND;
  ctx.save();
  ctx.font = `bold ${FONT_PX}px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const fm = ctx.measureText('Mg');
  const fh = Math.ceil(fm.fontBoundingBoxAscent + fm.fontBoundingBoxDescent);
  const fx = fh * 2;
  const h = MARGIN * 2 + V_SPACING * 3 + fh * 4;
  const w = MARGIN * 2 + fx + H_SPACING + ctx.measureText(TEXT[2]).width;

  // 锚点：右下角 (width-30, height-200)，再左移到 -w
  const ax = W - 30 - w;
  const ay = H - bottomOff;

  ctx.fillStyle = 'rgba(0,0,0,0.75)';            // new Color(0,0,0,192)
  ctx.fillRect(ax, ay, w, h);
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1;
  ctx.strokeRect(ax + 0.5, ay + 0.5, w, h);

  const items = [
    { y: 0, bg: COLORS.fts, outline: COLORS.solved, t: TEXT[0] },
    { y: V_SPACING + fh, bg: COLORS.solved, t: TEXT[1] },
    { y: V_SPACING * 2 + fh * 2, bg: COLORS.failed, t: TEXT[2] },
    { y: V_SPACING * 3 + fh * 3, bg: COLORS.pending, t: TEXT[3] },
  ];

  for (const it of items) {
    const x = ax + MARGIN;
    const y = ay + MARGIN + it.y;
    if (it.outline) {                            // 首杀：外描边 + 内填充
      ctx.fillStyle = it.outline;
      roundRect(ctx, x, y, fx, fh, ARC); ctx.fill();
      ctx.fillStyle = it.bg;
      roundRect(ctx, x + 2, y + 2, fx - 4, fh - 4, ARC); ctx.fill();
    } else {
      ctx.fillStyle = it.bg;
      roundRect(ctx, x, y, fx, fh, ARC); ctx.fill();
    }
    ctx.fillStyle = '#fff';
    ctx.fillText(it.t, x + fx + H_SPACING, y + fh * 0.75);
  }
  ctx.restore();
}

// AbstractScoreboardPresentation.getSmallTeamLogo：尺寸 rowHeight-10，垂直居中于整行，
// x 从 BORDER + w("199 ") 开始（那段宽度就是留给 logo 的）
function drawRow(ctx, L, r, probs, y, indent, nowMs, elapsedSec, orgs, opts) {
  const { W, rowH, cubeW, cubeH, rowFont } = L;
  ctx.textBaseline = 'middle';

  const fr = f(rowFont, true);
  const w = (txt, font) => measure(ctx, txt, font);
  const w199 = w('199', fr);
  const w199sp = w('199 ', fr);
  const w9999 = w('9999', fr);
  const w9999sp = w(' 9999', fr);
  const w99 = w('99', fr);
  const baseY = y + 5 + rowFont * 0.42;

  // 名次：居中于 "199" 宽度
  ctx.font = fr;
  ctx.fillStyle = '#fff';
  ctx.fillText(String(r.rank), BORDER + (w199 - w(String(r.rank), fr)) / 2, baseY);

  // 队伍 logo
  const logoSize = Math.max(8, Math.floor(L.rowH) - 10);
  drawTeamLogo(ctx, indent - L.rowH, y + (L.rowH - logoSize) / 2, logoSize, r.team, orgs, opts && opts.showLogo);

  // 队名（drawFit）
  const avail = Math.max(40, W - BORDER - w('199 9 9999 ', fr) - rowH - indent);
  let nameFs = rowFont;
  const nw = ctx.measureText(String(r.team.name || '')).width;
  if (nw > avail) nameFs = Math.max(rowFont * 0.55, rowFont * avail / nw);
  ctx.font = f(nameFs, true);
  ctx.fillText(String(r.team.name || ''), indent, baseY);

  // 解题数 / 罚时：与表头同公式，左对齐
  ctx.font = fr;
  if (r.solved > 0) {
    const sv = String(r.solved);
    ctx.fillText(sv, W - BORDER - w9999sp - (w99 + w(sv, fr)) / 2, baseY);
  }
  if (r.penalty > 0) {
    const tv = String(Math.floor(r.penalty / 60));
    ctx.fillText(tv, W - BORDER - (w9999 + w(tv, fr)) / 2, baseY);
  }

  // 题目格子
  const cellFont = Math.min(
    L.statusFont,
    L.statusFont * (cubeW - 8) / Math.max(1, measure(ctx, '44\u200A-\u200A1267', f(L.statusFont, true)))
  );
  const cellTop = y + Math.floor(rowH * 0.6) + CUBE_INSET / 2 - 1;
  ctx.textAlign = 'center';
  for (let p = 0; p < probs.length; p++) {
    const c = r.cells[p];
    const x = indent + p * (cubeW + CUBE_INSET);
    let bg = COLORS.cellBg, text = probs[p].label, fs = L.problemFont, tc = COLORS.cellText, outline = null;

    if (c && c.solvedAt !== null) {
      // 一血：深绿填充 + SOLVED_COLOR 2px 描边（ShadedRectangle.drawRoundRect）
      bg = c.isFTS ? COLORS.fts : COLORS.solved;
      tc = '#fff'; fs = cellFont;
      text = `${c.subs}\u200A-\u200A${Math.floor(c.solvedAt / 60)}`;
      if (c.isFTS) outline = COLORS.solved;
    } else if (c && c.pending) {
      bg = COLORS.pending; tc = '#fff'; fs = cellFont;
      text = `${c.subs}\u200A-\u200A${Math.floor(c.lastAt / 60)}`;
    } else if (c && c.subs) {
      bg = COLORS.failed; tc = '#fff'; fs = cellFont;
      text = `${c.subs}\u200A-\u200A${Math.floor(c.lastAt / 60)}`;
    }

    ctx.fillStyle = bg;
    roundRect(ctx, x, cellTop, cubeW, cubeH, ARC);
    ctx.fill();
    if (outline) {
      ctx.strokeStyle = outline;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    ctx.fillStyle = tc;
    ctx.font = f(fs, bg !== COLORS.cellBg);
    ctx.fillText(text, x + cubeW / 2, cellTop + cubeH / 2 + 1);
  }
  ctx.textAlign = 'left';
}

export { MS_PER_PAGE, SCROLL_MS };
