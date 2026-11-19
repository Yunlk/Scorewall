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

const Q = new URLSearchParams(location.search);
const SRC = (Q.get('src') || 'http://127.0.0.1:8081/api/contests/144333').replace(/\/$/, '');
const VIEW = Q.get('view') || 'standings';

/** 对齐 RESTContestSource.getResolvedURL：
 *  绝对 URL 原样；以 / 开头走 protocol://authority + href；否则相对 base */
function resolveUrl(href) {
  if (!href) return '';
  if (/^https?:/i.test(href)) return href;
  const u = new URL(SRC);
  return href.startsWith('/')
    ? `${u.protocol}//${u.host}${href}`
    : `${SRC}/${href.replace(/^\//, '')}`;
}

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
/** RelativeTime "0:13:07.000" -> 秒 */
function rel2sec(s) {
  const a = String(s || '0:0:0.000').replace(/^[-+]/, '').split(':');
  return Math.floor(+a[0] * 3600 + +a[1] * 60 + parseFloat(a[2] || 0));
}

/** AbstractICPCPresentation.getTime：h:mm:ss，未开始加负号 */
function fmtClock(ms, floor) {
  let sec = ms / 1000;
  sec = floor ? Math.floor(sec) : Math.round(sec);
  const neg = sec < 0;
  const a = Math.abs(sec);
  const h = Math.floor(a / 3600) % 48;
  const m = Math.floor(a / 60) % 60;
  const s = Math.floor(a) % 60;
  const p = n => String(n).padStart(2, '0');
  return (neg && h === 0 ? '-' : '') + h + ':' + p(m) + ':' + p(s);
}

function contestTimes() {
  const c = M.contest;
  const start = c.start_time ? Date.parse(c.start_time) : Date.now();
  const dur = (() => {
    const d = String(c.duration || '5:00:00').split(':');
    return (+d[0] * 3600 + +d[1] * 60 + (+d[2] || 0)) * 1000;
  })();
  const now = Date.now();
  return { elapsed: now - start, remain: start + dur - now };
}

