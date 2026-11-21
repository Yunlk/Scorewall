/* 判题队列状态机 —— JudgePresentation 逐行移植
 *
 * 对应源码：
 *   scoreboard/JudgePresentation.java:34-39   常量
 *   scoreboard/JudgePresentation.java:126-139 createSubmissionRecord
 *   scoreboard/JudgePresentation.java:195-244 updateTargets
 *   scoreboard/JudgePresentation.java:246-281 updateRecords
 *   scoreboard/JudgePresentation.java:160-193 paintImpl（透明度）
 *   internal/Animator.java                   梯形速度曲线
 *
 * 与 Java 的对应关系保持 1:1，唯一差异是 JS 里没有 synchronized。
 */

// ---------- JudgePresentation.java:34-39 ----------
export const TIME_TO_KEEP_SOLVED = 11000;
export const TIME_TO_KEEP_FAILED = 8000;
export const TIME_TO_KEEP_RECENT = 14000;
export const TIME_TO_FADE_RECENT = 2000;

/** AbstractScoreboardPresentation.DEFAULT_TEAMS_PER_SCREEN */
const TEAMS_PER_SCREEN = 12;

/** Animator.Movement(acceleration, maxSpeed) —— JudgePresentation.java:39 */
export class Movement {
  constructor(acceleration, maxSpeed) {
    this.acceleration = acceleration;
    this.maxSpeed = maxSpeed;
  }
}
export const SUBMISSION_MOVEMENT = new Movement(5, 9);

/**
 * Animator.java 完整移植。
 *
 * 关键点（之前漏掉、导致动画生硬的那段）：
 * setTarget() 会读当前速度 vInitial，若正在移动则把曲线起点倒推/前推，
 * 让速度连续，而不是把当前位置硬当作新的静止起点。
 */
export class Animator {
  constructor(x, move) {
    this.xInitial = x;
    this.xTarget = x;
    this.move = move;
    this.acc = move.acceleration;
    this.vTarget = 0;
    this.t1 = 0;
    this.tCoast = 0;
    this.tScale = 1;
    this.t = 0;
  }

  incrementTimeMs(dt) {
    this.t += dt;
  }

  getValue() {
    let tt = (this.t * this.tScale) / 1000;
    const { t1, tCoast, acc, xInitial, xTarget, vTarget, move } = this;
    if (tt < t1) {
      return xInitial + (acc * tt * tt) / 2 + vTarget * tt;
    } else if (tt < t1 + tCoast) {
      tt -= t1;
      return xInitial + (acc * t1 * t1) / 2 + tt * move.maxSpeed * Math.sign(xTarget - xInitial) + vTarget * (t1 + tt);
    } else if (tt < t1 * 2 + tCoast) {
      tt = t1 * 2 + tCoast - tt;
      return xTarget - (acc * tt * tt) / 2 + vTarget * (t1 * 2 + tCoast - tt);
    }
    return xTarget + vTarget * tt;
  }

  /** Animator.java getVelocity() —— private，仅供 setTarget 使用 */
  getVelocity() {
    let tt = (this.t * this.tScale) / 1000;
    const { t1, tCoast, acc, xTarget, xInitial, move } = this;
    if (tt < t1) return acc * tt * this.tScale;
    if (tt < t1 + tCoast) return move.maxSpeed * Math.sign(xTarget - xInitial) * this.tScale;
    if (tt < t1 * 2 + tCoast) {
      tt = t1 * 2 + tCoast - tt;
      return acc * tt * this.tScale;
    }
    return 0;
  }

  reset(x, v = 0) {
    this.xInitial = x;
    this.xTarget = x;
    this.t1 = 0;
    this.tCoast = 0;
    this.vTarget = v;
    this.tScale = 1;
    this.t = 0; // Java reset() 不清 t（因为它只配 setTarget 用），这里清掉更安全
  }

  /** Animator.resetToTarget()：把当前位置钉到目标上，不做滑动 */
  resetToTarget() {
    this.reset(this.xTarget, 0);
  }

