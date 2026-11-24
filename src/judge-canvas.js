/* 判题队列渲染 —— JudgePresentation / AbstractScoreboardPresentation / ShadedRectangle 移植
 *
 * 版面（TitledPresentation.paint:137-161）：
 *   y ∈ [0, titleHeight)          时钟(左 1/12) + 标题(居中)
 *   y ∈ [titleHeight, +headerH)   表头图：黑底 + 白线 + Rank/Name/Solved/Time
 *   内容区 translate(0, headerH+titleH) + clip(height-headerH-titleH)
 *
 * 行内（JudgePresentation.drawSubmission:283-329 / drawRight:331-402）：
 *   名次  rowItalicsFont  TextImage y=5（顶边）
 *   队名  rowFont         TextHelper 基线 ascent+5
 *   解题  rowItalicsFont  TextImage y=5
 *   罚时  rowFont         TextImage y=5
 *   格子  y = (int)rowHeight/2 + CUBE_INSET/2 + 3
 *
 * 格子底色（ShadedRectangle.getPaint）：recent 时是「纯色→darker 0.55」的垂直渐变，
 * 非 recent 是纯色；k 在 ICPCColors.CCOUNT 上做三角波 —— 这才是原版的闪法。
 */

import { rel2sec } from './scoring.js';
import { drawTeamLogo } from './team-logo.js';

// ---------- TitledPresentation / AbstractScoreboardPresentation 常量 ----------
const BORDER = 8;
const CLOCK_MARGIN = 2;
const CUBE_INSET = 5;
const ARC = 7;
const ROWS = 12;
const CCOUNT = 15;

const FONT_FAMILY = '"ICPCFont", Arial, "Microsoft YaHei", sans-serif';
const f = (px, bold) => `${bold ? 'bold ' : ''}${px}px ${FONT_FAMILY}`;

// ---------- ICPCColors ----------
const PENDING_COLOR = [66, 114, 245];
const SOLVED_COLOR = [0, 230, 0];
const FIRST_TO_SOLVE_COLOR = [0, 100, 0];
const FAILED_COLOR = [240, 0, 0];
const YELLOW = [255, 223, 54];

const BG_COLOR = [60, 60, 60];                 // AbstractScoreboardPresentation.BG_COLOR
const CUBE_BG = [40, 40, 40];                  // ShadedRectangle.BG
const CUBE_BG_TEXT = [196, 196, 196, 175];     // ShadedRectangle.BG_TEXT

/** Utility.darker —— 输入输出都是 0..255 */
function darker(c, k) {
  return [
    Math.max(Math.floor(c[0] * k), 0),
    Math.max(Math.floor(c[1] * k), 0),
    Math.max(Math.floor(c[2] * k), 0),
  ];
}
/** Utility.alphaDarker(c, alpha, f) —— rgb 乘 f（0..255），alpha 直接给（0..255） */
function alphaDarker(c, alpha, k) {
  return [
    Math.max(Math.floor(c[0] * k), 0),
    Math.max(Math.floor(c[1] * k), 0),
    Math.max(Math.floor(c[2] * k), 0),
    alpha,
  ];
}
/** Utility.getColorsBetween —— steps 个颜色，第 i 个取 x = i/(steps-1)，按 0..255 插值 */
function colorsBetween(c1, c2, steps) {
  const out = new Array(steps);
  for (let i = 0; i < steps; i++) {
    const x = i / (steps - 1);
    out[i] = [0, 1, 2, 3].map(j => {
      const a = j < c1.length ? c1[j] : 255;
      const b = j < c2.length ? c2[j] : 255;
      return a * (1 - x) + b * x;
    });
  }
  return out;
}
/** Color → canvas 颜色串（输入是 0..255） */
function css(c) {
  const r = Math.round(c[0]);
  const g = Math.round(c[1]);
  const b = Math.round(c[2]);
  const a = c.length > 3 ? Math.round((c[3] / 255) * 1000) / 1000 : 1;
  return `rgba(${r},${g},${b},${a})`;
}

