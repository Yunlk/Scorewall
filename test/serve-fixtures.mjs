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
const FIX = join(here, 'fixtures', 'contest');
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
  'start-status': null,
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
  if (path.startsWith('/api/contests/1')) {
    const rest = path.slice('/api/contests/1'.length).replace(/^\//, '');

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
          res.write(JSON.stringify({ type, id: item.id, data: item }) + '\n');
        }
      }
      // 心跳，保持连接
      const beat = setInterval(() => {
        try { res.write('\n'); } catch (_) { clearInterval(beat); }
      }, 15000);
      req.on('close', () => clearInterval(beat));
      return;
    }

    const file = COLLECTIONS[rest];
    if (file && existsSync(join(FIX, file + '.json'))) {
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
  });
  res.end(body);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`夹具服务: http://127.0.0.1:${PORT}/?src=http://127.0.0.1:${PORT}/api/contests/1&view=standings`);
});
