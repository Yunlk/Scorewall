/* 题解时间轴 —— TimelinePresentation 移植
 *
 * 源码 scoreboard/TimelinePresentation.java：
 *   start  = BORDER + fm.stringWidth("199 ") + rowHeight          (:112)
 *   scale  = (width - start - 20) / contest.getDuration()         (:114)
 *   getX(t)= start + t * scale                                     (:196)
 *
 * 每行（:146-192）：
 *   1. drawTimeArrow(g4, rowHeight*3/4 - 1)   —— 横轴 + 箭尖 + 每小时刻度
 *   2. drawTeamGrid(g4, contest, team)        —— 名次 / 队标 / 队名 / solved / time
 *   3. translate(0, rowHeight*3/4 - 1) 之后遍历该队所有提交，
 *      在 getX(contestTime) - cubeHeight/2 画一个 cubeHeight 的圆角方块，
 *      两次提交横向距离 < cubeHeight 时上下交错 offset = cubeHeight*3/16
 *
 * 另外两条竖线（:118-140）：封榜时刻（FREEZE_COLOR）、当前时刻（ICPCColors.BLUE）
 */

import { drawTeamLogo } from './team-logo.js';
import { PALETTE, css, widthOf, roundRectPath } from './judge-canvas.js';
import { drawLegend } from './standings-canvas.js';

const ROWS = 12, CUBE_INSET = 5, BORDER = 8;
const FAMILY = '"ICPCFont", Arial, "Microsoft YaHei", sans-serif';
const pf = (v, bold) => `${bold ? 'bold ' : ''}${v}px ${FAMILY}`;

/** TimelinePresentation:30-31 —— alphaDarker(PENDING_COLOR, 64, 1f) */
const FREEZE_COLOR = 'rgba(66,114,245,0.749)';
const BLUE = 'rgb(92,138,221)';
const ROW_BG = 'rgb(60,60,60)';
// 时间轴方块是历史记录，用固定状态亮色（不用 judge 队列「非 recent 压暗」那套）
// ShadedRectangle.getPaint:57-60 —— 非 recent 取 XXX[CCOUNT/3]，recent 才做闪动渐变
const K_MID = Math.floor(15 / 3);
const MS_PER_HOUR = 3600000;

export function timelineLayout(W, H) {
  const headerH = Math.floor(H / 50);
  const titleH = Math.floor(H / 30);
  const rowH = (H - headerH - titleH) / ROWS;
  const size0 = Math.trunc(H * 72 * 0.028 / 96);
  const base = (H / ROWS) * 36 * 0.95 / 96;

  return {
    W, H, headerH, titleH, rowH,
    // canvas 的 ctx.font 必须带单位，所以这里都存字符串；数值版另存 xxxPx
    rowFont: pf(base * 1.25, true),
    rowFontPx: base * 1.25,
    rowItalics: pf(base * 1.25, true),
    // TimelinePresentation.setSize:46 —— cubeFont = rowFont * 0.8
    cubeFont: pf(base * 1.25 * 0.8, true),
    cubeFontPx: base * 1.25 * 0.8,
    headerFont: pf(Math.min(size0, base * 0.85), true),
    headerItalics: pf(Math.min(size0, base * 0.85), true),
    titleFont: pf(size0 * 2.2, true),
    titleFontPx: size0 * 2.2,
    clockFont: pf(size0 * 1.25, true),
    clockFontPx: size0 * 1.25,
    // 方块边长沿用 AbstractScoreboardPresentation 的 cubeHeight
    cubeH: Math.floor(rowH / 2.5) - CUBE_INSET,
  };
}

/** 表头：Rank / Name / Solved / Time（TimelinePresentation.drawHeader:79-102） */
function drawHeader(ctx, L, w199, w199sp, w99, w9999, w9999sp) {
  const { W, headerH, titleH } = L;
  // 表头带在标题带之下
  ctx.fillStyle = '#000';
  ctx.fillRect(0, titleH, W, headerH + 2);

  const y = titleH + headerH - 3;   // 源码：表头带内 y = headerHeight - 3
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  ctx.font = L.headerItalics;
  ctx.fillStyle = '#fff';
  ctx.fillText('Rank', BORDER + (w199 - widthOf(ctx, L.headerItalics, 'Rank')) / 2, y);

  ctx.font = L.headerFont;
  ctx.fillText('Name', BORDER + w199sp + Math.floor(L.rowH), y);

  ctx.font = L.headerItalics;
  const solvedX = W - BORDER - w9999sp - (widthOf(ctx, L.headerItalics, 'Solved') + w99) / 2;
  ctx.fillText('Solved', solvedX, y);

  ctx.font = L.headerFont;
  const timeX = W - BORDER - (widthOf(ctx, L.headerFont, 'Time') + w9999) / 2;
  ctx.fillText('Time', timeX, y);

  ctx.fillStyle = '#fff';
  ctx.fillRect(0, titleH + headerH - 1, W, 1);
}