// ICPCColors.PENDING / SOLVED / FIRST_TO_SOLVE / FAILED
const PENDING = colorsBetween(PENDING_COLOR, alphaDarker(PENDING_COLOR, 128, 0.5), CCOUNT);
const SOLVED = colorsBetween(SOLVED_COLOR, alphaDarker(SOLVED_COLOR, 128, 0.5), CCOUNT);
const FTS = colorsBetween(FIRST_TO_SOLVE_COLOR, alphaDarker(FIRST_TO_SOLVE_COLOR, 128, 0.5), CCOUNT);
const FAILED = colorsBetween(FAILED_COLOR, alphaDarker(FAILED_COLOR, 128, 0.5), CCOUNT);
const SOLVED_DIM = darker(SOLVED_COLOR, 0.4);   // JudgePresentation:376 Utility.darker(SOLVED_COLOR, 0.4f)

function roundRectPath(ctx, x, y, w, h, r = ARC) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** 字体度量：模拟 FontMetrics.ascent/descent/height */
function metrics(ctx, font) {
  ctx.font = font;
  const m = ctx.measureText('Mg');
  const asc = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || 0;
  const desc = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || 0;
  return { asc, desc, height: asc + desc };
}
function widthOf(ctx, font, s) {
  ctx.font = font;
  return ctx.measureText(String(s)).width;
}

/** 与总榜同源的几何（AbstractScoreboardPresentation.setup:104-131） */
export function judgeLayout(W, H, nProb, rows = ROWS) {
  const dpi = 96;
  const size0 = Math.trunc((H * 72.0 * 0.028) / dpi);
  const headerH = Math.trunc(H / 50);
  const titleH = Math.trunc(H / 30);
  const rowH = (H - headerH - titleH) / rows;

  // AbstractScoreboardPresentation.setup:106-108
  //   float tempRowHeight = height / (float) teamsPerScreen;   ← 用的是「全屏高度/行数」，不是扣掉表头后的 rowH
  //   size = tempRowHeight * 36f * 0.95f / dpi;
  // 行数变了字号就跟着变（12 行 → 40px，10 行 → 48px），和 setNumRows() 一致
  const size = ((H / rows) * 36 * 0.95) / dpi;

  const cubeH = Math.floor(rowH / 2.5) - CUBE_INSET;
  let cubeW = Math.floor((rowH / 1.8 - CUBE_INSET) * 10);
  while (cubeW > 30 && (cubeW + CUBE_INSET) * nProb > W - rowH * 3 - 70) cubeW -= 2;

  return {
    W, H, headerH, titleH, rowH, cubeH, cubeW, nProb, rows,
    rowFontPx: size * 1.25,                 // 数值版，缩字号时要用
    rowFont: f(size * 1.25, true),          // rowFont
    rowItalicsFont: f(size * 1.25, true),   // rowItalicsFont（源码同为 BOLD size*1.25）
    statusFont: f(size * 0.7, true),        // statusFont
    problemFont: f(size * 0.5, false),      // problemFont
    headerFont: f(Math.min(size0, size * 0.85), true),
    titleFont: f(size0 * 2.2, true),
    clockFont: f(size0 * 1.25, true),
    size,
  };
}

/**
 * ShadedRectangle.getPaint 里的 k：在 CCOUNT 上做三角波。
 *
 * ⚠️ 判题队列**用不到**这个函数：JudgePresentation.drawRight:368 传给
 * ShadedRectangle.drawRoundRect 的 time 是常量 0，所以 k 恒为 0，
 * 取到的永远是 ICPCColors.XXX[0] —— 未衰减的原色。
 * 这里保留只是为了对照总榜（那边传的是 getTimeMs()，会闪）。
 */
export function pulseK(timeMs) {
  let k = Math.floor(((timeMs * 45.0) / 1000.0) % (CCOUNT * 2));
  if (k > CCOUNT - 1) k = CCOUNT * 2 - 1 - k;
  return k;
}

/**
 * ShadedRectangle.getPaint：返回 {solid} 或 {top,bottom}（渐变）。
 *
 * JudgePresentation 恒传 time=0 → k=0：
 *   recent   → 渐变「原色 → darker(0.55)」，
 *   !recent  → 纯色 ICPCColors.XXX[CCOUNT/3]
 */