  setTarget(x, v = 0) {
    if (x === this.xTarget && v === this.vTarget) return;

    const vInitial = this.getVelocity();

    // 设定起点/终点并复位时间
    this.xInitial = this.getValue();
    this.xTarget = x;
    this.vTarget = v;
    this.t = 0;
    this.tScale = 1;
    this.acc = this.move.acceleration;
    if (this.xTarget < this.xInitial) this.acc = -this.move.acceleration;

    // 已在移动中则修正曲线（Animator.java:118-135）
    if (vInitial !== 0) {
      const dt = Math.abs(vInitial / this.move.acceleration);            // 刹车耗时
      const a2 = -Math.sign(vInitial) * this.move.acceleration;          // 刹车加速度
      const xx = this.xInitial + vInitial * dt + (a2 * dt * dt) / 2;     // 停稳时的位置
      if (xx < Math.min(this.xInitial, this.xTarget) || xx > Math.max(this.xInitial, this.xTarget)) {
        // 需要先反向：把「零时刻」放到未来
        this.t = -Math.trunc(dt * 1000);
        if (Math.sign(this.xTarget - xx) !== Math.sign(this.xTarget - this.xInitial)) this.acc = -this.acc;
      } else {
        // 方向已经对了：把「零时刻」放到过去
        this.t = Math.trunc(dt * 1000);
      }
      this.xInitial = this.xInitial - (this.acc * dt * dt) / 2 - (this.t * v) / 1000;
    }

    this.t1 = Math.sqrt(Math.abs(this.xTarget - this.xInitial) / this.move.acceleration);

    // 超过最大速度就插入匀速段
    const mt = this.move.maxSpeed / this.move.acceleration;
    if (this.t1 > mt) {
      const d = this.move.acceleration * mt * mt;
      this.tCoast = (Math.abs(this.xTarget - this.xInitial) - d) / this.move.maxSpeed;
      this.t1 = mt;
    } else {
      this.tCoast = 0;
    }
  }

  getTarget() {
    return this.xTarget;
  }
}

/** JudgePresentation.Action */
export const Action = { MOVE_UP: 'MOVE_UP', MOVE_DOWN: 'MOVE_DOWN', MOVE_OUT: 'MOVE_OUT' };

/**
 * 队列本体。records 顺序 = Java List 顺序（先到的在前，行号小）。
 *
 * opts:
 *   judged(sub) -> boolean      已判（judgement 且带 judgement_type_id）
 *   solved(sub) -> boolean      通过
 *   frozen()    -> boolean      封榜中
 */
export class JudgeQueue {
  constructor(opts = {}) {
    this.records = [];
    this.reservedRows = 0;
    this.opts = opts;
    this.timeToKeepFailed = opts.timeToKeepFailed > 0 ? opts.timeToKeepFailed : TIME_TO_KEEP_FAILED;
    this.timeToKeepSolved = opts.timeToKeepSolved > 0 ? opts.timeToKeepSolved : TIME_TO_KEEP_SOLVED;
    this.timeToFadeRecent = opts.timeToFadeRecent > 0 ? opts.timeToFadeRecent : TIME_TO_FADE_RECENT;
  }

  /** JudgePresentation.createSubmissionRecord:126-139 */
  add(submission) {
    const existing = this.records.find(r => r.submission.id === submission.id);
    if (existing) {
      existing.submission = submission;
      return existing;
    }

    let initalX = 0;
    if (this.records.length > 0) {
      initalX = Math.min(this.records[this.records.length - 1].anim.getValue() + 1, TEAMS_PER_SCREEN * 2);
    }
    const sr = {
      submission,
      related: null,
      // Java: new Animator(Math.max(initalX, teamsPerScreen + 2), SUBMISSION_MOVEMENT)
      // → 起点永远在屏幕下方（14 行 ≈ 屏幕外 2 行），从底部滑上来
      anim: new Animator(Math.max(initalX, TEAMS_PER_SCREEN + 2), SUBMISSION_MOVEMENT),
      fullAge: 0,
      actionAge: 0,
      action: null,
    };
    this.records.push(sr);
    this.updateTargets(false);
    return sr;
  }

  /** JudgePresentation.handleSubmission:106-124（同 id 更新引用即可） */
  refresh(submission) {
    const r = this.records.find(x => x.submission.id === submission.id);
    if (r) {
      r.submission = submission;
      return true;
    }
    return false;
  }

