/* Scorewall —— CCS 数据层 + 总榜视图
 *
 * 用法：index.html?src=http://127.0.0.1:8081/api/contests/144333&view=standings
 *
 * 设计约束（见 docs/pitfalls.md「保活」）：
 *   - 渲染由 SSE 消息驱动，不用 setInterval 轮询
 *   - 断线由 EventSource 自动重连；重连后服务端重发全量，天然恢复
 *   - 超过 30s 没消息就在顶部提示，让运维看得见
 */
'use strict';

import { rel2sec, fmtClock, computeStandings, resolveUrl } from './scoring.js';
import { makeLayout, drawFrame, MS_PER_PAGE, SCROLL_MS } from './standings-canvas.js?v=3';
import { drawCountdown } from './countdown-canvas.js';
import { makeState, freezeAtSec, isJudgementHidden } from './state.js';
import { judgeLayout, drawJudgeFrame, seedRows, rowOf } from './judge-canvas.js';
import { JudgeQueue, TEAMS_PER_SCREEN } from './judge-queue.js';
import { problemLayout, drawProblemFrame, problemStats, problemRepeat, makeColorFn } from './problem-canvas.js';
import { makeProblemChart, CHART_REPEAT } from './chart-canvas.js';
import { FtsQueue, drawFtsFrame } from './fts-canvas.js';

const Q = new URLSearchParams(location.search);
const SRC = (Q.get('src') || 'http://127.0.0.1:8081/api/contests/144333').replace(/\/$/, '');
const VIEW = Q.get('view') || 'standings';
/** AbstractScoreboardPresentation.setNumRows() —— 行数直接决定字号（源码支持 rows: 属性） */
const ROWS_PARAM = Math.max(1, Number(Q.get('rows')) || 12);



// ---------------- CCS 模型（单一数据源） ----------------
const M = {
  contest: {},
  teams: new Map(),      // id -> team
  problems: new Map(),   // id -> problem
  submissions: new Map(),// id -> submission
  judgements: new Map(), // id -> judgement
  orgs: new Map(),
  startStatus: new Map(),
  judgementTypes: new Map(),
  state: null,
  info: {},
};

function apply(type, id, data) {
  const bag = BAGS[type];
  if (!bag) return;
  if (type === 'judgements' || type === 'judgement-types') judgeDirty = true;
  if (data == null) { bag.delete(id); return; }
  bag.set(id, data);
}

/** submission_id -> 'solved' | 'failed'；只有带 judgement_type_id 的 judgement 才算已判 */
const judgeStatus = new Map();
let judgeDirty = true;

/** 重建 judgeStatus（judgements 或 judgement-types 变化时才跑） */
function syncJudgeStatus() {
  if (!judgeDirty) return;
  judgeDirty = false;
  judgeStatus.clear();
  for (const j of M.judgements.values()) {
    if (!j.submission_id || !j.judgement_type_id) continue;
    const jt = M.judgementTypes.get(j.judgement_type_id);
    if (!jt) continue;
    if (jt.solved) judgeStatus.set(j.submission_id, 'solved');
    else if (jt.penalty) judgeStatus.set(j.submission_id, 'failed');
  }
  judgeFtsKey = -1;          // 状态变了，FTS 也要重算
}

/** 首次通过的提交 id（每道题最早 AC 的那条）—— 源码 contest.isFirstToSolve() */
let judgeFts = new Set();
let judgeFtsKey = -1;

function syncJudgeFts() {
  if (judgeFtsKey === M.judgements.size) return;
  judgeFtsKey = M.judgements.size;
  judgeFts = new Set();
  const best = new Map();          // problem_id -> { sec, id }
  for (const s of M.submissions.values()) {
    if (judgeStatus.get(s.id) !== 'solved') continue;
    const sec = rel2sec(s.contest_time);
    const cur = best.get(s.problem_id);
    if (!cur || sec < cur.sec) best.set(s.problem_id, { sec, id: s.id });
  }
  for (const v of best.values()) judgeFts.add(v.id);
}

const BAGS = {
  contest: { set: (k, v) => Object.assign(M.contest, v), delete: () => {} },
  teams: M.teams,
  problems: M.problems,
  submissions: M.submissions,
  judgements: M.judgements,
  organizations: M.orgs,
  'start-status': M.startStatus,
  'judgement-types': M.judgementTypes,
};

