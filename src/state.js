/* 比赛状态 —— State.java + FreezeFilter.java 的移植
 *
 * 源码语义（判据是时间戳字段的有无，不是布尔标记）：
 *   isRunning()      = started != null && ended == null
 *   isFrozen()       = frozen  != null && thawed == null
 *   isFinal()        = finalized != null
 *   isDoneUpdating() = end_of_updates != null
 *
 * 冻结过滤（FreezeFilter）：
 *   freezeTime = duration - freezeDuration
 *   封榜期间，contestTime >= freezeTime 的提交，其 judgement 视为不存在
 */

const FIELDS = ['started', 'ended', 'frozen', 'thawed', 'finalized', 'end_of_updates'];

const ts = v => {
  if (v === null || v === undefined || v === '') return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
};

/** 把 CCS 的 state 对象包成带判据的接口 */
export function makeState(raw) {
  const s = raw || {};
  const f = {};
  for (const k of FIELDS) f[k] = ts(s[k]);

  return {
    raw: s,
    ...f,
    isRunning: () => f.started !== null && f.ended === null,
    isFrozen: () => f.frozen !== null && f.thawed === null,
    isFinal: () => f.finalized !== null,
    isDoneUpdating: () => f.end_of_updates !== null,
  };
}

/**
 * 封榜起点（秒）。没有 freeze 就返回 null。
 * @param durationMs 比赛时长（毫秒）
 * @param freezeMs   封榜时长（毫秒），来自 info.scoreboard_freeze_duration
 */
export function freezeAtSec(durationMs, freezeMs) {
  if (!freezeMs || freezeMs <= 0) return null;
  return Math.floor((durationMs - freezeMs) / 1000);
}

/**
 * 该提交的判题结论是否应被隐藏（FreezeFilter.filter）
 * @param subContestTimeSec 提交的 contest_time（秒）
 */
export function isJudgementHidden(state, subContestTimeSec, atSec) {
  if (atSec === null || atSec === undefined) return false;
  if (!state || !state.isFrozen()) return false;
  return subContestTimeSec >= atSec;
}