  /** 最新一条记录的 anim 值（判断新记录该从哪一行进场） */
  lastValue() {
    const last = this.records[this.records.length - 1];
    return last ? last.anim.getValue() : 0;
  }

  /** JudgePresentation.updateTargets:195-244 */
  updateTargets(force) {
    if (this.reservedRows === 0) {
      let count = 0;
      for (const sr of this.records) {
        let target = count;
        if (sr.action === Action.MOVE_UP && sr.actionAge > this.timeToKeepSolved) {
          target = -TEAMS_PER_SCREEN;
        } else if (sr.action === Action.MOVE_DOWN && sr.actionAge > this.timeToKeepFailed) {
          target = TEAMS_PER_SCREEN * 2;
        } else if (sr.action === Action.MOVE_OUT && sr.actionAge > this.timeToFadeRecent / 3) {
          // 正在淡出：不占行
        } else if (count < TEAMS_PER_SCREEN * 2) {
          count++;
        }
        if (force) sr.anim.reset(target);
        else sr.anim.setTarget(target);
      }
      return;
    }

    // reservedRows != 0：封榜后给 Accepted 预留位置（JudgePresentation:222-236）
    let count = 0;
    let count2 = this.reservedRows;
    let numSolved = this.records.filter(sr => this.opts.solved && this.opts.solved(sr.submission)).length;
    for (const sr of this.records) {
      let target = 0;
      if (sr.action === Action.MOVE_UP) {
        if (sr.actionAge > this.timeToKeepSolved || numSolved > this.reservedRows) {
          target = -TEAMS_PER_SCREEN;
          numSolved--;
        } else target = count++;
      } else if (sr.action === Action.MOVE_DOWN && sr.actionAge > this.timeToFadeRecent / 2) {
        target = TEAMS_PER_SCREEN * 2;
      } else if (sr.action === Action.MOVE_OUT && sr.actionAge > this.timeToFadeRecent / 3) {
        // 不占行
      } else {
        target = count2++;
      }
      if (force) sr.anim.reset(target);
      else sr.anim.setTarget(target);
    }
  }

  /** JudgePresentation.updateRecords:246-281 */
  update(dt) {
    const { judged, solved, frozen } = this.opts;
    const remove = [];

    for (const sr of this.records) {
      sr.anim.incrementTimeMs(dt);
      sr.fullAge += dt;

      if (sr.action === null) {
        if (frozen && frozen()) {
          // 封榜时不透露判题结果，超时直接淡出
          if (sr.fullAge > TIME_TO_KEEP_RECENT) sr.action = Action.MOVE_OUT;
        } else if (judged && judged(sr.submission)) {
          sr.action = solved && solved(sr.submission) ? Action.MOVE_UP : Action.MOVE_DOWN;
        }
      } else {
        sr.actionAge += dt;
      }

      const v = sr.anim.getValue();
      if (sr.action === Action.MOVE_UP && v < -1) remove.push(sr);
      else if (sr.action === Action.MOVE_DOWN && v > TEAMS_PER_SCREEN) remove.push(sr);
      else if (sr.action === Action.MOVE_OUT && sr.actionAge > this.timeToFadeRecent) remove.push(sr);
    }

    for (const r of remove) {
      const i = this.records.indexOf(r);
      if (i >= 0) this.records.splice(i, 1);
    }

    // JudgePresentation.incrementTimeMs:141-146
    //   updateRecords(dt); updateTargets(false);  ← 每帧都要重算行号
    this.updateTargets(false);
  }

  /** JudgePresentation.paintImpl:181-188 —— 行透明度 */
  alphaOf(sr) {
    if (sr.action === Action.MOVE_DOWN) {
      return Math.min(1.0, Math.max(0.1, 1.0 - ((sr.actionAge - this.timeToKeepFailed * 0.75) * 2.0) / this.timeToKeepFailed));
    }
    if (sr.action === Action.MOVE_OUT) {
      return Math.max(0, 1.0 - sr.actionAge / this.timeToFadeRecent);
    }
    return 1;
  }
}

export { TEAMS_PER_SCREEN };
