/* 按过题数分档的瓦片榜 —— TileRankScoreboardPresentation 移植
 *
 * 源码：
 *   tile/AbstractTileScoreboardPresentation.java   DEFAULT_ROWS=14 / COLUMNS=2 / H_GAP=10 / V_GAP=3
 *   tile/ScrollingTileScoreboardPresentation.java  Header.LEFT 时 margin = (H-(rows-1)*V_GAP)*1.3/rows
 *                                                  纵向滚动：INITIAL_DELAY_MS=5000, MS_PER_SCREEN=10000
 *   tile/TileRankScoreboardPresentation.java       按 numSolved 分组，组间 RANK_GAP=0.25 行
 *   tile/TeamTileHelper.java                       TILE_BG=rgb(50,50,50)，team/rank = BOLD size*1.4
 *
 * 版面：
 *   ┌──┬────────────────────┬────────────────────┐
 *   │ 7│ 1 队名A  [格子…]   │ 2 队名B  [格子…]   │   ← 一组 = 同一个过题数
 *   │  │ 3 队名C  [格子…]   │                    │
 *   ├──┼────────────────────┼────────────────────┤
 *   │ 6│ 4 队名D  [格子…]   │ 5 队名E  [格子…]   │
 *   └──┴────────────────────┴────────────────────┘
 *   左侧深灰条里是过题数，占了不止一行时下面补一行小字 "solved"
 */

import { PALETTE, css, metrics, widthOf, roundRectPath } from './judge-canvas.js';
import { Animator, Movement } from './judge-queue.js';

export const TILE_H_GAP = 10;
export const TILE_V_GAP = 3;
export const DEFAULT_ROWS = 14;
export const DEFAULT_COLUMNS = 2;
export const RANK_GAP = 0.25;

export const INITIAL_DELAY_MS = 5000;
export const MS_PER_SCREEN = 10000;

const FAMILY = '"ICPCFont", Arial, "Microsoft YaHei", sans-serif';
const pf = (px, bold) => `${bold ? 'bold' : 'normal'} ${px}px ${FAMILY}`;

const TILE_BG = [50, 50, 50];
const LIGHT_GRAY = [192, 192, 192];

/** AbstractTileScoreboardPresentation.createTileHelper + ScrollingTile.setSize */
export function tileLayout(W, H, rows = DEFAULT_ROWS, columns = DEFAULT_COLUMNS) {
  // Header.LEFT 分支：margin 用 1.3
  const margin = Math.trunc(((H - (rows - 1) * TILE_V_GAP) * 1.3) / rows);
  const tileW = Math.trunc((W - (columns - 1) * TILE_H_GAP - margin) / columns);
  const tileH = Math.trunc((H - (rows - 1) * TILE_V_GAP) / rows);

  const dpi = 96;
  const size = (tileH * 36 * 0.95) / dpi;

  return {
    W, H, rows, columns, margin, tileW, tileH,
    numFont: pf(size * 1.9, true),        // TileRankScoreboardPresentation.numFont
    solvedFont: pf(size * 0.85, false),   // solvedFont
    teamFont: pf(size * 1.4, true),       // TeamTileHelper.teamFont
    rankFont: pf(size * 1.4, true),       // rankFont
    problemFont: pf(size * 0.45, false),  // problemFont
    size,
  };
}

/**
 * TileRankScoreboardPresentation.updateTeamTargets
 * 按过题数分组，组内先竖铺满一列再换列（x = floor(k/numRows), y = k % numRows）
 */