// ---------------- 排名（ICPC 规则） ----------------
function computeStandings() {
  const probs = [...M.problems.values()].sort((a, b) => a.ordinal - b.ordinal);
  const pidx = new Map(probs.map((p, i) => [p.id, i]));
  const penaltySec = (M.contest.penalty_time || 20) * 60;

  // 每条提交的判题结论
  const verdict = new Map();          // submission id -> judgement
  for (const j of M.judgements.values()) verdict.set(j.submission_id, j);

  const cells = new Map();            // teamId -> [{solvedAt, attempts, pending}]
  for (const t of M.teams.keys()) cells.set(t, probs.map(() => null));

  const subs = [...M.submissions.values()]
    .sort((a, b) => rel2sec(a.contest_time) - rel2sec(b.contest_time));

  // 判题类型表：solved / penalty 由数据决定，不硬编码类型名
  const jtMap = M.judgementTypes;

  for (const sub of subs) {
    const ti = cells.get(sub.team_id);
    const pi = pidx.get(sub.problem_id);
    if (!ti || pi === undefined) continue;
    const j = verdict.get(sub.id);
    const jtId = j ? (j.judgement_type_id || '') : null;
    const jt = jtId ? jtMap.get(jtId) : null;
    const ct = rel2sec(sub.contest_time);
    const c = ti[pi] || { attempts: 0, solvedAt: null, pending: false };

    if (c.solvedAt !== null) continue;            // 已通过，后续忽略

    if (!jtId) {                                  // 没有判题结论
      c.pending = true;
    } else if (jt && jt.solved) {                 // 通过
      c.solvedAt = ct;
      c.pending = false;
    } else if (!jt || jt.penalty) {               // 计罚时的失败（含未知类型）
      c.attempts++;
      c.lastAt = ct;
    }                                             // 其它：不计尝试不计罚时
    ti[pi] = c;
  }

  const rows = [];
  for (const [tid, list] of cells) {
    const t = M.teams.get(tid);
    let solved = 0, penalty = 0;
    list.forEach((c, i) => {
      if (c && c.solvedAt !== null) {
        solved++;
        penalty += c.solvedAt + c.attempts * penaltySec;
      }
    });
    rows.push({ team: t, cells: list, solved, penalty });
  }
  rows.sort((a, b) => b.solved - a.solved || a.penalty - b.penalty);
  rows.forEach((r, i) => { r.rank = i + 1; });
  return { rows, probs };
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

// ---------------- 总榜视图 ----------------
function renderStandings(pane, data) {
  const W = pane.clientWidth, H = pane.clientHeight;
  if (!W || !H) return;
  const { rows, probs } = data;
  const m = metrics(W, H, probs.length);
  applyVars(pane, m);

  const t = contestTimes();
  const rankW = textW('199', m.rowFont);
  const indent = BORDER + textW('199 ', m.rowFont) + m.rowH;

  let html = `
    <div class="title-band">
      <div class="clock left">${fmtClock(t.elapsed, true)}</div>
      <div class="title">Current Standings</div>
      <div class="clock right">${fmtClock(t.remain, true)}</div>
    </div>
    <div class="header-band">
      <div class="h" style="left:${BORDER + (rankW - textW('RANK', m.headerFont)) / 2}px">RANK</div>
      <div class="h" style="left:${indent}px">NAME</div>
      <div class="h" style="left:${W - BORDER - textW(' 9999', m.rowFont) - (textW('SOLVED', m.headerFont) + textW('99', m.rowFont)) / 2 - 12}px">SOLVED</div>
      <div class="h" style="left:${W - BORDER - (textW('TIME', m.headerFont) + textW('9999', m.rowFont)) / 2}px">TIME</div>
      <div class="rule"></div>
    </div>
    <div class="rows"><div class="rows-inner">`;

  const cellFont = Math.min(
    m.statusFont,
    m.statusFont * (m.cubeW - 8) / Math.max(1, textW('44\u200A-\u200A1267', m.statusFont))
  );
  const cellTop = m.rowH * 0.6 + CUBE_INSET / 2 - 1;

  rows.forEach((r, idx) => {
    const t2 = r.team || {};
    const name = t2.display_name || t2.name || t2.id;
    const avail = Math.max(40, W - BORDER - textW('199 9 9999 ', m.rowFont) - m.rowH - indent);
    const nameFs = fitFont(name, m.rowFont, avail);
    const parts = [];
    parts.push(`<div class="rank" style="left:${BORDER + (rankW - textW(r.rank, m.rowFont)) / 2}px;width:${rankW}px">${r.rank}</div>`);
    parts.push(`<div class="name" style="left:${indent}px;font-size:${nameFs}px;max-width:${avail}px">${esc(name)}</div>`);
    if (r.solved > 0)
      parts.push(`<div class="solved" style="left:${W - BORDER - textW(' 9999', m.rowFont) - (textW('99', m.rowFont) + textW(String(r.solved), m.rowFont)) / 2}px">${r.solved}</div>`);
    if (r.penalty > 0)
      parts.push(`<div class="time" style="left:${W - BORDER - (textW('9999', m.rowFont) + textW(String(Math.floor(r.penalty / 60)), m.rowFont)) / 2}px">${Math.floor(r.penalty / 60)}</div>`);

    probs.forEach((p, i) => {
      const c = r.cells[i];
      let cls = 'empty', inner = `<span class="label">${esc(p.label)}</span>`;
      if (c && c.solvedAt !== null) {
        cls = 'solved';
        inner = `${c.attempts + 1}\u200A-\u200A${Math.floor(c.solvedAt / 60)}`;
      } else if (c && c.pending) {
        cls = 'pending'; inner = '?';
      } else if (c && c.attempts) {
        cls = 'failed'; inner = `${c.attempts}\u200A-\u200A${Math.floor(c.lastAt / 60)}`;
      }
      const x = indent + i * (m.cubeW + CUBE_INSET);
      parts.push(`<div class="cube ${cls}" style="left:${x}px;top:${cellTop}px;
        width:${m.cubeW}px;font-size:${cellFont}px">${inner}</div>`);
    });

    html += `<div class="row${idx % 2 === 0 ? ' odd' : ''}" style="top:${idx * m.rowH}px">${parts.join('')}</div>`;
  });

  html += `</div></div>`;
  pane.innerHTML = html;
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

function layout() {
  if (VIEW === 'standings' || VIEW === 'judge') {
    paneA.style.display = 'block';
    paneB.classList.add('hidden');
  }
}

function draw() {
  if (!dirty) return;
  dirty = false;
  const data = computeStandings();
  renderStandings(paneA, data);
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
  const [teams, problems, subs, judges, orgs, jtypes] = await Promise.all(
    ['teams', 'problems', 'submissions', 'judgements', 'organizations', 'judgement-types'].map(one));
  (teams || []).forEach(t => M.teams.set(t.id, t));
  (problems || []).forEach(p => M.problems.set(p.id, p));
  (subs || []).forEach(s => M.submissions.set(s.id, s));
  (judges || []).forEach(j => M.judgements.set(j.id, j));
  (orgs || []).forEach(o => M.orgs.set(o.id, o));
  (jtypes || []).forEach(t => M.judgementTypes.set(t.id, t));
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

// 渲染循环：由 rAF 驱动，暂停时不耗 CPU，恢复后立刻补画
function loop() {
  draw();
  requestAnimationFrame(loop);
}

window.addEventListener('resize', () => { dirty = true; });
layout();
bootstrap().then(() => {
  dirty = true;
  draw();          // 先把快照画出来，不等 SSE
  connect();
});
requestAnimationFrame(loop);
