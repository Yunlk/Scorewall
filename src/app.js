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
import { makeLayout, drawFrame, MS_PER_PAGE, SCROLL_MS } from './standings-canvas.js?v=4';
import { drawCountdown } from './countdown-canvas.js';
import { makeState, freezeAtSec, isJudgementHidden } from './state.js';
import { judgeLayout, drawJudgeFrame, seedRows, rowOf } from './judge-canvas.js';
import { JudgeQueue, TEAMS_PER_SCREEN } from './judge-queue.js';
import { problemLayout, drawProblemFrame, problemStats, problemRepeat, makeColorFn } from './problem-canvas.js';
import { makeProblemChart, CHART_REPEAT } from './chart-canvas.js';
import { tileLayout, buildGroups, drawTileRank, tileRepeat, scrollOffset, DEFAULT_COLUMNS } from './tilerank-canvas.js';
import { drawPolarCountdown } from './polar-canvas.js';
import { timelineLayout, drawTimelineFrame } from './timeline-canvas.js';
import { FtsQueue, drawFtsFrame } from './fts-canvas.js';

const Q = new URLSearchParams(location.search);
// ?src= 优先；其次用托管方注入的默认值（nowcoder-bridge 的 /scorewall/ 会设成同源 API）；
// 最后才退回本地适配器地址
const SRC = (Q.get('src') || window.__SRC_DEFAULT__ || 'http://127.0.0.1:8081/api/contests/144333')
  .replace(/\/$/, '');
let VIEW = Q.get('view') || 'standings';
/** AbstractScoreboardPresentation.setNumRows() —— 行数直接决定字号（源码支持 rows: 属性） */
const ROWS_PARAM = Math.max(1, Number(Q.get('rows')) || 12);
/** 校徽开关 / tag（config 里「显示校徽」「校徽 tag」两项） */
const LOGO_ON = Q.get('logo') !== '0';
const LOGO_TAG = Q.get('logoTag') || 'dark';
/** 工位状态开关（?sites=0 关闭）。远控可以随时改 */
let SITES_ON = Q.get('sites') !== '0';
/** 手动锁定阶段（?phase=before|during|final|after）；空 = 按时间自动判定 */
let FORCE_PHASE = (Q.get('phase') || '').trim();
/** 远控端点（适配器的 /api/control） */
const CONTROL_URL = SRC.replace(/\/api\/contests\/.*$/, '') + '/api/control';



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

/**
 * 处理一条 CCS 事件。事件流的 type 是复数（contests / submissions），
 * 和 REST 快照的 key 不完全对应，这里做一次归一。
 * 像 nowcoder-bridge 这类适配器只推 event-feed、不提供 /submissions 这类 REST，
 * 全量快照也得走这里灌进来。
 */