export function buildGroups(sortedRows, columns = DEFAULT_COLUMNS) {
  const groups = [];
  let i = 0;
  let y = 0;

  while (i < sortedRows.length) {
    const numSolved = sortedRows[i].solved;
    let j = i;
    while (j < sortedRows.length && sortedRows[j].solved === numSolved) j++;

    const groupSize = j - i;
    const numRows = Math.ceil(groupSize / columns);

    const g = { y, numSolved, numRows, teams: [] };
    for (let k = 0; k < groupSize; k++) {
      g.teams.push({
        row: sortedRows[i + k],
        col: Math.floor(k / numRows),
        rowInGroup: k % numRows,
      });
    }

    groups.push(g);
    y += numRows + RANK_GAP;
    i = j;
  }
  return groups;
}

/** getNumRows（TileRank 版）= ceil(teams/columns) + 3 */
export function totalTileRows(teamCount, columns = DEFAULT_COLUMNS) {
  return Math.ceil(teamCount / columns) + 3;
}

/** 一轮循环时长：INITIAL_DELAY_MS + MS_PER_SCREEN * (总行数 / 每屏行数) */
export function tileRepeat(teamCount, rows = DEFAULT_ROWS, columns = DEFAULT_COLUMNS) {
  return INITIAL_DELAY_MS + Math.trunc(MS_PER_SCREEN * (totalTileRows(teamCount, columns) / rows));
}

/** 滚动位置（屏数 → 像素） */
export function scrollOffset(tMs, H, rows = DEFAULT_ROWS, columns = DEFAULT_COLUMNS, teamCount = 0) {
  if (tMs <= INITIAL_DELAY_MS) return 0;
  const screens = (tMs - INITIAL_DELAY_MS) / MS_PER_SCREEN;
  const max = Math.max(0, totalTileRows(teamCount, columns) / rows - 1);
  return Math.min(screens, max) * H;
}

/** 单个队伍瓦片（TeamTileHelper.paintTile 的简化版） */
function drawTile(ctx, L, x, y, r, probs) {
  const { tileW, tileH } = L;
  const arc = Math.trunc(tileW / 40);

  ctx.save();
  ctx.translate(x, y);

  // 底色
  ctx.fillStyle = css(TILE_BG);
  roundRectPath(ctx, 0, 0, tileW, tileH, arc);
  ctx.fill();

  const pad = Math.trunc(tileH * 0.12);
  const fmRank = metrics(ctx, L.rankFont);
  const rankW = widthOf(ctx, L.rankFont, '199');

  // 名次（左上）
  ctx.font = L.rankFont;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  const rank = String(r.rank);
  ctx.fillText(rank, pad + (rankW - widthOf(ctx, L.rankFont, rank)) / 2, pad + fmRank.asc);

  // 队名：超宽缩字号（和总榜 drawFit 一致）
  const nameX = pad + rankW + pad;
  const nameAvail = tileW - nameX - pad - widthOf(ctx, L.teamFont, '999');
  const name = String(r.team.name || '');
  const nw = widthOf(ctx, L.teamFont, name);
  const nameFs = nw > nameAvail && nameAvail > 0
    ? Math.max(L.size * 1.4 * 0.55, (L.size * 1.4 * nameAvail) / nw)
    : L.size * 1.4;
  ctx.font = pf(nameFs, true);
  ctx.fillStyle = '#fff';
  ctx.fillText(name, nameX, pad + fmRank.asc);

  // 右侧：solved / 罚时
  const fmP = metrics(ctx, L.problemFont);
  ctx.font = L.problemFont;
  ctx.textAlign = 'right';
  if (r.solved > 0) {
    ctx.fillText(String(r.solved), tileW - pad, pad + fmRank.asc);
  }
  if (r.penalty > 0) {
    ctx.fillText(String(Math.floor(r.penalty / 60)), tileW - pad, pad + fmRank.asc + fmP.height);
  }

  // 题目格子
  const cubeH = Math.trunc(tileH * 0.32);
  const cubeGap = 3;
  const avail = tileW - pad * 2;
  const cubeW = Math.min(
    Math.trunc((avail - cubeGap * (probs.length - 1)) / Math.max(1, probs.length)),
    Math.trunc(cubeH * 1.6)
  );
  const cubeTop = tileH - pad - cubeH;

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let p = 0; p < probs.length; p++) {
    const c = r.cells ? r.cells[p] : null;
    const cx = pad + p * (cubeW + cubeGap);
    if (cx + cubeW > tileW - pad) break;

    let bg = [40, 40, 40];
    let text = probs[p].label || '';
    let tc = 'rgba(196,196,196,0.69)';
    let fs = L.problemFont;
    let outline = null;

    if (c && c.solvedAt !== null) {
      bg = c.isFTS ? PALETTE.FTS[5] : PALETTE.SOLVED[5];
      tc = '#fff';
      text = `${c.subs}\u200A-\u200A${Math.floor(c.solvedAt / 60)}`;
      if (c.isFTS) outline = PALETTE.SOLVED_COLOR;
    } else if (c && c.pending) {
      bg = PALETTE.PENDING[5];
      tc = '#fff';
      text = `${c.subs}\u200A-\u200A${Math.floor(c.lastAt / 60)}`;
    } else if (c && c.subs) {
      bg = PALETTE.FAILED[5];
      tc = '#fff';
      text = `${c.subs}\u200A-\u200A${Math.floor(c.lastAt / 60)}`;
    }

    const arc2 = Math.trunc(cubeW / 10);
    ctx.fillStyle = c && (c.solvedAt !== null || c.pending || c.subs) ? css(bg) : css(bg);
    roundRectPath(ctx, cx, cubeTop, cubeW, cubeH, arc2);
    ctx.fill();

    if (outline) {
      ctx.strokeStyle = css(outline);
      ctx.lineWidth = 2;
      roundRectPath(ctx, cx, cubeTop, cubeW, cubeH, arc2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }

    ctx.fillStyle = tc;
    ctx.font = fs;
    ctx.fillText(text, cx + cubeW / 2, cubeTop + cubeH / 2);
  }

  ctx.restore();
}

