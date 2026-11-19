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
const FIXES = { 1: join(here,'fixtures','smoke'), 2: join(here,'fixtures','scroll') };

// ---- 实时模拟：每 3 秒来一条提交，2.5 秒后出判题 ----
const LIVE = { subs: [], judges: [], clients: new Set(), n: 0 };
const TEAMS = ['t1','t2','t3'];
const PROBS = ['A','B','C'];
function emit(obj) {
  const line = JSON.stringify(obj) + '\n';
  for (const c of LIVE.clients) { try { c.write(line); } catch (_) {} }
}
function tick() {
  const i = LIVE.n++;
  const sec = 60 + i * 30;
  const mm = Math.floor(sec / 60), ss = sec % 60;
  const rel = `0:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}.000`;
  const sub = { id: 'L' + i, team_id: TEAMS[i % 3], problem_id: PROBS[i % 3], contest_time: rel };
  LIVE.subs.push(sub);
  emit({ type: 'submissions', id: sub.id, data: sub });
  const verdict = i % 3 === 0 ? 'WA' : 'AC';
  setTimeout(() => {
    const j = { id: 'JL' + i, submission_id: sub.id, judgement_type_id: verdict };
    LIVE.judges.push(j);
    emit({ type: 'judgements', id: j.id, data: j });
  }, 2500);
}
setInterval(tick, 3000);
let FIX = FIXES[1];
const PORT = Number(process.argv[2] || 8090);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
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