function applyEvent(ev) {
  if (!ev || !ev.type) return;
  const type = ev.type === 'contests' ? 'contest' : ev.type;
  const data = ev.data;

  if (type === 'contest') { Object.assign(M.contest, data || {}); return; }
  if (type === 'state') { M.state = makeState(data); return; }
  apply(type, ev.id || (data && data.id), data);
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
    // 只要有 judgement 就是「已判」。不能拿 penalty 当条件：
    // CE 这类是 penalty=false + solved=false，跳过的话前端会以为它还没判，
    // 提交会永远卡在判题队列里出不来（IResult.Status 对它们返回 FAILED，不是 SUBMITTED）
    judgeStatus.set(j.submission_id, jt.solved ? 'solved' : 'failed');
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
  preloadOrgLogos();
  drawFrame(ctx, L, data.rows, data.probs, times, scrollPx, perProblemStats(data), alpha,
    {
      frozen: !!(M.state && M.state.isFrozen()),
      now: performance.now(),
      elapsedSec: Math.floor(contestTimes().elapsed / 1000),
      orgs: M.orgs,
      showLogo: LOGO_ON,
      logoTags: LOGO_TAG,
    });
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** 组织 logo 预加载（CCS organizations[].logo 是 {href, mime, width, height} 数组） */
function preloadOrgLogos() {
  for (const org of M.orgs.values()) {
    if (org._logoImg || !org.logo) continue;
    const list = Array.isArray(org.logo) ? org.logo : [org.logo];
    // getBestFileReference：按 tag 过滤后优先 SVG
    const tag = LOGO_TAG;
    const withTag = list.filter(r => r && Array.isArray(r.tags) && r.tags.includes(tag));
    const untagged = list.filter(r => r && (!Array.isArray(r.tags) || !r.tags.length));
    const pool = withTag.length ? withTag : (untagged.length ? untagged : list);
    const ref = pool.find(r => r && r.mime === 'image/svg+xml') || pool[0];
    const href = ref && (typeof ref === 'string' ? ref : ref.href);
    if (!href) continue;
    const img = new Image();
    img.src = resolveUrl(SRC, href);
    org._logoImg = img;
  }
}

/**
 * 远控轮询：每 2 秒问一次适配器的 /api/control。
 * 控制页点一下按钮 → 这里读到变化 → 立刻切视图/阶段/工位开关，不用刷新大屏。
 */
let ctrlSeq = -1;
async function pollControl() {
  try {
    const r = await fetch(CONTROL_URL, { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    if (j.seq === ctrlSeq) return;              // 没变化
    const first = ctrlSeq < 0;
    ctrlSeq = j.seq;

    if (typeof j.sites === 'boolean' && j.sites !== SITES_ON) {
      SITES_ON = j.sites;
      dirty = true;
    }
    const ph = (j.phase || '').trim();
    if (ph !== FORCE_PHASE) {
      FORCE_PHASE = ph;
      dirty = true;
    }
    const v = (j.view || '').trim();
    if (!first && v && v !== VIEW) {
      VIEW = v;
      resetViewState();
      layout();
    }
  } catch (_) { /* 适配器没起或跨域，忽略 */ }
}

// ---------------- 主循环：SSE 驱动 ----------------
const paneA = document.getElementById('paneA');
const paneB = document.getElementById('paneB');
const hint = document.getElementById('hint');
let lastMsg = Date.now();
/** event-feed 已消费到第几行（事件序号）。重连时带 since_id，避免每次都重发全量历史 */
let feedSeq = 0;
/** event-feed 统计（debug 用）：证明流有没有在推 */
let feedLines = 0, feedBeats = 0;
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
    || VIEW === 'problems' || VIEW === 'chart' || VIEW === 'fts' || VIEW === 'tilerank'
    || VIEW === 'polar' || VIEW === 'timeline') {
    paneA.style.display = 'block';
    paneB.classList.add('hidden');
  }
}

function draw() {
  // 校徽预加载放在这里：之前只在 renderStandings 里调，
  // 直接开 ?view=judge / fts / tilerank 时 logo 从没加载，全是首字占位
  preloadOrgLogos();
  if (VIEW === 'countdown') { renderCountdown(paneA); dirty = false; return; }
  if (VIEW === 'judge') { renderJudge(paneA); dirty = false; return; }
  if (VIEW === 'problems') { renderProblems(paneA); dirty = false; return; }
  if (VIEW === 'chart') { renderChart(paneA); dirty = false; return; }
  if (VIEW === 'fts') { renderFts(paneA); dirty = false; return; }
  if (VIEW === 'tilerank') { renderTileRank(paneA); dirty = false; return; }
  if (VIEW === 'polar') { renderPolar(paneA); dirty = false; return; }
  if (VIEW === 'timeline') { renderTimeline(paneA); dirty = false; return; }
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

/** 赛外提交：contest_time 超过 duration。牛客赛后可继续交，这些不该进判题队列/时间轴 */
function isAfterContest(sub) {
  const dur = durationMs();
  if (!dur) return false;
  return rel2sec(sub.contest_time) * 1000 > dur;
}

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
    // 未判提交兜底停留（秒）。默认 120s，够真实判题用；数据源永远不会判的
    // 幽灵提交（比如牛客那边已经没了但适配器还留着）到时自动淡出，不堵队列。
    pendingTimeout: Q.has('pendingMax')
      ? Math.max(0, Number(Q.get('pendingMax')) * 1000)
      : 120000,
    teamsPerScreen: ROWS_PARAM,
  });
  return judgeQ;
}