export function cellPaint(status, recent, fts, timeMs = 0) {
  const k = recent ? pulseK(timeMs) : Math.floor(CCOUNT / 3);

  const arr = status === 'solved'
    ? (fts ? FTS : SOLVED)
    : status === 'failed' ? FAILED : PENDING;
  const c = arr[k];
  if (!recent) return { solid: css(c) };
  // MyGradientPaint: (0,0,c) → (0,h,darker(c,0.55))
  return { top: css(c), bottom: css(darker(c, 0.55)) };
}

/** 画一个圆角格子（ShadedRectangle.createRoundRect + g.drawImage 等价物） */
function drawCube(ctx, x, y, w, h, paint, outline, text, font, plain) {
  const inset = outline ? 1 : 0;
  if (outline) ctx.translate(1, 1);
  const ww = w - inset * 2;
  const hh = h - inset * 2;

  roundRectPath(ctx, x + (outline ? 0 : 0), y + (outline ? 0 : 0), ww, hh);
  if (paint.solid) {
    ctx.fillStyle = paint.solid;
  } else {
    const g = ctx.createLinearGradient(0, y, 0, y + hh);
    g.addColorStop(0, paint.top);
    g.addColorStop(1, paint.bottom);
    ctx.fillStyle = g;
  }
  ctx.fill();

  if (outline) {
    ctx.strokeStyle = outline;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.lineWidth = 1;
    ctx.translate(-1, -1);
  }

  if (text) {
    const m = metrics(ctx, font);
    ctx.font = font;
    ctx.fillStyle = plain ? css(CUBE_BG_TEXT) : '#fff';
    if (plain) {
      ctx.fillText(text, x + (ww - widthOf(ctx, font, text)) / 2, y + (hh + m.height) / 2 - m.desc + 1);
    } else {
      ctx.fillText(text, x + (ww - widthOf(ctx, font, text)) / 2, y + hh / 2 + m.height / 2 - m.desc + 1);
    }
  }
}

/** AbstractScoreboardPresentation.drawHeader:290-317 —— 黑底 + 白线 + 四个列名 */
function drawHeaderBand(ctx, L, w) {
  const { W, headerH, titleH } = L;
  const headerTop = titleH;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, headerTop, W, headerH + 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, headerTop + headerH - 1, W, 1);   // drawLine

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.font = L.headerFont;

  const hy = headerTop + headerH - 3;
  const hw = s => widthOf(ctx, L.headerFont, s);
  ctx.fillText('Rank', BORDER + (w.w199 - hw('Rank')) / 2, hy);
  ctx.fillText('Name', BORDER + w.w199sp + L.rowH, hy);
  ctx.fillText('Solved', W - BORDER - w.w9999sp - (hw('Solved') + w.w99) / 2, hy);
  ctx.fillText('Time', W - BORDER - (hw('Time') + w.w9999) / 2, hy);
}

/**
 * 画一帧。
 * @param rows [{ y, alpha, rank, teamName, solved, time, cells, currentProblem, currentStatus, currentText }]
 * @param probs [{id,label}]
 * @param times {elapsedText, remainText}
 * @param opts  {frozen, now}
 */
