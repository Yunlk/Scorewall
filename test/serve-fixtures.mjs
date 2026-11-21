/* 用夹具起一个假 CCS 服务，脱离适配器验证渲染
 *
 *   node test/serve-fixtures.mjs        -> http://127.0.0.1:8090
 *
 *   /                     静态文件（src/）
 *   /api/contests/1       比赛元信息
 *   /api/contests/1/<集合>  teams / problems / submissions / judgements /
 *                          organizations / judgement-types
 *   /api/contests/1/event-feed  一次性把全量当事件发出去，然后保持连接
 */
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const FIXES = { 1: join(here,'fixtures','smoke'), 2: join(here,'fixtures','scroll'), 4: join(here,'fixtures','lncpc') };
let FIX = FIXES[1];

// ---- 实时模拟：真实载荷 + 串行判题机 ----
// 提交每 3 秒一条；判题机一次判一条，耗时随机 3~20 秒（真实 10~180 秒，这里压缩）
// judgement 带完整时间戳（start/end_contest_time），和真 CCS 一致
const BASE = Date.parse('2026-01-01T00:00:00Z');
const LIVE = { subs: [], judges: [], pending: [], clients: new Set(), n: 0 };
const TEAMS = ['t1', 't2', 't3'];
const PROBS = ['A', 'B', 'C'];
// 真实分布：AC 偏多，其次是 WA
const VERDICTS = ['AC', 'AC', 'AC', 'AC', 'WA', 'WA', 'WA', 'TLE', 'RE', 'CE'];

const relOf = sec => `${Math.floor(sec / 3600)}:${String(Math.floor(sec % 3600 / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}.000`;
const isoOf = sec => new Date(BASE + sec * 1000).toISOString().replace('.000Z', '.000Z');

function emit(obj) {
  const line = JSON.stringify(obj) + '\n';
  for (const c of LIVE.clients) { try { c.write(line); } catch (_) {} }
}

function secondOf(rel) {
  const [h, m, sec] = rel.split(':');
  return (+h) * 3600 + (+m) * 60 + parseFloat(sec);
}

function tick() {
  const i = LIVE.n++;
  const sec = 60 + i * 30;
  const sub = {
    id: 'L' + i,
    team_id: TEAMS[i % 3],
    problem_id: PROBS[i % 3],
    contest_time: relOf(sec),
    time: isoOf(sec),
  };
  LIVE.subs.push(sub);
  LIVE.pending.push(sub);
  emit({ type: 'submissions', id: sub.id, data: sub });
}

function judgeTick() {
  const sub = LIVE.pending.shift();
  if (!sub) return;
  const i = Number(sub.id.slice(1));

  // 判题耗时随机（压缩到 3~20 秒）
  const judgeSec = 3 + Math.floor(Math.random() * 18);
  const verdict = VERDICTS[(i * 7) % VERDICTS.length];
  const startSec = secondOf(sub.contest_time) + 1;

  setTimeout(() => {
    const endSec = startSec + judgeSec;
    const j = {
      id: 'JL' + i,
      submission_id: sub.id,
      judgement_type_id: verdict,
      start_contest_time: relOf(startSec),
      end_contest_time: relOf(endSec),
      start_time: isoOf(startSec),
      end_time: isoOf(endSec),
    };
    LIVE.judges.push(j);
    emit({ type: 'judgements', id: j.id, data: j });
  }, judgeSec * 1000);
}

setInterval(tick, 3000);
setInterval(judgeTick, 2000);

const PORT = Number(process.argv[2] || 8090);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ttf': 'font/ttf',
};

const fixture = n => JSON.parse(readFileSync(join(FIX, n + '.json'), 'utf8'));

// 事件类型名 -> 夹具文件名
const COLLECTIONS = {
  teams: 'teams',
  problems: 'problems',
  submissions: 'submissions',
  judgements: 'judgements',
  organizations: null,
  'judgement-types': 'judgement-types',
  'start-status': 'start-status',
  state: 'state',
};

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  // ---- 假 CCS API ----
  // ---- DOMjudge 代理：/domjudge/<contest>/<集合> ----
  if (path.startsWith('/domjudge/')) {
    const rest = path.slice('/domjudge/'.length);
    const upstream = 'https://oj.yunlk.icu/api/v4/contests/' + rest;
    (async () => {
      try {
        const r = await fetch(upstream, { headers: { Accept: 'application/json' } });
        const text = await r.text();
        res.writeHead(r.ok ? 200 : (r.status === 401 ? 200 : r.status), {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        });
        // 401 的集合（judgements）返回空数组，页面不至于崩
        res.end(r.status === 401 ? '[]' : text);
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end('[]');
      }
    })();
    return;
  }

  const m = path.match(/^\/api\/contests\/(\d+)/);
  if (m) {
    FIX = FIXES[m[1]] || FIXES[1];
    const liveMode = m[1] === '3';
    const rest = path.slice(m[0].length).replace(/^\//, '');

    if (rest === '') return json(res, fixture('contest'));

    if (rest === 'event-feed') {
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
        Connection: 'keep-alive',
      });
      // 全量当事件发出去
      for (const [type, file] of Object.entries(COLLECTIONS)) {
        if (!file) continue;
        const list = fixture(file);
        const arr = Array.isArray(list) ? list : Object.values(list);
        for (const item of arr) {
          try {
            res.write(JSON.stringify({ type, id: item.id, data: item }) + '\n');
          } catch (_) { return; }
        }
      }
      // 心跳，保持连接
      const beat = setInterval(() => {
        try { res.write('\n'); } catch (_) { clearInterval(beat); }
      }, 15000);
      for (const sub of LIVE.subs) {
        try { res.write(JSON.stringify({ type: 'submissions', id: sub.id, data: sub }) + '\n'); } catch (_) {}
      }
      for (const j of LIVE.judges) {
        try { res.write(JSON.stringify({ type: 'judgements', id: j.id, data: j }) + '\n'); } catch (_) {}
      }
      LIVE.clients.add(res);
      req.on('close', () => { clearInterval(beat); LIVE.clients.delete(res); });
      return;
    }

    const file = COLLECTIONS[rest];
    if (file && existsSync(join(FIX, file + '.json'))) {
      if (liveMode && rest === 'submissions') return json(res, LIVE.subs);
      if (liveMode && rest === 'judgements') return json(res, LIVE.judges);
      if (liveMode && rest === 'state') {
        return json(res, { id: '1', started: '2026-01-01T00:00:00.000Z', ended: null,
                           frozen: null, thawed: null, finalized: null, end_of_updates: null });
      }
      return json(res, fixture(file));
    }
    return json(res, { error: 'not_found', rest }, 404);
  }

  // ---- 静态文件 ----
  let rel = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
  const full = join(SRC, rel);
  if (!full.startsWith(SRC) || !existsSync(full) || !statSync(full).isFile()) {
    res.writeHead(404); return res.end('not found');
  }
  const body = readFileSync(full);
  res.writeHead(200, {
    'Content-Type': MIME[extname(full)] || 'application/octet-stream',
    'Content-Length': body.length,
    'Cache-Control': 'no-store, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });
  res.end(body);
});

process.on('uncaughtException', e => {
  console.error('uncaught:', e && e.message);      // 夹具服务不能因为断连就挂
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`夹具服务: http://127.0.0.1:${PORT}/?src=http://127.0.0.1:${PORT}/api/contests/1&view=standings`);
});
