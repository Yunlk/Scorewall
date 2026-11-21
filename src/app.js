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
import { JudgeQueue } from './judge-queue.js';

const Q = new URLSearchParams(location.search);
const SRC = (Q.get('src') || 'http://127.0.0.1:8081/api/contests/144333').replace(/\/$/, '');
const VIEW = Q.get('view') || 'standings';



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
  if (data == null) { bag.delete(id); return; }
  bag.set(id, data);
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
  if (VIEW === 'standings' || VIEW === 'judge' || VIEW === 'countdown') {
    paneA.style.display = 'block';
    paneB.classList.add('hidden');
  }
}

function draw() {
  if (VIEW === 'countdown') { renderCountdown(paneA); dirty = false; return; }
  if (VIEW === 'judge') { renderJudge(paneA); dirty = false; return; }
  // 有滚动动画，必须每帧重画（对齐 Java 的立即模式）
  const at = freezeAtSec(durationMs(), freezeMs());
  const data = computeStandings(M, {
    hideJudgement: sub => isJudgementHidden(M.state, rel2sec(sub.contest_time), at),
  });
  renderStandings(paneA, data);
  dirty = false;
}

/** #56 判题队列（动画版：JudgeQueue 驱动行号） */
let judgeQ = null, judgeSeen = new Set(), judgeLast = 0, judgePrimed = false;

function judgeQueue() {
  if (judgeQ) return judgeQ;
  judgeQ = new JudgeQueue({
    judged: sub => {
      for (const j of M.judgements.values()) if (j.submission_id === sub.id) return true;
      return false;
    },
    solved: sub => {
      for (const j of M.judgements.values()) {
        if (j.submission_id === sub.id) {
          const jt = M.judgementTypes.get(j.judgement_type_id);
          return !!(jt && jt.solved);
        }
      }
      return false;
    },
    frozen: () => !!(M.state && M.state.isFrozen()),
    // 源码默认：AC 停 11 秒、WA 停 8 秒，然后才走
    // timeToKeepSolved / timeToKeepFailed 可用 URL 覆盖，见下
    timeToKeepSolved: Q.has('keepSolved') ? Number(Q.get('keepSolved')) : undefined,
    timeToKeepFailed: Q.has('keepFailed') ? Number(Q.get('keepFailed')) : undefined,
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
  const L = judgeLayout(W, H, data.probs.length);
  const t = contestTimes();
  const times = { elapsedText: fmtClock(t.elapsed, true), remainText: fmtClock(t.remain, true) };
  const frozen = !!(M.state && M.state.isFrozen());

  // 动画默认开启；&anim=0 退回静态铺排（用于截图/静态夹具）
  if (Q.get('anim') === '0') {
    const seeded = seedRows(M, data);
    drawJudgeFrame(ctx, L, seeded.rows, seeded.probs, times, { frozen });
    return;
  }

  const byTeam = new Map(data.rows.map(r => [r.team.id, r]));
  const pidx = new Map(data.probs.map((p, i) => [p.id, i]));
  const q = judgeQueue();
  const now = performance.now();

  // 首次：用最近提交把队列摆好（不放动画）
  // 源码 aboutToShow：封榜时队列清空且不播种
  if (!judgePrimed && M.submissions.size > 0) {
    const isFrozenNow = !!(M.state && M.state.isFrozen());
    const judgedIds = new Set();
    for (const j of M.judgements.values()) judgedIds.add(j.submission_id);
    const list = isFrozenNow ? [] : [...M.submissions.values()]
      .filter(s => !judgedIds.has(s.id))                 // 只留待判的，已判的进队列会立刻滑出
      .sort((x, y) => rel2sec(x.contest_time) - rel2sec(y.contest_time))
      .slice(-12);
    // 源码 aboutToShow：只把「未判」的放进队列，其余仅标记为已见过
    for (const sub of M.submissions.values()) judgeSeen.add(sub.id);
    list.forEach(sub => q.add(sub));      // 顺序即行位，位置由 updateTargets 决定
    q.updateTargets(true);
    judgePrimed = true;
    judgeLast = now;
  }

  for (const sub of M.submissions.values()) {
    if (!judgeSeen.has(sub.id)) {
      judgeSeen.add(sub.id);
      const sr = q.add(sub);
      // 我的设计：从「自己行位的下一格」滑上来——短距离、每条都是独立的一次位移
      if (sr) sr.anim.reset(sr.anim.xTarget + 1);
    } else {
      q.refresh(sub);            // Java listener：对象更新也走 handleSubmission
    }
  }

  const dt = Math.min(200, Math.max(0, now - judgeLast));
  judgeLast = now;
  q.update(dt);

  const verdicts = new Map();
  for (const j of M.judgements.values()) verdicts.set(j.submission_id, j.judgement_type_id);

  const rows = q.records.map(sr => {
    const r = rowOf(sr.submission, M, byTeam, pidx, verdicts);
    r.y = sr.anim.getValue();
    r.alpha = q.alphaOf(sr);
    r.currentAgeMs = sr.fullAge;        // 记录在队列里的年龄 → 决定是否脉动
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
      `judgedRows=${rows.filter(r => r.currentStatus !== 'pending').length} types=${M.judgementTypes.size}`, 20, H - 24);
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
});
requestAnimationFrame(loop);