function renderJudge(pane) {
  const { ctx, W, H } = ensureCanvas(pane);
  if (!W || !H) return;

  syncJudgeStatus();

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
  const judgedNow = s => judgeStatus.has(s.id);
  const arrived = s => !isAfterContest(s);   // 赛外提交（赛后练习）不进队列

  if (!judgePrimed && M.submissions.size > 0) {
    if (!frozen) {
      const list = [...M.submissions.values()]
        .filter(s => !judgedNow(s) && !isAfterContest(s))   // 赛外提交（赛后练习）不进队列
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
    if (!arrived(sub)) continue;              // 赛外提交跳过
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

  drawJudgeFrame(ctx, L, rows, data.probs, times, { frozen, now, orgs: M.orgs, showLogo: LOGO_ON });

  // 调试：?debug=1 显示页面侧真实计数
  if (Q.get('debug') === '1') {
    ctx.save();
    ctx.font = '20px monospace';
    ctx.fillStyle = '#0f0';
    ctx.textAlign = 'left';
    ctx.fillText(`subs=${M.submissions.size} judges=${M.judgements.size} queue=${q.records.length} ` +
      `judged=${judgeStatus.size} types=${M.judgementTypes.size} ` +
      `acts=${q.records.map(r => (r.action || '-')[0]).join('')}`, 20, H - 24);
    ctx.fillText(`feed=${feedLines}ev/${feedBeats}hb last=${Math.round((Date.now() - lastMsg) / 1000)}s`, 20, H - 72);
    ctx.fillText(`view=${VIEW} rotate=${ROTATE_AUTO ? 'auto' : ROTATE_SEC} next=${Math.round(rotateNextIn / 1000)}s fired=${rotateCount}`, 20, H - 96);
    ctx.fillText(`start=${M.contest.start_time} dur=${M.contest.duration} ` +
      `elapsedMs=${Math.round(t.elapsed)} remainMs=${Math.round(t.remain)}`, 20, H - 48);
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

/** #16 圆环倒计时（PolarCountdownPresentation 移植） */
function renderPolar(pane) {
  const { ctx, W, H } = ensureCanvas(pane);
  if (!W || !H) return;

  // CountdownPresentation.setClockTarget:50-62 + getRemainingMillis:76-110
  //   clock = -getRemainingMillis()，而 getRemainingMillis 分两段：
  //     未过 switchPoint → start-now = -elapsed        ⇒ clock = +elapsed（正计时）
  //     过了 switchPoint → (start-now)+duration = remain ⇒ clock = -remain（倒计时）
  //   switchPoint = duration - freezeDuration，没有封榜就是 2/3
  const t = contestTimes();
  const dur = durationMs();
  // fixture 的 contest.json 没有 start_time，elapsed 恒为 0；给个 ?at=<秒> 便于演示
  const atSec = Q.has('at') ? Number(Q.get('at')) : null;
  const elapsed = atSec != null ? atSec * 1000 : t.elapsed;
  const fz = freezeMs();
  const switchPoint = fz > 0 ? Math.max(0, dur - fz) : (dur * 2) / 3;
  const clockMs = elapsed <= switchPoint ? elapsed : -(dur - elapsed);

  drawPolarCountdown(ctx, W, H, {
    clockMs,
    durationMs: dur,
    verticalOffset: 0,
  });

  if (Q.get('debug') === '1') {
    ctx.save();
    ctx.font = '20px monospace';
    ctx.fillStyle = '#0f0';
    ctx.textAlign = 'left';
    const ck = Object.keys(M.contest || {}).join(',');
    ctx.fillText(`clock=${clockMs} elapsed=${Math.round(elapsed)} dur=${dur}`, 20, H - 24);
    ctx.fillText(`contest.start_time=${M.contest && M.contest.start_time} keys=[${ck}]`, 20, H - 48);
    ctx.fillText(`state.started=${M.state && M.state.started} SRC=${SRC}`, 20, H - 72);
    ctx.restore();
  }
}

/** #? 题解时间轴（TimelinePresentation 移植） */
let tlCache = null;

/** 按队伍分组提交，并标出每题的首解与 recent */
function timelineSubs(probs, pidx, elapsedSec) {
  const n = M.submissions.size;
  const nj = M.judgements.size;
  // 判题数也要进 key：只按提交数缓存的话，判题结果晚到会被旧缓存盖住，方块一直显示 pending
  if (tlCache && tlCache.n === n && tlCache.nj === nj && tlCache.elapsed === (elapsedSec | 0)) {
    return tlCache.byTeam;
  }

  const all = [];
  for (const sub of M.submissions.values()) {
    const pi = pidx.has(sub.problem_id) ? pidx.get(sub.problem_id) : -1;
    if (pi < 0 || isAfterContest(sub)) continue;   // 赛外提交不上时间轴
    all.push({
      sub, pi,
      sec: rel2sec(sub.contest_time),
      verdict: judgeStatus.get(sub.id) || null,
    });
  }

  // 每题最早的一条 solved 才是 First to Solve
  const firstAc = new Map();
  for (const x of all) {
    if (x.verdict !== 'solved') continue;
    const cur = firstAc.get(x.pi);
    if (!cur || x.sec < cur.sec) firstAc.set(x.pi, x.sub.id);
  }

  const byTeam = new Map();
  for (const x of all) {
    const item = {
      tSec: x.sec,
      label: (probs[x.pi] && probs[x.pi].label) || '',
      status: x.verdict === 'solved' ? 'solved' : x.verdict === 'failed' ? 'failed' : 'pending',
      isFts: x.verdict === 'solved' && firstAc.get(x.pi) === x.sub.id,
      recent: elapsedSec == null ? true : x.sec > elapsedSec - 300,
    };
    if (!byTeam.has(x.sub.team_id)) byTeam.set(x.sub.team_id, []);
    byTeam.get(x.sub.team_id).push(item);
  }
  for (const arr of byTeam.values()) arr.sort((a, b) => a.tSec - b.tSec);

  tlCache = { n, nj, elapsed: elapsedSec | 0, byTeam };
  return byTeam;
}

function renderTimeline(pane) {
  const { ctx, W, H } = ensureCanvas(pane);
  if (!W || !H) return;

  // judgeStatus 是懒重建的，timeline 也得先触发一次，否则方块全是 pending
  syncJudgeStatus();

  const at = freezeAtSec(durationMs(), freezeMs());
  const data = computeStandings(M, {
    hideJudgement: sub => isJudgementHidden(M.state, rel2sec(sub.contest_time), at),
  });
  const t = contestTimes();
  const pidx = new Map(data.probs.map((p, i) => [p.id, i]));
  const elapsedSec = Math.floor(t.elapsed / 1000);
  const byTeam = timelineSubs(data.probs, pidx, elapsedSec);

  drawTimelineFrame(ctx, timelineLayout(W, H), data.rows, data.probs, byTeam, {
    elapsedText: fmtClock(t.elapsed, true),
    remainText: fmtClock(t.remain, true),
    duration: durationMs(),
    freezeMs: freezeMs() || 0,
    elapsed: t.elapsed,
    frozen: !!(M.state && M.state.isFrozen()),
  }, { orgs: M.orgs, showLogo: LOGO_ON });
}

/** #? 按过题数分档的瓦片榜（TileRankScoreboardPresentation 移植） */
let tileStart = 0;
let tileLast = 0;

function renderTileRank(pane) {
  const { ctx, W, H } = ensureCanvas(pane);
  if (!W || !H) return;

  const at = freezeAtSec(durationMs(), freezeMs());
  const data = computeStandings(M, {
    hideJudgement: sub => isJudgementHidden(M.state, rel2sec(sub.contest_time), at),
  });
  if (!data.rows.length) return;

  const L = tileLayout(W, H, ROWS_PARAM, DEFAULT_COLUMNS);
  const groups = buildGroups(data.rows, DEFAULT_COLUMNS);

  const now = performance.now();
  if (!tileStart) tileStart = now;
  const repeat = tileRepeat(data.rows.length, ROWS_PARAM, DEFAULT_COLUMNS);
  const t = (now - tileStart) % repeat;
  const scrollPx = scrollOffset(t, H, ROWS_PARAM, DEFAULT_COLUMNS, data.rows.length);

  drawTileRank(ctx, L, groups, data.probs, scrollPx, {
    frozen: !!(M.state && M.state.isFrozen()),
    orgs: M.orgs,
    showLogo: LOGO_ON,
  });

  if (Q.get('debug') === '1') {
    ctx.save();
    ctx.font = '20px monospace';
    ctx.fillStyle = '#0f0';
    ctx.textAlign = 'left';
    ctx.fillText(`groups=${groups.length} teams=${data.rows.length} t=${t.toFixed(0)} scroll=${scrollPx.toFixed(0)} repeat=${repeat}`, 20, H - 24);
    ctx.restore();
  }
}

/** #29 每题首杀榜（FirstToSolvePresentation 移植） */
let ftsQ = null, ftsLast = 0, ftsPrimed = false, ftsSeen = new Set();

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
      team: st ? st.team : { name: sub.team_id },
      problemLabel: prob ? (prob.label || '') : '',
      probs,
      currentIndex: pi,
      currentStatus: judgeStatus.get(sub.id) === 'solved' ? 'solved' : 'failed',
      currentText: String(Math.floor(sec / 60)),
    };
  });

  drawFtsFrame(ctx, L, rows, times, { frozen, ftsCount: q.fts.length, orgs: M.orgs, showLogo: LOGO_ON });

  if (Q.get('debug') === '1') {
    ctx.save();
    ctx.font = '20px monospace';
    ctx.fillStyle = '#0f0';
    ctx.textAlign = 'left';
    ctx.fillText(`fts=${q.fts.length} rows=${q.records.length} orgs=${M.orgs.size} showLogo=${LOGO_ON} ` +
      `team0.org=${t0 && t0.team ? t0.team.organization_id : 'n/a'}`, 20, H - 24);
    ctx.fillText(`ys=${q.records.map(r => r.anim.getValue().toFixed(1)).join(',')}`, 20, H - 48);
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
    // aboutToShow 的等价物：先把数据灌进去，再把最大刻度直接对齐，
    // 否则从 0 慢慢长上来，数据量大的比赛（单题 200+ 次提交）前半分钟柱子会冲出顶部
    chartObj.updateData([stats.map(s => s[0]), stats.map(s => s[1])]);
    chartObj.resetAnim();
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
  drawCountdown(ctx, W, H, SITES_ON ? sites : [], remain, running);
}

async function bootstrap() {
  // 先拉全量快照：SSE 连上之前也能画，重连后也靠这个恢复
  const one = async (name) => {
    try {
      // name 为空 => contest 本身。注意不能拼成 `${SRC}/`，末尾多一个斜杠服务端会 404，
      // 那样 M.contest 永远是空对象，contestTimes() 只能退化成 now，elapsed 恒为 0
      const r = await fetch(name ? `${SRC}/${name}` : SRC);
      if (!r.ok) return null;
      const j = await r.json();
      // nowcoder-bridge 这类适配器对未实现的接口返回 200 + {"error":"not_found"}，
      // 只看 r.ok 会把错误体当成数据，导致后面的 event-feed 回退永远不触发
      if (j && typeof j === 'object' && !Array.isArray(j) && j.error) return null;
      return j;
    } catch (_) { return null; }
  };
  const [contest, teams, problems, subs, judges, orgs, jtypes, sites, st] = await Promise.all(
    ['', 'teams', 'problems', 'submissions', 'judgements', 'organizations',
     'judgement-types', 'start-status', 'state'].map(one));
  if (contest) Object.assign(M.contest, contest);
  (teams || []).forEach(t => M.teams.set(t.id, t));
  (problems || []).forEach(p => M.problems.set(p.id, p));
  (subs || []).forEach(s => M.submissions.set(s.id, s));
  (judges || []).forEach(j => M.judgements.set(j.id, j));
  (orgs || []).forEach(o => M.orgs.set(o.id, o));
  (jtypes || []).forEach(t => M.judgementTypes.set(t.id, t));
  (sites || []).forEach(s => M.startStatus.set(s.id, s));
  judgeDirty = true;

  // 适配器（nowcoder-bridge 等）没有 /submissions、/judgements、/state 这些 REST，
  // 但 event-feed?stream=false 会一次性吐出全量 NDJSON —— 用它补齐
  if (!subs || !judges || !st) {
    try {
      const r = await fetch(`${SRC}/event-feed?stream=false`);
      if (r.ok) {
        const txt = await r.text();
        for (const line of txt.split('\n')) {
          const s = line.trim();
          if (!s) continue;
          feedSeq++;                       // 记住消费到哪一行，供 SSE 增量续传
          try { applyEvent(JSON.parse(s)); } catch (_) { /* 坏行跳过 */ }
        }
      }
    } catch (_) { /* 适配器不支持就退回纯 SSE */ }
  }

  M.state = makeState(st);
  syncContestExtras();
  dirty = true;
}

/**
 * 连 event-feed 收增量事件。
 *
 * CCS 规范里 event-feed 是 **NDJSON 流**（每行一个 JSON），不是 SSE ——
 * 适配器（nowcoder-bridge / ICPC Tools 的 RESTContestSource）都按裸行发。
 * 用 EventSource 的话它只认 `data: ...` 前缀，onmessage 永远不会触发，
 * 表现就是「实时提交不进队列、只有刷新页面才更新」。
 * 所以这里用 fetch + ReadableStream 自己按行切。
 */
async function connect() {
  try {
    const res = await fetch(`${SRC}/event-feed?stream=true&since_id=${feedSeq}`, { cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error('feed ' + res.status);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });

      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        // 空行是心跳：也算「源还活着」，否则 30 秒后会误报「无响应」
        lastMsg = Date.now();
        if (!line) { feedBeats++; continue; }
        feedLines++;
        feedSeq++;
        try {
          applyEvent(JSON.parse(line));
          dirty = true;
        } catch (_) { /* 忽略坏行 */ }
      }
    }
  } catch (_) { /* 落到下面的重连 */ }
  setTimeout(connect, 2000);                 // 断线与正常结束都重连
}

