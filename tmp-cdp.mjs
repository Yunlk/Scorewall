/* 用 CDP 控制真实 Edge，逐帧观察判题队列的 AC 动画
 * 用法：先启动 Edge --headless=new --remote-debugging-port=9222
 *      node tmp-cdp.mjs
 */
import { writeFileSync } from 'node:fs';

const PORT = 9222;
const PAGE = 'http://127.0.0.1:8090/?view=judge&test=1&src=http://127.0.0.1:8090/api/contests/7';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return r.json();
}

let ws, seq = 0;
const pending = new Map();

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout ' + method)); } }, 20000);
  });
}

async function connect() {
  const list = await targets();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('没有可用的 page target');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  };
}

async function evalJs(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r && r.result ? r.result.value : undefined;
}

async function shot(name, clipH = 420) {
  const r = await send('Page.captureScreenshot', {
    format: 'png',
    clip: { x: 0, y: 0, width: 1920, height: clipH, scale: 1 },
    captureBeyondViewport: false,
  });
  writeFileSync(name, Buffer.from(r.data, 'base64'));
  return name;
}

const t0 = Date.now();
const at = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

await connect();
await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: PAGE });

// 等页面加载 + 字体 + 首次 bootstrap
for (let i = 0; i < 40; i++) {
  await sleep(500);
  const ok = await evalJs('!!(document.getElementById("testbar") && window.performance)');
  if (ok) break;
}
await sleep(2500);

const ready = await evalJs('document.getElementById("testmsg") ? "panel" : "no-panel"');
console.log(`[${at()}] 面板: ${ready}`);

// 先清空，保证从空队列开始
await evalJs('document.querySelector("#testbar [data-act=clear]").click()');
await sleep(600);

// 1) 造一条提交，等它滑到位
await evalJs('document.querySelector("#testbar [data-act=sub]").click()');
console.log(`[${at()}] 点击「+ 提交」`);
await sleep(5000);
await shot('tmp-ac-0-before.png');
console.log(`[${at()}] 截图 0：提交进入并停在行 0`);

// 2) 判 AC
await evalJs('document.querySelector("#testbar [data-act=ac]").click()');
const tAC = Date.now();
console.log(`[${at()}] 点击「AC」`);

const marks = [1, 3, 6, 10, 11.2, 12.0, 12.6, 13.5];
let k = 0;
for (const m of marks) {
  const wait = m * 1000 - (Date.now() - tAC);
  if (wait > 0) await sleep(wait);
  const name = `tmp-ac-${++k}-${m}s.png`;
  await shot(name);
  const dbg = await evalJs('document.querySelector("#testmsg")?.textContent || ""');
  console.log(`[${at()}] AC 后 ${m}s → ${name}   (${dbg})`);
}

ws.close();
console.log('done');