// ---------------- 时间 ----------------
/** 时长与封榜时长（毫秒），来源 info.scoreboard_freeze_duration */
function durationMs() {
  const d = String(M.contest.duration || '5:00:00').split(':');
  return (+d[0] * 3600 + +d[1] * 60 + (+d[2] || 0)) * 1000;
}
function freezeMs() {
  const v = M.contest.scoreboard_freeze_duration || M.info.scoreboard_freeze_duration;
  if (!v) return null;
  if (typeof v === 'number') return v * 1000;
  const d = String(v).split(':');
  return (+d[0] * 3600 + +d[1] * 60 + (+d[2] || 0)) * 1000;
}
function syncContestExtras() {
  try {
    const one = p => fetch(`${SRC}/${p}`).then(r => r.ok ? r.json() : null).catch(() => null);
    one('').then(c => { if (c && c.scoreboard_freeze_duration) M.contest.scoreboard_freeze_duration = c.scoreboard_freeze_duration; });
  } catch (_) {}
}

/** 已用时 / 剩余时间（毫秒） */
function contestTimes() {
  const c = M.contest;
  const start = c.start_time ? Date.parse(c.start_time) : Date.now();
  const d = String(c.duration || '5:00:00').split(':');
  const dur = (+d[0] * 3600 + +d[1] * 60 + (+d[2] || 0)) * 1000;
  const now = Date.now();
  return { elapsed: now - start, remain: start + dur - now };
}

// ---------------- 布局（AbstractScoreboardPresentation.setup） ----------------
const ROWS = 12, CUBE_INSET = 5, BORDER = 8;

function metrics(W, H, nProb) {
  const headerH = Math.floor(H / 50);
  const titleH = Math.floor(H / 30);
  const rowH = (H - headerH - titleH) / ROWS;
  const base = rowH * 36 * 0.95 / 96;
  const cubeH = Math.floor(rowH / 2.5) - CUBE_INSET;
  let cubeW = Math.floor(((rowH / 1.8) - CUBE_INSET) * 10);
  while (cubeW > 30 && (cubeW + CUBE_INSET) * nProb > W - rowH * 3 - 70) cubeW -= 2;
  return {
    W, H, headerH, titleH, rowH, cubeH, cubeW,
    rowFont: base * 1.25,
    statusFont: base * 0.7,
    problemFont: base * 0.5,
    titleFont: (H * 0.021) * 2.2,
    clockFont: (H * 0.021) * 1.25,
    headerFont: Math.min(H * 0.021, base * 0.85),
  };
}

function applyVars(pane, m) {
  const s = pane.style;
  s.setProperty('--w', m.W + 'px');
  s.setProperty('--title-h', m.titleH + 'px');
  s.setProperty('--header-h', m.headerH + 'px');
  s.setProperty('--row-h', m.rowH + 'px');
  s.setProperty('--content-h', (m.H - m.titleH - m.headerH) + 'px');
  s.setProperty('--cube-h', m.cubeH + 'px');
  s.setProperty('--row-fs', m.rowFont + 'px');
  s.setProperty('--status-fs', m.statusFont + 'px');
  s.setProperty('--problem-fs', m.problemFont + 'px');
  s.setProperty('--title-fs', m.titleFont + 'px');
  s.setProperty('--clock-fs', m.clockFont + 'px');
  s.setProperty('--header-fs', m.headerFont + 'px');
}

// 文字宽度测量（等价 FontMetrics.stringWidth）
const mctx = document.createElement('canvas').getContext('2d');
function textW(s, px, bold = true) {
  mctx.font = `${bold ? 'bold ' : ''}${px}px Arial, "Helvetica Neue", "Microsoft YaHei", sans-serif`;
  return mctx.measureText(String(s)).width;
}
function fitFont(s, px, avail, min = 0.55) {
  const w = textW(s, px);
  return w <= avail ? px : Math.max(px * min, px * avail / w);
}

// ---------------- 总榜视图（canvas） ----------------
const scroll = { page: 0, lastSwitch: 0, from: 0, to: 0, animStart: 0 };
const shownAt = performance.now();
const FORCE_PAGE = Q.get('page') !== null ? parseInt(Q.get('page'), 10) : null;
const FORCE_FADE = Q.get('fade') !== null ? Math.max(0, Math.min(1, parseFloat(Q.get('fade')))) : null;
const FADE_IN_MS = 800;

function ensureCanvas(pane) {
  let c = pane.querySelector('canvas');
  if (!c) {
    pane.innerHTML = '';
    c = document.createElement('canvas');
    c.style.cssText = 'width:100%;height:100%;display:block';
    pane.appendChild(c);
  }
  const dpr = window.devicePixelRatio || 1;
  const W = pane.clientWidth, H = pane.clientHeight;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
  }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, W, H };
}