export function drawJudgeFrame(ctx, L, rows, probs, times, opts = {}) {
  const { W, H, headerH, titleH, rowH, cubeW, cubeH } = L;
  const contentTop = titleH + headerH;
  const contentH = H - contentTop;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // ---------- 标题带：时钟 + 标题（TitledPresentation.paint:142-150） ----------
  // 注意顺序：先画表头图，再画时钟/标题 —— 否则 50px 的标题会被 21px 的表头黑条切掉下半截
  const clockM = metrics(ctx, L.clockFont);
  const clockAsc = clockM.asc + CLOCK_MARGIN;
  const titleM = metrics(ctx, L.titleFont);
  const fr = L.rowFont;
  const fh = L.headerFont;
  const w199 = widthOf(ctx, fr, '199');
  const w199sp = widthOf(ctx, fr, '199 ');
  const w9999 = widthOf(ctx, fr, '9999');
  const w9999sp = widthOf(ctx, fr, ' 9999');
  const w99 = widthOf(ctx, fr, '99');

  drawHeaderBand(ctx, L, { w199, w199sp, w9999, w9999sp, w99 });

  ctx.textAlign = 'center';
  ctx.fillStyle = opts.frozen ? css(YELLOW) : '#fff';
  ctx.font = L.clockFont;
  ctx.fillText(times.elapsedText, W / 12, clockAsc);
  ctx.fillText(times.remainText, (W * 11) / 12, clockAsc);

  ctx.fillStyle = '#fff';
  ctx.font = L.titleFont;
  ctx.fillText('Judge Queue', W / 2, titleM.asc);

  // ---------- 内容区（paintImpl:160-193） ----------
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, contentTop, W, contentH);
  ctx.clip();
  ctx.translate(0, contentTop);

  // 偶数行背景（drawRowBackground，BG_COLOR）
  for (let i = 0; i < L.rows; i += 2) {
    ctx.fillStyle = css(BG_COLOR);
    ctx.fillRect(0, i * rowH, W, rowH);
  }

  // 度量（Java 用 FontMetrics 现算）
  // 和总榜 standings-canvas.drawRow 同一套：middle 基线 + 5 + rowFont*0.42
  const indent = BORDER + w199sp + rowH;
  const cubeDy = Math.trunc(rowH / 2) + Math.trunc(CUBE_INSET / 2) + 3;
  const textY = 5 + L.rowFontPx * 0.42;
  const w199_9_9999 = widthOf(ctx, fr, '199 9 9999');

  for (const r of rows) {
    const y = (r.y !== undefined ? r.y : 0) * rowH;
    if (y >= contentH) continue;                 // Java: yy < height - headerHeight
    if (y + rowH < 0) continue;

    ctx.save();
    ctx.globalAlpha = r.alpha === undefined ? 1 : r.alpha;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // 名次（rowItalicsFont）
    ctx.font = L.rowItalicsFont;
    ctx.fillStyle = '#fff';
    const rank = String(r.rank);
    ctx.fillText(rank, BORDER + (w199 - widthOf(ctx, L.rowItalicsFont, rank)) / 2, y + textY);

    // 队标（JudgePresentation.paintCell:314-318，和总榜同一套公式）
    const logoSize = Math.max(8, Math.floor(rowH) - 10);
    drawTeamLogo(ctx, BORDER + w199sp, y + (rowH - logoSize) / 2, logoSize, r.team, opts.orgs, opts.showLogo);

    // 队名：和总榜同一套 —— 超宽就缩字号（下限 0.55×），基线不动
    const nameX = BORDER + w199sp + rowH;
    const avail = Math.max(40, W - BORDER - w199_9_9999 - rowH);
    const name = r.teamName || '';
    let nameFs = L.rowFontPx;
    const nw = widthOf(ctx, f(nameFs, true), name);
    if (nw > avail) nameFs = Math.max(nameFs * 0.55, (nameFs * avail) / nw);
    ctx.font = f(nameFs, true);
    ctx.fillStyle = '#fff';
    ctx.fillText(name, nameX, y + textY);

    // 解题数 / 罚时
    ctx.font = fr;
    ctx.fillStyle = '#fff';
    if (r.solved > 0) {
      const s = String(r.solved);
      ctx.fillText(s, W - BORDER - w9999sp - (w99 + widthOf(ctx, fr, s)) / 2, y + textY);
    }
    if (r.time > 0) {
      const s = String(r.time);
      ctx.font = fr;
      ctx.fillText(s, W - BORDER - (w9999 + widthOf(ctx, fr, s)) / 2, y + textY);
    }

    // 题目格子（drawRight:359-401）
    const cubeTop = y + cubeDy;
    for (let j = 0; j < probs.length; j++) {
      const xx = indent + j * (cubeW + CUBE_INSET);
      const c = r.cells ? r.cells[j] : null;

      if (j === r.currentProblem) {
        const recent = r.currentRecent !== false;
        const fts = !!r.currentFts;
        // ShadedRectangle.createRoundRect：FTS 额外加一圈 SOLVED_COLOR 描边
        const outline = fts ? css(SOLVED_COLOR) : null;
        // time 恒为 0 —— JudgePresentation:368 原文如此，所以 k=0、颜色不衰减
        drawCube(ctx, xx, cubeTop, cubeW, cubeH,
          cellPaint(r.currentStatus, recent, fts, 0), outline,
          r.currentText || '', L.statusFont, false);
      } else if (c && c.solvedAt !== null && c.solvedAt !== undefined) {
        // 已解出：只显示暗绿块，不带文字（源码注释：文字太干扰）
        drawCube(ctx, xx, cubeTop, cubeW, cubeH, { solid: css(SOLVED_DIM) }, null, '', L.statusFont, false);
      } else {
        // drawRoundRectPlain：BG + 题号
        drawCube(ctx, xx, cubeTop, cubeW, cubeH, { solid: css(CUBE_BG) }, null,
          probs[j].label, L.problemFont, true);
      }
    }

    ctx.restore();
  }

  ctx.restore();
}

