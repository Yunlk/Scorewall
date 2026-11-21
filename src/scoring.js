/* Scorewall —— 纯计算层（无 DOM 依赖，可在 Node 里单测）
 *
 * 判定与排名逻辑对齐上游源码：
 *   ContestModel/src/org/icpc/tools/contest/model/internal/Result.java#addSubmission
 */

/** RelativeTime "0:13:07.000" -> 秒 */
export function rel2sec(s) {
  const a = String(s || '0:0:0.000').replace(/^[-+]/, '').split(':');
  return Math.floor(+a[0] * 3600 + +a[1] * 60 + parseFloat(a[2] || 0));
}

/** AbstractICPCPresentation.getTime：h:mm:ss，未开赛加负号（仅当 h===0） */
export function fmtClock(ms, floor = true) {
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

/** RESTContestSource.getResolvedURL 对齐 */
export function resolveUrl(base, href) {
  if (!href) return '';
  if (/^https?:/i.test(href)) return href;
  const u = new URL(base);
  return href.startsWith('/')
    ? `${u.protocol}//${u.host}${href}`
    : `${base}/${href.replace(/^\/+/, '')}`;
}

/**
 * 计算排名。
 * @param model { contest, teams:Map, problems:Map, submissions:Map, judgements:Map, judgementTypes:Map }
 * @returns { rows, probs }
 */
export function computeStandings(model, opts = {}) {
  const { contest = {}, teams, problems, submissions, judgements } = model;
  // 封榜：FreezeFilter —— contestTime >= freezeAt 的判题视为不存在
  const hideJudgement = opts.hideJudgement || (() => false);
  const jtMap = model.judgementTypes || new Map();

  const probs = [...problems.values()].sort((a, b) => a.ordinal - b.ordinal);
  const pidx = new Map(probs.map((p, i) => [p.id, i]));
  const penaltySec = (Number(contest.penalty_time) || 20) * 60;

  // submission id -> judgement
  const verdict = new Map();
  for (const j of judgements.values()) verdict.set(j.submission_id, j);

  // teamId -> 每题状态
  const cells = new Map();
  for (const tid of teams.keys()) cells.set(tid, probs.map(() => null));

  const subs = [...submissions.values()]
    .sort((a, b) => rel2sec(a.contest_time) - rel2sec(b.contest_time));

  for (const sub of subs) {
    const ti = cells.get(sub.team_id);
    const pi = pidx.get(sub.problem_id);
    if (!ti || pi === undefined) continue;

    let j = verdict.get(sub.id);
    if (j && hideJudgement(sub)) j = null;      // 封榜隐藏
    const jtId = j ? (j.judgement_type_id || '') : null;
    const jt = jtId ? jtMap.get(jtId) : null;
    const ct = rel2sec(sub.contest_time);
    const c = ti[pi] || { attempts: 0, subs: 0, solvedAt: null, pending: false };

    if (c.solvedAt !== null) continue;          // 已通过，后续忽略

    // numSubmissions = numPending + numJudged，每一条都算
    c.subs++;
    c.lastAt = ct;

    if (!jt) {                                  // 没有结论，或类型表里查不到
      c.pending = true;                         // Java: if (jt == null) numPending++
    } else if (jt.solved) {                     // 通过
      c.solvedAt = ct;
      c.pending = false;
    } else if (jt.penalty) {                    // 计罚时的失败
      c.attempts++;
    }                                           // solved=false 且 penalty=false：不计
    ti[pi] = c;
  }

  // 一血：每题最早通过的那支队（源码 Result.isFirstToSolve）
  for (let pi = 0; pi < probs.length; pi++) {
    let best = null;
    for (const [, list] of cells) {
      const c = list[pi];
      if (c && c.solvedAt !== null && (best === null || c.solvedAt < best)) best = c.solvedAt;
    }
    if (best === null) continue;
    for (const [, list] of cells) {
      const c = list[pi];
      if (c && c.solvedAt === best) { c.isFTS = true; break; }   // 并列只标一个
    }
  }

  // Contest.calculateResultsAndStandings:1041-1069
  //   罚时 = Σ penaltyTime + getTimeInMin(AC 时间) * 60 * 1000
  //   getTimeInMin 是「整数分钟」不是秒 —— 65 秒按 1 分钟算
  //   lastSolution = 最后一题的 AC 分钟数，并列时用作二级比较
  const rows = [];
  for (const [tid, list] of cells) {
    const t = teams.get(tid) || { id: tid };
    let solved = 0, penalty = 0, lastSolution = -1;
    list.forEach(c => {
      if (c && c.solvedAt !== null) {
        solved++;
        const min = Math.floor(c.solvedAt / 60);
        penalty += min * 60 + c.attempts * penaltySec;
        if (min > lastSolution) lastSolution = min;
      }
    });
    rows.push({ team: t, cells: list, solved, penalty, lastSolution });
  }

  // Ranking.sort（PASS_FAIL 分支）：
  //   1) 过题数降序  2) 罚时升序  3) lastSolutionTime 升序  4) 队名 collator
  rows.sort((a, b) =>
    b.solved - a.solved ||
    a.penalty - b.penalty ||
    a.lastSolution - b.lastSolution ||
    String(a.team.name || '').localeCompare(String(b.team.name || ''), 'en')
  );

  // Ranking.rank（LIVE）：三项全同才并列 → 1,2,2,4
  let last = null;
  rows.forEach((r, i) => {
    if (last && r.solved === last.solved && r.penalty === last.penalty
      && r.lastSolution === last.lastSolution) {
      r.rank = last.rank;
    } else {
      r.rank = i + 1;
      last = r;
    }
  });
  return { rows, probs };
}