/**
 * 画一帧
 * @param groups  buildGroups 的结果
 * @param probs   题目数组
 * @param scrollPx 纵向滚动像素
 */
export function drawTileRank(ctx, L, groups, probs, scrollPx, opts = {}) {
  const { W, H, tileW, tileH } = L;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  ctx.save();
  ctx.translate(0, -scrollPx);

  // 左侧过题数条 + 数字
  const barW = L.margin - TILE_H_GAP;
  const barArc = Math.trunc(tileW / 60);

  for (const g of groups) {
    const barY = g.y * (tileH + TILE_V_GAP);
    const barH = g.numRows * (tileH + TILE_V_GAP) - TILE_V_GAP;
    if (barY + barH < scrollPx || barY > scrollPx + H) continue;

    ctx.fillStyle = css(TILE_BG);
    roundRectPath(ctx, 0, barY, barW, barH, barArc);
    ctx.fill();

    const fm = metrics(ctx, L.numFont);
    const s = String(g.numSolved);
    ctx.font = L.numFont;
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(s, barW / 2, barY + fm.asc + TILE_V_GAP * 2);

    if (g.numRows > 1) {
      const fm2 = metrics(ctx, L.solvedFont);
      ctx.font = L.solvedFont;
      ctx.fillStyle = css(LIGHT_GRAY);
      ctx.fillText('solved', barW / 2, barY + fm.asc + fm2.asc + TILE_V_GAP * 4);
    }
  }

  // 瓦片
  for (const g of groups) {
    for (const t of g.teams) {
      const tx = L.margin + t.col * (tileW + TILE_H_GAP);
      const ty = (g.y + t.rowInGroup) * (tileH + TILE_V_GAP);
      if (ty + tileH < scrollPx || ty > scrollPx + H) continue;
      drawTile(ctx, L, tx, ty, t.row, probs);
    }
  }

  ctx.restore();

  // 源码的 tile 类不画标题（getTitle 只在 TitledPresentation 里用），这里不画
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}
