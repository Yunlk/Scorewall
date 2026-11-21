import { JudgeQueue, Action } from "./src/judge-queue.js";
const status = new Map();
const q = new JudgeQueue({
  judged: s => status.has(s.id),
  solved: s => status.get(s.id) === "solved",
  frozen: () => false,
});
const sub = id => ({ id, team_id: "t" + id, problem_id: "A", contest_time: "0:01:00.000" });
q.add(sub("s1"));
q.add(sub("s2"));   // 后一条用来观察补位

let t = 0;
const STEP = 250;
function tick(ms) {
  let n = 0;
  while (n < ms) { q.update(STEP); n += STEP; t += STEP; }
}
tick(4000);                       // 两条都进场到位
console.log(`t=${t/1000}s  初始: ` + q.records.map((r,i)=>`行${i}:${r.anim.getValue().toFixed(2)}`).join(" "));

status.set("s1", "solved");        // ← 收到 AC
console.log(`\n=== 收到 AC（t=${t/1000}s）===`);
const r0 = q.records[0];
for (let k = 0; k < 60; k++) {
  tick(STEP);
  const a = r0.action || "-";
  const tag = [Action.MOVE_UP].includes(a) ? "UP" : a === "-" ? "--" : a;
  if (k % 4 === 0 || (a === Action.MOVE_UP && r0.anim.getValue() < 0 && r0.anim.getValue() > -2)) {
    console.log(`t=${(t/1000).toFixed(2)}s  action=${tag}  s1行=${r0.anim.getValue().toFixed(2)}  target=${r0.anim.getTarget()}  s2行=${q.records[1]?.anim.getValue().toFixed(2) ?? "(已移除)"}  alpha=${q.alphaOf(r0).toFixed(2)}`);
  }
  if (q.records.length < 2 && !q.records.includes(r0)) { console.log(`t=${(t/1000).toFixed(2)}s  s1 已移除，records=${q.records.length}`); break; }
}
