/* First to Solve 榜单 —— FirstToSolvePresentation 移植
 *
 * 源码 scoreboard/FirstToSolvePresentation.java
 *
 * 行为：
 *   - fts 列表记录「已经上榜的题目 id」，按上榜先后顺序
 *   - 一行 = 一道题的首杀提交
 *   - 首杀的 target 行号 = fts.indexOf(problemId)  ← 按上榜顺序排，不按题号
 *   - 不是首杀的提交：停留 TIME_TO_KEEP_SOLVED=8000 后滑到 teamsPerScreen*2 并移除
 *   - 表头：Time / Name / Problem
 */

import { PALETTE, css, metrics, widthOf, roundRectPath, cellPaint, judgeLayout, BORDER, CUBE_INSET, ROWS } from './judge-canvas.js';
import { Animator, Movement } from './judge-queue.js';

/** AbstractScoreboardPresentation.ROW_MOVEMENT —— 注意和判题队列的 (5,9) 不同 */
export const ROW_MOVEMENT = new Movement(4, 7);

export const TIME_TO_KEEP_SOLVED = 8000;
const TEAMS_PER_SCREEN = 12;

const FAMILY = '"ICPCFont", Arial, "Microsoft YaHei", sans-serif';

/** ContestUtil.getTime：毫秒 → 整数分钟 */
function getTime(ms) {
  return String(Math.floor(ms / 60000));
}

/**
 * FirstToSolvePresentation 的状态机（去掉监听器，改成外部喂数据）
 */
export class FtsQueue {
  constructor(opts = {}) {
    this.records = [];
    this.fts = [];                       // 已上榜的 problem id，按顺序
    this.opts = opts;                    // { judged(sub), isFts(sub) }
    this.timeToKeepSolved = opts.timeToKeepSolved > 0 ? opts.timeToKeepSolved : TIME_TO_KEEP_SOLVED;
  }

  has(problemId) {
    return this.fts.includes(problemId);
  }

  /** handleFTS：首杀才上榜，同一题只上一次 */
  handleFts(problemId, isFts, judged) {
    if (!judged || !isFts) return false;
    if (this.has(problemId)) return false;
    this.fts.push(problemId);
    return true;
  }

  /** handleSubmission：没有就新建一行，起点在屏幕下方 */
  handle(sub) {
    const ex = this.records.find(r => r.submission.id === sub.id);
    if (ex) { ex.submission = sub; return ex; }

    let target = 0;
    if (this.records.length > 0) {
      target = Math.min(this.records[this.records.length - 1].anim.getValue() + 1, TEAMS_PER_SCREEN * 2);
    }
    const sr = {
      submission: sub,
      anim: new Animator(Math.max(target, TEAMS_PER_SCREEN + 2), ROW_MOVEMENT),
      age: 0,
    };
    this.records.push(sr);
    return sr;
  }

  /** updateRecords */
  update(dt, force = false) {
    const remove = [];
    let count = this.fts.length;

    for (const sr of this.records) {
      const judged = this.opts.judged ? this.opts.judged(sr.submission) : false;
      const isFts = this.opts.isFts ? this.opts.isFts(sr.submission) : false;

      let target = count;
      if (judged && isFts) {
        target = this.fts.indexOf(sr.submission.problem_id);
      } else if (sr.age > this.timeToKeepSolved) {
        target = TEAMS_PER_SCREEN * 2;
      } else if (count < TEAMS_PER_SCREEN * 2) {
        count++;
      }

      if (force) {
        sr.anim.reset(target);
      } else {
        sr.anim.setTarget(target);
        sr.anim.incrementTimeMs(dt);
      }

      if (judged && !isFts) {
        sr.age += dt;
        if (sr.age > this.timeToKeepSolved && sr.anim.getValue() > TEAMS_PER_SCREEN) {
          remove.push(sr);
        }
      }
    }

    for (const r of remove) {
      const i = this.records.indexOf(r);
      if (i >= 0) this.records.splice(i, 1);
    }
  }
}

/** 表头：Time / Name / Problem */
function drawHeaderBand(ctx, L, w) {
  const { W, headerH, titleH, rowH } = L;
  const top = titleH;

  ctx.fillStyle = '#000';
  ctx.fillRect(0, top, W, headerH + 2);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, top + headerH - 1, W, 1);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#fff';
  ctx.font = L.headerFont;

  const y = top + headerH - 3;
  const hw = s => widthOf(ctx, L.headerFont, s);
  ctx.fillText('Time', BORDER + (w.w199 - hw('Time')) / 2, y);
  ctx.fillText('Name', BORDER + w.w199sp + rowH, y);
  ctx.fillText('Problem', W - BORDER - (w.w9999 + hw('Problem')) / 2, y);
}

/**
 * 渲染一帧。行顺序 = records 顺序（先上榜的在前）
 * rows: [{ y, timeText, teamName, problemLabel, probs, currentIndex, currentStatus, currentText }]
 */