// 心跳检测：30s 没消息就提示（不用 setInterval 做渲染，只做状态灯）
setInterval(() => {
  const stale = Date.now() - lastMsg > 30000;
  hint.textContent = stale ? '数据源无响应，重连中…' : '';
  hint.classList.toggle('show', stale);
}, 5000);

// 渲染循环：rAF 驱动；后台标签页 rAF 会被暂停，用定时器兜底推进时间轴
let lastDraw = 0;
/**
 * 自轮播：按比赛阶段自动切视图。
 *
 *   ?rotate=auto     每个视图演完自己那一轮再切（推荐）
 *   ?rotate=<秒>     固定间隔切
 *   ?before= ?during= ?final= ?after= ?finalMin=
 *
 * 各视图的「一轮」由它自己的分页/滚动周期决定：
 *   standings  每屏 MS_PER_PAGE，屏数 = ceil(队伍数 / 行数)
 *   tilerank   tileRepeat()
 *   problems   problemRepeat()
 *   其余       一次画完的给固定停留
 */
const ROTATE_RAW = (Q.get('rotate') || '').trim();
const ROTATE_AUTO = ROTATE_RAW === 'auto' || Q.get('auto') === '1';
const ROTATE_SEC = ROTATE_AUTO ? 0 : Math.max(0, Number(ROTATE_RAW) || 0);
const FINAL_MIN = Math.max(0, Number(Q.get('finalMin')) || 30);