/** 字号取整（避免 measureText 每帧算浮点） */
function px0(v) {
  return Math.round(v * 100) / 100;
}

/**
 * 一条提交 → 一行
 *
 * recent（是否闪烁）= ContestUtil.isRecent(contest, submission)
 *   = !isJudged || 提交时间在过去 5 分钟内
 * 已判且超过 5 分钟的走纯色，不闪。
 */
export function rowOf(sub, model, byTeam, pidx, statusMap, elapsedSec, ftsSet) {
  const st = byTeam.get(sub.team_id);
  const verdict = statusMap ? statusMap.get(sub.id) : null;   // 'solved' | 'failed' | null
  const status = verdict === 'solved' ? 'solved' : verdict === 'failed' ? 'failed' : 'pending';
  const sec = rel2sec(sub.contest_time);
  const recent = !verdict ? true : (elapsedSec == null ? true : sec > elapsedSec - 300);
  return {
    // drawTeamLogo 需要 organization_id / name，只有 teamName 不够
    team: st ? st.team : { name: sub.team_id },
    teamName: st ? st.team.name : sub.team_id,
    rank: st ? st.rank : '-',
    solved: st ? st.solved : 0,
    time: st ? Math.floor(st.penalty / 60) : 0,
    cells: st ? st.cells : null,
    currentProblem: pidx.has(sub.problem_id) ? pidx.get(sub.problem_id) : -1,
    currentStatus: status,
    currentText: String(Math.floor(sec / 60)),
    currentRecent: recent,
    currentFts: !!(ftsSet && ftsSet.has(sub.id)),
    subId: sub.id,
  };
}

/**
 * 静态铺排（?anim=0 或首屏播种）。
 *
 * 顺序取 Map 插入顺序（= 事件到达顺序 = Java 里 submissions 列表的顺序），
 * 不能用 contest_time 排序：同一时间戳的提交只属于同一队，会把画面塞成一行队名。
 */
export function seedRows(model, standings, statusMap, limit = ROWS, elapsedSec, ftsSet) {
  const probs = [...model.problems.values()].sort((a, b) => a.ordinal - b.ordinal);
  const pidx = new Map(probs.map((p, i) => [p.id, i]));
  const byTeam = new Map(standings.rows.map(r => [r.team.id, r]));

  const all = [...model.submissions.values()];
  const subs = all.slice(Math.max(0, all.length - limit));

  return {
    probs,
    rows: subs.map((s, i) => ({
      ...rowOf(s, model, byTeam, pidx, statusMap, elapsedSec, ftsSet),
      y: i,
    })),
  };
}

export { BORDER, CUBE_INSET, ARC, ROWS, CCOUNT };

/** 供其它视图复用（problem-canvas 需要同一套 ICPCColors） */
export const PALETTE = {
  PENDING, SOLVED, FTS, FAILED,
  PENDING_COLOR, SOLVED_COLOR, FIRST_TO_SOLVE_COLOR, FAILED_COLOR, YELLOW,
};
export { css, metrics, widthOf, roundRectPath };