export function drawFtsFrame(ctx, L, rows, times, opts = {}) {
  const { W, H, headerH, titleH, rowH, cubeW, cubeH } = L;
  const contentTop = titleH + headerH;
  const contentH = H - contentTop;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // 表头先画，标题后画（否则 50px 的标题被 21px 的黑条切掉一半）
  const fr = L.rowFont;
  const w199 = widthOf(ctx, fr, '199');
  const w199sp = widthOf(ctx, fr, '199 ');
  const w9999 = widthOf(ctx, fr, '9999');
  drawHeaderBand(ctx, L, { w199, w199sp, w9999 });

  const clockM = metrics(ctx, L.clockFont);
  const titleM = metrics(ctx, L.titleFont);

  ctx.textAlign = 'center';
  ctx.fillStyle = opts.frozen ? css(PALETTE.YELLOW) : '#fff';
  ctx.font = L.clockFont;
  ctx.fillText(times.elapsedText, W / 12, clockM.asc + 2);
  ctx.fillText(times.remainText, (W * 11) / 12, clockM.asc + 2);

  ctx.fillStyle = '#fff';
  ctx.font = L.titleFont;
  ctx.fillText('First to Solve', W / 2, titleM.asc);

  // 内容区
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, contentTop, W, contentH);
  ctx.clip();
  ctx.translate(0, contentTop);

  // 偶数行背景
  for (let i = 0; i < ROWS; i += 2) {
    ctx.fillStyle = 'rgb(60,60,60)';
    ctx.fillRect(0, i * rowH, W, rowH);
  }

  // 已上榜题目数与未上榜区之间的分隔线（源码 paintImpl:? size>0 时画白线）
  const nFts = opts.ftsCount || 0;
  if (nFts > 0) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, nFts * rowH, W, 1);
  }

  const rowM = metrics(ctx, fr);
  const indent = BORDER + w199sp + rowH;
  const cubeDy = Math.trunc(rowH / 2) + Math.trunc(CUBE_INSET / 2) + 3;
  const nameBaseline = rowM.asc + 5;
  const textImageY = 5 + rowM.asc;

  for (const r of rows) {
    const y = (r.y !== undefined ? r.y : 0) * rowH;
    if (y >= contentH) continue;

    ctx.save();
    ctx.globalAlpha = r.alpha === undefined ? 1 : r.alpha;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';

    // 时间（分钟）
    ctx.font = L.rowItalicsFont;
    ctx.fillStyle = '#fff';
    ctx.fillText(r.timeText, BORDER + (w199 - widthOf(ctx, L.rowItalicsFont, r.timeText)) / 2, y + textImageY);

    // 队名
    const nameX = BORDER + w199sp + rowH;
    const avail = W - BORDER * 2 - widthOf(ctx, fr, '199 9 9999') - rowH;
    let fs = L.size * 1.25;
    const nw = widthOf(ctx, `bold ${fs}px ${FAMILY}`, r.teamName || '');
    if (nw > avail && nw > 0) fs = Math.max(fs * 0.5, (fs * avail) / nw);
    ctx.font = `bold ${fs}px ${FAMILY}`;
    ctx.fillStyle = '#fff';
    ctx.fillText(r.teamName || '', nameX, y + nameBaseline);

    // 题目格子
    const cubeTop = y + cubeDy;
    for (let j = 0; j < r.probs.length; j++) {
      const xx = indent + j * (cubeW + CUBE_INSET);
      if (j === r.currentIndex) {
        // 首杀必然 solved → 用 FTS 暗绿 + 亮绿描边；time 恒传 0（同 JudgePresentation）
        const p = cellPaint(r.currentStatus, r.currentRecent !== false, true, 0);
        if (p.solid) {
          ctx.fillStyle = p.solid;
        } else {
          const g = ctx.createLinearGradient(0, cubeTop, 0, cubeTop + cubeH);
          g.addColorStop(0, p.top);
          g.addColorStop(1, p.bottom);
          ctx.fillStyle = g;
        }
        roundRectPath(ctx, xx, cubeTop, cubeW, cubeH);
        ctx.fill();

        ctx.strokeStyle = css(PALETTE.SOLVED_COLOR);
        ctx.lineWidth = 1.5;
        roundRectPath(ctx, xx + 0.75, cubeTop + 0.75, cubeW - 1.5, cubeH - 1.5);
        ctx.stroke();
        ctx.lineWidth = 1;

        ctx.fillStyle = '#fff';
        ctx.font = L.statusFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(r.currentText || '', xx + cubeW / 2, cubeTop + cubeH / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      } else {
        ctx.fillStyle = 'rgb(40,40,40)';
        roundRectPath(ctx, xx, cubeTop, cubeW, cubeH);
        ctx.fill();
        ctx.fillStyle = 'rgba(196,196,196,0.686)';
        ctx.font = L.problemFont;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(r.probs[j].label || '', xx + cubeW / 2, cubeTop + cubeH / 2);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
      }
    }

    // 右侧题目 label
    ctx.font = fr;
    ctx.fillStyle = '#fff';
    ctx.fillText(r.problemLabel, W - BORDER - (w9999 + widthOf(ctx, fr, r.problemLabel)) / 2, y + textImageY);

    ctx.restore();
  }

  ctx.restore();
}

export { TEAMS_PER_SCREEN, judgeLayout, getTime };