const parseList = (v, fallback) =>
  (v || fallback).split(',').map(s => s.trim()).filter(Boolean);

const PHASES = {
  // 赛前：钉住大倒计时，不轮播
  before: parseList(Q.get('before'), 'countdown'),
  // 赛中：除了判题队列(judge)和每队过题时间轴(timeline)之外的都轮播
  during: parseList(Q.get('during') || Q.get('views'),
    'standings,fts,problems,tilerank,chart'),
  // 赛末：钉住大圆盘倒计时
  final: parseList(Q.get('final'), 'polar'),
  // 赛后：最终榜单
  after: parseList(Q.get('after'), 'standings'),
};

/** 当前处于哪个阶段。用 contestTimes() 的 elapsed/remain，赛前 elapsed 为负。 */
function currentPhase() {
  if (FORCE_PHASE) return FORCE_PHASE;
  const t = contestTimes();
  if (t.elapsed < 0) return 'before';
  if (t.remain <= 0) return 'after';
  if (t.remain <= FINAL_MIN * 60000) return 'final';
  return 'during';
}

/** 这个视图「演完一轮」要多久 */
function cycleMs(v) {
  // 首屏数据还没到（bootstrap 是异步的），这时按 0 队 0 题算出来的周期只有十几秒，
  // 会一连跳好几个视图才稳定下来。给个兜底，等数据齐了再按真实规模算。
  if (!M.teams.size) return 12000;
  const nT = Math.max(1, M.teams.size);
  const nP = Math.max(1, M.problems.size);
  switch (v) {
    case 'standings':
      return Math.ceil(nT / ROWS_PARAM) * MS_PER_PAGE;
    case 'tilerank':
      return tileRepeat(nT, ROWS_PARAM, DEFAULT_COLUMNS);
    case 'problems':
      return problemRepeat(nP);
    case 'timeline': return 45000;
    case 'chart': return 30000;
    case 'fts': return 30000;
    case 'judge': return 30000;
    case 'polar':
    case 'countdown': return 60000;
    default: return 24000;
  }
}