/** TimelinePresentation.drawTimeArrow:50-77 —— 横轴 + 箭尖 + 每小时刻度 */
function drawTimeArrow(ctx, x0, x1, axisY, numHours, getX) {
  ctx.strokeStyle = 'rgb(200,200,200)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, axisY);
  ctx.lineTo(x1, axisY);
  // 箭尖
  ctx.moveTo(x1 - 7, axisY - 7);
  ctx.lineTo(x1, axisY);
  ctx.lineTo(x1 - 7, axisY + 7);
  // 源码 while (hour < numHours)：从 0 开始，含起点刻度
  for (let hour = 0; hour < numHours; hour++) {
    const x = getX(hour * MS_PER_HOUR);
    if (x > x1) break;
    ctx.moveTo(x, axisY - 4);
    ctx.lineTo(x, axisY + 4);
  }
  ctx.stroke();
  ctx.lineWidth = 1;
}

export function drawTimelineFrame(ctx, L, rows, probs, subsByTeam, times, opts = {}) {
  const { W, H, headerH, titleH, rowH } = L;
  const contentTop = titleH + headerH;
  const contentH = H - contentTop;
  const cubeH = Math.max(8, L.cubeH);
  const offset = Math.trunc((cubeH * 3) / 16);

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const fr = L.rowFont;
  const w199 = widthOf(ctx, fr, '199');
  const w199sp = widthOf(ctx, fr, '199 ');
  const w9999 = widthOf(ctx, fr, '9999');
  const w9999sp = widthOf(ctx, fr, ' 9999');
  const w99 = widthOf(ctx, fr, '99');

  // 时钟 + 标题（TitledPresentation.paint）：先算 ascent，再按基线画
  const ascentOf = font => {
    ctx.font = font;
    const m = ctx.measureText('Mg');
    // 和 standings 一致：用 actualBoundingBoxAscent，fontBoundingBoxAscent 含行距会顶出标题带
    return m.actualBoundingBoxAscent || m.fontBoundingBoxAscent || 0;
  };
  const clockAsc = ascentOf(L.clockFont) + 2;
  const titleAsc = ascentOf(L.titleFont);

  ctx.textAlign = 'center';
  ctx.font = L.clockFont;
  ctx.fillStyle = times.frozen ? 'rgb(255,223,54)' : '#fff';
  ctx.fillText(times.elapsedText, W / 12, clockAsc);
  ctx.fillText(times.remainText, (W * 11) / 12, clockAsc);

  ctx.textAlign = 'left';

  drawHeader(ctx, L, w199, w199sp, w99, w9999, w9999sp);

  // 标题必须在 drawHeader 之后画：源码 TitledPresentation.paint:142-150 顺序是
  // paintHeader() → drawString(title)，标题的下伸部分（g/j/p/y）压在表头上。
  // 反过来 header 的黑底会把它们盖掉。
  ctx.fillStyle = '#fff';
  ctx.font = L.titleFont;
  ctx.textAlign = 'center';
  ctx.fillText('Current Standings', W / 2, titleAsc);
  ctx.textAlign = 'left';

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, contentTop, W, contentH);
  ctx.clip();
  ctx.translate(0, contentTop);

  // 偶数行背景
  for (let i = 0; i < L.rows || i < rows.length; i += 2) {
    ctx.fillStyle = ROW_BG;
    ctx.fillRect(0, i * rowH, W, rowH);
  }

  const start = BORDER + w199sp + Math.floor(rowH);
  const scale = (W - start - 20) / Math.max(1, times.duration);
  const getX = t => start + t * scale;
  const numHours = Math.floor(times.duration / MS_PER_HOUR);
  const axisDy = Math.floor((rowH * 3) / 4) - 1;
  const textY = 5 + L.rowFontPx * 0.42;

  const subsOf = id => (subsByTeam && subsByTeam.get(id)) || [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const y = i * rowH;
    if (y >= contentH) break;

    ctx.save();
    ctx.translate(0, y);

    // ① 时间轴
    drawTimeArrow(ctx, start, W - 20, axisDy, numHours, getX);

    // ② 名次 / 队标 / 队名 / solved / time
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    ctx.font = L.rowItalics;
    ctx.fillStyle = '#fff';
    const rank = String(r.rank);
    ctx.fillText(rank, BORDER + (w199 - widthOf(ctx, L.rowItalics, rank)) / 2, textY);

    const logoSize = Math.max(8, Math.floor(rowH) - 10);
    drawTeamLogo(ctx, BORDER + w199sp, (rowH - logoSize) / 2, logoSize, r.team, opts.orgs, opts.showLogo);

    const avail = Math.max(40, W - BORDER * 2 - widthOf(ctx, fr, '199 9 9999 ') - rowH);
    const name = String(r.team.name || '');
    let nameFs = L.rowFont;
    const nw = widthOf(ctx, `bold ${nameFs}px ${FAMILY}`, name);
    if (nw > avail) nameFs = Math.max(nameFs * 0.55, (nameFs * avail) / nw);
    ctx.font = `bold ${nameFs}px ${FAMILY}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(name, start, textY);

    ctx.font = L.rowItalics;
    if (r.solved > 0) {
      const s = String(r.solved);
      ctx.fillText(s, W - BORDER - w9999sp - (w99 + widthOf(ctx, L.rowItalics, s)) / 2, textY);
    }
    ctx.font = L.rowFont;
    if (r.penalty > 0) {
      const s = String(Math.floor(r.penalty / 60));
      ctx.fillText(s, W - BORDER - (w9999 + widthOf(ctx, L.rowFont, s)) / 2, textY);
    }

    // ③ 该队所有提交，骑在时间轴上
    const subs = subsOf(r.team.id);
    const secs = subs.map(s => s.tSec);
    let up = 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let k = 0; k < subs.length; k++) {
      const s = subs[k];
      const x = getX(s.tSec * 1000) - cubeH / 2;
      if (x < start - cubeH || x > W + cubeH) continue;

      // closeToNeighbor：同队另一条提交横向距离 < cubeHeight
      let close = false;
      for (let m = 0; m < secs.length; m++) {
        if (m !== k && Math.abs(secs[k] - secs[m]) * scale < cubeH) { close = true; break; }
      }

      const dy = close ? -offset * up : 0;
      const cy = axisDy + dy;

      const arr = s.isFts ? PALETTE.FTS
        : s.status === 'solved' ? PALETTE.SOLVED
        : s.status === 'failed' ? PALETTE.FAILED : PALETTE.PENDING;
      const base = arr[K_MID];
      if (s.recent) {
        // MyGradientPaint(c → darker(c, 0.55))，竖向
        const grad = ctx.createLinearGradient(0, cy - cubeH / 2, 0, cy + cubeH / 2);
        grad.addColorStop(0, css(base));
        grad.addColorStop(1, css([Math.round(base[0] * 0.55), Math.round(base[1] * 0.55), Math.round(base[2] * 0.55)]));
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = css(base);
      }
      roundRectPath(ctx, x, cy - cubeH / 2, cubeH, cubeH, Math.max(2, Math.floor(cubeH / 6)));
      ctx.fill();

      if (s.isFts) {
        ctx.strokeStyle = 'rgb(0,230,0)';
        ctx.lineWidth = 2;
        roundRectPath(ctx, x, cy - cubeH / 2, cubeH, cubeH, Math.max(2, Math.floor(cubeH / 6)));
        ctx.stroke();
        ctx.lineWidth = 1;
      }

      ctx.fillStyle = '#fff';
      // ShadedRectangle 里标签走 drawFit；这里直接压到方块高的 0.7，避免溢出
      ctx.font = `bold ${Math.floor(Math.min(L.cubeFontPx, cubeH * 0.7))}px ${FAMILY}`;
      ctx.fillText(s.label || '', x + cubeH / 2, cy + 1);

      if (close) up = -up; else up = 1;
    }

    ctx.restore();
  }

  // ④ 封榜竖线 + 当前时间竖线（画在行之上）
  if (times.freezeMs > 0) {
    const ct = getX(times.duration - times.freezeMs);
    ctx.strokeStyle = FREEZE_COLOR;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ct, 0);
    ctx.lineTo(ct, rows.length * rowH);
    ctx.stroke();
  }

  const nowX = getX(Math.max(0, Math.min(times.elapsed, times.duration)));
  ctx.strokeStyle = BLUE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(nowX, 0);
  ctx.lineTo(nowX, rows.length * rowH);
  ctx.stroke();
  ctx.lineWidth = 1;

  ctx.restore();

  // paintLegend：右下角
  drawLegend(ctx, W, H, 230);   // TimelinePresentation.paintLegend:202 —— height-230
}