function perProblemStats(data) {
  return data.probs.map((_, i) => {
    let pending = 0, solved = 0;
    for (const r of data.rows) {
      const c = r.cells[i];
      if (!c) continue;
      if (c.solvedAt !== null) solved++;
      else if (c.pending) pending++;
    }
    return { pending, solved };
  });
}

function renderStandings(pane, data) {
  const { ctx, W, H } = ensureCanvas(pane);
  if (!W || !H) return;

  const L = makeLayout(W, H, data.probs.length);
  const t = contestTimes();
  const times = {
    elapsedText: fmtClock(t.elapsed, true),
    remainText: fmtClock(t.remain, true),
  };

  // ---- 对齐 AbstractScrollingScoreboardPresentation ----
  // MS_PER_PAGE=12000  FADE_IN_MS=1000  INITIAL_DELAY_MS=3000  FADE_OUT_MS=1000
  // getRepeat() = MS_PER_PAGE * pages + INITIAL_DELAY_MS + FADE_OUT_MS
  // getNumPages() = (teams + teamsPerScreen) / teamsPerScreen   ← 整数除
  const FADE_IN_MS = 1000, INITIAL_DELAY_MS = 3000, FADE_OUT_MS = 1000, HOLD_MS = 1000;
  const pages = Math.max(1, Math.floor((data.rows.length + 12) / 12));
  const now = performance.now();
  // 一轮 = 各页 + 首屏停留 + 淡出 + 黑屏停留（Java 那边淡出后由播放器切走，这里原地停一拍）
  const cycle = MS_PER_PAGE * pages + INITIAL_DELAY_MS + FADE_OUT_MS + HOLD_MS;
  const tt = (now - shownAt) % cycle;

  if (FORCE_PAGE !== null && FORCE_PAGE >= 0 && FORCE_PAGE < pages) {
    drawFrame(ctx, L, data.rows, data.probs, times,
      FORCE_PAGE * 12 * L.rowH, perProblemStats(data), 1);
    return;
  }

  // 淡入 → 停留 → 淡出
  const endTime = MS_PER_PAGE * pages + INITIAL_DELAY_MS;
  let fade = 1;
  if (tt < FADE_IN_MS) fade = tt / FADE_IN_MS;
  else if (tt > endTime) fade = Math.max(0, 1 - (tt - endTime) / FADE_OUT_MS);

  // 翻页：ScrollAnimator.getScroll() 的逐行照抄
  // 滚动跨页边界发生（提前 scrollTime/2、延后 scrollTime/2），用 smoothImpl 插值
  function f(x) {
    if (x < 0) return -Math.exp(1 / x);
    if (x === 0) return 0;
    return Math.exp(-1 / x);
  }
  function smoothImpl(x) {
    const a = f(x), b = f(1 - x);
    return a / (a + b);
  }
  function getScroll(time) {
    const SCROLL_TIME = SCROLL_MS;                     // 1500
    if (time < INITIAL_DELAY_MS + SCROLL_TIME / 2) return 0;
    let t2 = time - INITIAL_DELAY_MS;
    const page = Math.floor(t2 / MS_PER_PAGE);
    t2 -= page * MS_PER_PAGE;
    if (t2 < SCROLL_TIME / 2)
      return page - smoothImpl(0.5 - t2 / SCROLL_TIME);
    if (t2 > MS_PER_PAGE - SCROLL_TIME / 2)
      return page + smoothImpl(0.5 - (MS_PER_PAGE - t2) / SCROLL_TIME);
    return page;
  }

  const scrollPages = pages > 1 ? Math.max(0, getScroll(tt)) : 0;
  const scrollPx = Math.min(scrollPages, pages - 1) * 12 * L.rowH;

  const alpha = FORCE_FADE !== null ? FORCE_FADE : Math.max(0, Math.min(1, fade));
  drawFrame(ctx, L, data.rows, data.probs, times, scrollPx, perProblemStats(data), alpha,
    { frozen: !!(M.state && M.state.isFrozen()) });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---------------- 主循环：SSE 驱动 ----------------
const paneA = document.getElementById('paneA');
const paneB = document.getElementById('paneB');
const hint = document.getElementById('hint');
let lastMsg = Date.now();
let dirty = true;

// 出错时把信息显示到页面上（无头截图也能看到）
window.addEventListener('error', ev => {
  const h = document.getElementById('hint');
  h.textContent = 'JS 错误: ' + (ev.message || ev.error);
  h.classList.add('show');
});
window.addEventListener('unhandledrejection', ev => {
  const h = document.getElementById('hint');
  h.textContent = 'Promise 错误: ' + (ev.reason && ev.reason.message || ev.reason);
  h.classList.add('show');
});

function layout() {
  if (VIEW === 'standings' || VIEW === 'judge' || VIEW === 'countdown'
    || VIEW === 'problems' || VIEW === 'chart' || VIEW === 'fts') {
    paneA.style.display = 'block';
    paneB.classList.add('hidden');
  }
}

function draw() {
  if (VIEW === 'countdown') { renderCountdown(paneA); dirty = false; return; }
  if (VIEW === 'judge') { renderJudge(paneA); dirty = false; return; }
  if (VIEW === 'problems') { renderProblems(paneA); dirty = false; return; }
  if (VIEW === 'chart') { renderChart(paneA); dirty = false; return; }
  if (VIEW === 'fts') { renderFts(paneA); dirty = false; return; }
  // 有滚动动画，必须每帧重画（对齐 Java 的立即模式）
  const at = freezeAtSec(durationMs(), freezeMs());
  const data = computeStandings(M, {
    hideJudgement: sub => isJudgementHidden(M.state, rel2sec(sub.contest_time), at),
  });
  renderStandings(paneA, data);
  dirty = false;
}

/** #56 判题队列（JudgePresentation 状态机） */
let judgeQ = null, judgeSeen = new Set(), judgeLast = 0, judgePrimed = false;

function judgeQueue() {
  if (judgeQ) return judgeQ;
  judgeQ = new JudgeQueue({
    judged: sub => judgeStatus.has(sub.id),
    solved: sub => judgeStatus.get(sub.id) === 'solved',
    frozen: () => !!(M.state && M.state.isFrozen()),
    // 源码 JudgePresentation:34-37：AC 停 11s、WA 停 8s、淡出 2s
    timeToKeepSolved: Q.has('keepSolved') ? Number(Q.get('keepSolved')) : undefined,
    timeToKeepFailed: Q.has('keepFailed') ? Number(Q.get('keepFailed')) : undefined,
    timeToFadeRecent: Q.has('fadeRecent') ? Number(Q.get('fadeRecent')) : undefined,
    teamsPerScreen: ROWS_PARAM,
  });
  return judgeQ;
}

function renderJudge(pane) {
  const { ctx, W, H } = ensureCanvas(pane);
  if (!W || !H) return;

  const at = freezeAtSec(durationMs(), freezeMs());
  const data = computeStandings(M, {
    hideJudgement: sub => isJudgementHidden(M.state, rel2sec(sub.contest_time), at),
  });
  const L = judgeLayout(W, H, data.probs.length, ROWS_PARAM);
  const t = contestTimes();
  const times = { elapsedText: fmtClock(t.elapsed, true), remainText: fmtClock(t.remain, true) };
  const frozen = !!(M.state && M.state.isFrozen());
  const now = performance.now();

  syncJudgeStatus();
  syncJudgeFts();
  const elapsedSec = Math.floor(t.elapsed / 1000);

  // 静态铺排（截图 / 静态夹具）
  if (Q.get('anim') === '0') {
    const seeded = seedRows(M, data, judgeStatus, ROWS_PARAM, elapsedSec, judgeFts);
    drawJudgeFrame(ctx, L, seeded.rows, seeded.probs, times, { frozen, now });
    return;
  }

  const byTeam = new Map(data.rows.map(r => [r.team.id, r]));
  const pidx = new Map(data.probs.map((p, i) => [p.id, i]));
  const q = judgeQueue();

  // JudgePresentation.aboutToShow:87-104
  // 封榜时队列不播种；否则只把「未判」的放进来，其余仅标记为已见
  if (!judgePrimed && M.submissions.size > 0) {
    if (!frozen) {
      const list = [...M.submissions.values()]
        .filter(s => !judgeStatus.has(s.id))
        .sort((x, y) => rel2sec(x.contest_time) - rel2sec(y.contest_time))
        .slice(-TEAMS_PER_SCREEN);
      list.forEach(s => q.add(s));
      q.updateTargets(true);          // 直接摆到位，不播入场动画
    }
    for (const s of M.submissions.values()) judgeSeen.add(s.id);
    judgePrimed = true;
    judgeLast = now;
  }

  // 新提交进队：起点由 createSubmissionRecord 决定（屏幕下方 14 行），自己滑上来
  for (const sub of M.submissions.values()) {
    if (!judgeSeen.has(sub.id)) {
      judgeSeen.add(sub.id);
      q.add(sub);
    } else {
      q.refresh(sub);
    }
  }

  const dt = Math.min(200, Math.max(0, now - judgeLast));
  judgeLast = now;
  q.update(dt);

  const rows = q.records.map(sr => {
    const r = rowOf(sr.submission, M, byTeam, pidx, judgeStatus, elapsedSec, judgeFts);
    r.y = sr.anim.getValue();
    r.alpha = q.alphaOf(sr);
    return r;
  });

  drawJudgeFrame(ctx, L, rows, data.probs, times, { frozen, now });

  // 调试：?debug=1 显示页面侧真实计数
  if (Q.get('debug') === '1') {
    ctx.save();
    ctx.font = '20px monospace';
    ctx.fillStyle = '#0f0';
    ctx.textAlign = 'left';
    ctx.fillText(`subs=${M.submissions.size} judges=${M.judgements.size} queue=${q.records.length} ` +
      `judged=${judgeStatus.size} types=${M.judgementTypes.size} ` +
      `acts=${q.records.map(r => (r.action || '-')[0]).join('')}`, 20, H - 24);
    ctx.restore();
  }
}

/** #29 单题统计（ProblemSummaryPresentation 移植） */
let problemStart = 0;
let problemColorFn = null;

function renderProblems(pane) {
  const { ctx, W, H } = ensureCanvas(pane);
  if (!W || !H) return;

  const at = freezeAtSec(durationMs(), freezeMs());
  const data = computeStandings(M, {
    hideJudgement: sub => isJudgementHidden(M.state, rel2sec(sub.contest_time), at),
  });
  if (!data.probs.length) return;

  const L = problemLayout(W, H, data.probs.length);

  // 每题汇总所有队伍的结果 → [attempts, accepted, rejected, ftsMs]
  const stats = data.probs.map((_, pi) => problemStats(data.rows.map(r => r.cells[pi])));

  // 配色：data（用数据自带 rgb）/ random / custom（色板循环）
  if (!problemColorFn) {
    const mode = Q.get('probColor') || 'data';
    const pal = (Q.get('probPalette') || '').split(',').map(s => s.trim()).filter(Boolean);
    problemColorFn = makeColorFn(mode, pal);
  }

  // 循环播放：每个方块依次飞入，最后停 5 秒（getRepeat）
  // getRepeatTimeMs 是由框架从 0 开始累加的，所以这里也用「首帧起算」而不是页面起算
  if (!problemStart) problemStart = performance.now();
  const repeat = problemRepeat(data.probs.length);
  const t = (performance.now() - problemStart) % repeat;

  drawProblemFrame(ctx, L, data.probs, stats, t, problemColorFn);
}

/** #29 每题首杀榜（FirstToSolvePresentation 移植） */
let ftsQ = null, ftsLast = 0, ftsPrimed = false;

function ftsQueue() {
  if (ftsQ) return ftsQ;
  ftsQ = new FtsQueue({
    judged: sub => judgeStatus.has(sub.id),
    isFts: sub => judgeFts.has(sub.id),
    teamsPerScreen: ROWS_PARAM,
  });
  return ftsQ;
}

function renderFts(pane) {
  const { ctx, W, H } = ensureCanvas(pane);
  if (!W || !H) return;

  const at = freezeAtSec(durationMs(), freezeMs());
  const data = computeStandings(M, {
    hideJudgement: sub => isJudgementHidden(M.state, rel2sec(sub.contest_time), at),
  });

  syncJudgeStatus();
  syncJudgeFts();

  const L = judgeLayout(W, H, data.probs.length, ROWS_PARAM);
  const t = contestTimes();
  const times = { elapsedText: fmtClock(t.elapsed, true), remainText: fmtClock(t.remain, true) };
  const frozen = !!(M.state && M.state.isFrozen());
  const now = performance.now();

  const q = ftsQueue();

  // 每题的首杀提交，按 AC 时间排序（= 上榜顺序）
  const ftsList = [];
  for (const s of M.submissions.values()) if (judgeFts.has(s.id)) ftsList.push(s);
  ftsList.sort((a, b) => rel2sec(a.contest_time) - rel2sec(b.contest_time));

  // aboutToShow：已有的一律上榜并直接摆位，不播入场动画
  if (!ftsPrimed && M.submissions.size > 0) {
    for (const s of ftsList) {
      q.handle(s);
      q.handleFts(s.problem_id, true, true);
    }
    q.update(0, true);
    ftsPrimed = true;
    ftsLast = now;
  }

  // 之后新增的首杀从底部滑入
  for (const s of ftsList) {
    if (q.has(s.problem_id)) continue;
    q.handle(s);
    q.handleFts(s.problem_id, true, true);
  }

  const dt = Math.min(200, Math.max(0, now - ftsLast));
  ftsLast = now;
  q.update(dt);

  const probs = data.probs;
  const pidx = new Map(probs.map((p, i) => [p.id, i]));
  const byTeam = new Map(data.rows.map(r => [r.team.id, r]));

  const rows = q.records.map(sr => {
    const sub = sr.submission;
    const st = byTeam.get(sub.team_id);
    const sec = rel2sec(sub.contest_time);
    const pi = pidx.has(sub.problem_id) ? pidx.get(sub.problem_id) : -1;
    const prob = probs[pi];
    return {
      y: sr.anim.getValue(),
      timeText: String(Math.floor(sec / 60)),
      teamName: st ? st.team.name : sub.team_id,
      problemLabel: prob ? (prob.label || '') : '',
      probs,
      currentIndex: pi,
      currentStatus: judgeStatus.get(sub.id) === 'solved' ? 'solved' : 'failed',
      currentText: String(Math.floor(sec / 60)),
    };
  });

  drawFtsFrame(ctx, L, rows, times, { frozen, ftsCount: q.fts.length });

  if (Q.get('debug') === '1') {
    ctx.save();
    ctx.font = '20px monospace';
    ctx.fillStyle = '#0f0';
    ctx.textAlign = 'left';
    ctx.fillText(`fts=${q.fts.length} rows=${q.records.length} ` +
      `ys=${q.records.map(r => r.anim.getValue().toFixed(1)).join(',')}`, 20, H - 24);
    ctx.restore();
  }
}

/** #10 每题提交/通过柱状图（ProblemSummaryChart 移植） */
let chartObj = null, chartStart = 0, chartLast = 0, chartKey = '';

function renderChart(pane) {
  const { ctx, W, H } = ensureCanvas(pane);
  if (!W || !H) return;

  const at = freezeAtSec(durationMs(), freezeMs());
  const data = computeStandings(M, {
    hideJudgement: sub => isJudgementHidden(M.state, rel2sec(sub.contest_time), at),
  });
  if (!data.probs.length) return;

  const stats = data.probs.map((_, pi) => problemStats(data.rows.map(r => r.cells[pi])));

  if (!problemColorFn) {
    const mode = Q.get('probColor') || 'data';
    const pal = (Q.get('probPalette') || '').split(',').map(s => s.trim()).filter(Boolean);
    problemColorFn = makeColorFn(mode, pal);
  }

  const now = performance.now();
  const dt = chartLast ? Math.min(200, Math.max(0, now - chartLast)) : 0;
  chartLast = now;

  // 只有题数变化才重建（等价 aboutToShow：setupChart + resetAnim）；
  // 尺寸抖动只更新几何，否则 chartStart 每帧被重置，生长动画永远停在 0
  const key = String(data.probs.length);
  if (!chartObj || chartKey !== key) {
    chartObj = makeProblemChart(W, H, data.probs, stats, problemColorFn);
    chartKey = key;
    chartStart = now;
  } else {
    if (chartObj.W !== W || chartObj.H !== H) chartObj.resize(W, H);
    chartObj.updateData([stats.map(s => s[0]), stats.map(s => s[1])]);
    chartObj.incrementTimeMs(dt);
  }

  const tTotal = now - chartStart;
  chartObj.draw(ctx, tTotal % CHART_REPEAT, tTotal);

  if (Q.get('debug') === '1') {
    ctx.save();
    ctx.font = '20px monospace';
    ctx.fillStyle = '#0f0';
    ctx.textAlign = 'left';
    const s0 = chartObj.series[0];
    ctx.fillText(`t=${tTotal.toFixed(0)} tr=${(tTotal % CHART_REPEAT).toFixed(0)} ` +
      `max=${chartObj.maximum.getValue().toFixed(1)} ` +
      `v0=${s0.values[0]} anim0=${s0.getAnimValue(0).toFixed(2)} n=${s0.getLength()}`, 20, 40);
    ctx.restore();
  }
}

/** #15 带工位状态的倒计时 */
function renderCountdown(pane) {
  const { ctx, W, H } = ensureCanvas(pane);
  if (!W || !H) return;
  const t = contestTimes();
  const sites = [...M.startStatus.values()].map(x => ({
    label: x.label || x.id,
    status: Number(x.status) || 0,
  }));
  // 比赛已开始则显示已用时间，否则显示剩余（负数=还没开始）
  const start = M.contest.start_time ? Date.parse(M.contest.start_time) : Date.now();
  const d = String(M.contest.duration || '5:00:00').split(':');
  const dur = (+d[0] * 3600 + +d[1] * 60 + (+d[2] || 0)) * 1000;
  let remain = start + dur - Date.now();
  remain = Math.max(0, Math.min(dur, remain));       // 夹在 [0, duration]，避免 %48 回绕
  // 源码：if (contest.getState().isRunning()) s = "Status: Contest started"
  const running = !!(M.state && M.state.isRunning());
  drawCountdown(ctx, W, H, sites, remain, running);
}

async function bootstrap() {
  // 先拉全量快照：SSE 连上之前也能画，重连后也靠这个恢复
  const one = async (name) => {
    try {
      const r = await fetch(`${SRC}/${name}`);
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  };
  const [teams, problems, subs, judges, orgs, jtypes, sites, st] = await Promise.all(
    ['teams', 'problems', 'submissions', 'judgements', 'organizations',
     'judgement-types', 'start-status', 'state'].map(one));
  (teams || []).forEach(t => M.teams.set(t.id, t));
  (problems || []).forEach(p => M.problems.set(p.id, p));
  (subs || []).forEach(s => M.submissions.set(s.id, s));
  (judges || []).forEach(j => M.judgements.set(j.id, j));
  (orgs || []).forEach(o => M.orgs.set(o.id, o));
  (jtypes || []).forEach(t => M.judgementTypes.set(t.id, t));
  (sites || []).forEach(s => M.startStatus.set(s.id, s));
  judgeDirty = true;
  M.state = makeState(st);
  syncContestExtras();
  dirty = true;
}

function connect() {
  const es = new EventSource(`${SRC}/event-feed?stream=true`);
  es.onmessage = e => {
    if (!e.data || !e.data.trim()) return;         // 心跳空行
    lastMsg = Date.now();
    try {
      const ev = JSON.parse(e.data);
      if (ev.type === 'contest') { Object.assign(M.contest, ev.data || {}); }
      else apply(ev.type, ev.id, ev.data);
      dirty = true;
    } catch (_) { /* 忽略坏包 */ }
  };
  es.onerror = () => { /* EventSource 自动重连 */ };
}

// 心跳检测：30s 没消息就提示（不用 setInterval 做渲染，只做状态灯）
setInterval(() => {
  const stale = Date.now() - lastMsg > 30000;
  hint.textContent = stale ? '数据源无响应，重连中…' : '';
  hint.classList.toggle('show', stale);
}, 5000);

// 渲染循环：rAF 驱动；后台标签页 rAF 会被暂停，用定时器兜底推进时间轴
let lastDraw = 0;
function loop() {
  draw();
  lastDraw = performance.now();
  requestAnimationFrame(loop);
}

// 兜底：rAF 超过 500ms 没跑（页面被隐藏/OBS 遮挡），用定时器补一帧
setInterval(() => {
  if (performance.now() - lastDraw > 500) {
    try { draw(); lastDraw = performance.now(); } catch (_) {}
  }
}, 250);

window.addEventListener('resize', () => { dirty = true; });
layout();
(async () => {
  // 字体没加载完就画，第一帧会落到 Arial 上，度量全错
  try {
    await document.fonts.load('20px ICPCFont');
    await document.fonts.load('bold 20px ICPCFont');
    await document.fonts.ready;
  } catch (_) {}
})();
bootstrap().then(() => {
  dirty = true;
  draw();          // 先把快照画出来，不等 SSE
  connect();
  installJudgePanel();
});
requestAnimationFrame(loop);

// ================= 判题队列测试面板 =================
// ?test=1 打开。真实比赛里提交到判题往往几十秒，看不出动画；
// 这里手动造一条提交再手动判 AC/WA，直接看完整的「底部滑入 → 变色 → 滑出」。

function sec2rel(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const x = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}.000`;
}

function panelMsg(s) {
  const el = document.getElementById('testmsg');
  if (el) el.textContent = s;
}

/** 找目标判题类型：优先用数据里真实存在的 id */
function pickJudgementType(kind) {
  const wantSolved = kind === 'ac';
  const pref = kind === 'ac' ? ['AC', 'OK', 'CORRECT']
    : kind === 'ce' ? ['CE', 'COMPILATION_ERROR']
      : ['WA', 'WRONG_ANSWER'];
  for (const p of pref) if (M.judgementTypes.has(p)) return p;
  for (const [id, t] of M.judgementTypes) {
    if (wantSolved && t.solved) return id;
    if (!wantSolved && t.penalty) return id;
  }
  return null;
}

let fakeN = 0;
function testSubmit() {
  const teams = [...M.teams.keys()];
  const probs = [...M.problems.values()].sort((a, b) => a.ordinal - b.ordinal);
  if (!teams.length || !probs.length) return panelMsg('数据还没加载');

  const i = fakeN++;
  const base = Math.max(60, Math.floor(contestTimes().elapsed / 1000));
  const id = 'TEST' + Date.now().toString(36).toUpperCase();
  M.submissions.set(id, {
    id,
    team_id: teams[i % teams.length],
    problem_id: probs[i % probs.length].id,
    contest_time: sec2rel(base),
    language_id: 'cpp',
  });
  dirty = true;
  panelMsg(`新提交 ${id}（${teams[i % teams.length]} / ${probs[i % probs.length].label}）`);
}

function testJudge(kind) {
  const q = judgeQueue();

  // 队列里最后一条未判的
  let target = null;
  for (let i = q.records.length - 1; i >= 0; i--) {
    const s = q.records[i].submission;
    if (!judgeStatus.has(s.id)) { target = s; break; }
  }
  // 队列里没有就自己捞一条进来
  if (!target) {
    const all = [...M.submissions.values()];
    for (let i = all.length - 1; i >= 0; i--) {
      if (!judgeStatus.has(all[i].id)) { target = all[i]; q.add(target); break; }
    }
  }
  if (!target) return panelMsg('没有待判的提交，先点「+ 提交」');

  const typeId = pickJudgementType(kind);
  if (!typeId) return panelMsg('缺 judgement-types，无法判题');

  const jid = 'JTEST' + Date.now().toString(36).toUpperCase();
  M.judgements.set(jid, { id: jid, submission_id: target.id, judgement_type_id: typeId });
  judgeDirty = true;
  dirty = true;
  panelMsg(`${target.id} → ${typeId}`);
}

function testClear() {
  const q = judgeQueue();
  q.records.length = 0;
  for (const s of M.submissions.values()) judgeSeen.add(s.id);
  judgePrimed = true;
  dirty = true;
  panelMsg('队列已清空');
}

function installJudgePanel() {
  if (Q.get('test') !== '1') return;
  if (VIEW !== 'judge') return;

  const style = document.createElement('style');
  style.textContent = `
    #testbar{position:fixed;right:12px;bottom:12px;z-index:9999;display:flex;gap:6px;align-items:center;
      font:13px/1.4 system-ui,sans-serif;background:rgba(18,18,18,.86);padding:8px 10px;border-radius:9px;
      border:1px solid #3a3a3a;box-shadow:0 4px 18px rgba(0,0,0,.6)}
    #testbar button{background:#2b2b2b;color:#e6e6e6;border:1px solid #4a4a4a;border-radius:5px;
      padding:5px 11px;cursor:pointer;font:inherit}
    #testbar button:hover{background:#3a3a3a}
    #testbar button[data-act="ac"]{border-color:#1f9c1f;color:#7ee87e}
    #testbar button[data-act="wa"]{border-color:#a02222;color:#f09090}
    #testbar button[data-act="ce"]{border-color:#8a6a12;color:#e8c86a}
    #testmsg{color:#8fd48f;margin-left:8px;min-width:170px}`;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.id = 'testbar';
  bar.innerHTML =
    '<button data-act="sub">+ 提交</button>' +
    '<button data-act="ac">AC</button>' +
    '<button data-act="wa">WA</button>' +
    '<button data-act="ce">CE</button>' +
    '<button data-act="clear">清空</button>' +
    '<span id="testmsg"></span>';
  document.body.appendChild(bar);

  bar.addEventListener('click', ev => {
    const act = ev.target && ev.target.dataset && ev.target.dataset.act;
    if (!act) return;
    if (act === 'sub') testSubmit();
    else if (act === 'clear') testClear();
    else testJudge(act);
  });
}