/** 切换视图时把各模块的缓存/动画状态清掉，否则会接着上一个视图的进度画 */
function resetViewState() {
  judgeQ = null;
  judgePrimed = false;
  judgeSeen.clear();
  judgeLast = 0;
  problemStart = 0;
  tileStart = 0;
  tlCache = null;
  chartObj = null;
  chartKey = '';
  chartLast = 0;
  dirty = true;
}

/** debug 用：下一次切换还要多久 */
let rotateNextIn = 0, rotateCount = 0, rotateAt = 0;

function startRotate() {
  if (!ROTATE_AUTO && !ROTATE_SEC) return;

  let phase = currentPhase();
  let list = PHASES[phase] && PHASES[phase].length ? PHASES[phase] : PHASES.during;
  // 当前视图不在这个阶段的列表里（比如 ?view=judge 但 judge 不参与轮播）：
  // 置 -1，让第一次 step() 落到 list[0] 上，而不是跳过第一个
  let idx = list.indexOf(VIEW);
  if (idx < 0) idx = -1;

  const step = () => {
    const now = currentPhase();
    if (now !== phase) {
      // 阶段变了：换列表并从头开始，别接着上个阶段的进度
      phase = now;
      list = PHASES[phase] && PHASES[phase].length ? PHASES[phase] : PHASES.during;
      idx = 0;
    }

    if (list.length >= 2) {
      idx = (idx + 1) % list.length;
      VIEW = list[idx];
      resetViewState();
      layout();
    } else if (VIEW !== list[0]) {
      // 单视图阶段：钉住那一个
      VIEW = list[0];
      resetViewState();
      layout();
    }

    // 切完再按「新视图」的周期排下一次，这样每个视图都能演完自己那一轮
    const wait = Math.max(3000, ROTATE_AUTO ? cycleMs(VIEW) : ROTATE_SEC * 1000);
    rotateNextIn = wait;
    rotateAt = Date.now() + wait;
    rotateCount++;
    setTimeout(step, wait);
  };

  const firstWait = Math.max(3000, ROTATE_AUTO ? cycleMs(VIEW) : ROTATE_SEC * 1000);
  rotateNextIn = firstWait;
  rotateAt = Date.now() + firstWait;
  setTimeout(step, firstWait);
}

function loop() {
  draw();
  lastDraw = performance.now();
  requestAnimationFrame(loop);
}

// 启动轮播（必须在 loop 外面：放里面会每帧新建一个 setInterval）
startRotate();
pollControl();
setInterval(pollControl, 2000);


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
