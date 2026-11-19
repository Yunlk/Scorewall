/* 判题队列（#56 Judge Presentation）的核心状态机
 *
 * 来源：
 *   JudgePresentation.updateRecords()   —— 动作状态机与保留时长
 *   JudgePresentation.updateTargets()   —— 每帧重算目标行号
 *   JudgePresentation.createSubmissionRecord() —— 新记录从屏幕下方进入
 *   Animator / Movement                 —— 梯形速度曲线
 */

// ---------- 常量（JudgePresentation:34-39） ----------
export const TIME_TO_KEEP_SOLVED = 11000;
export const TIME_TO_KEEP_FAILED = 8000;
export const TIME_TO_KEEP_RECENT = 14000;
export const TIME_TO_FADE_RECENT = 2000;

const TEAMS_PER_SCREEN = 12;

/** Animator.Movement(acceleration, maxSpeed) */
export class Movement {
  constructor(acceleration, maxSpeed) { this.acceleration = acceleration; this.maxSpeed = maxSpeed; }
}
export const SUBMISSION_MOVEMENT = new Movement(5, 9);

/**
 * Animator 移植：梯形速度曲线
 * 源码 getValue() 分段公式照抄。
 */
export class Animator {
  constructor(x, move) {
    this.xInitial = x;
    this.xTarget = x;
    this.move = move;
    this.acc = move.acceleration;
    this.t = 0;
    this.t1 = 0;
    this.tCoast = 0;
    this.vTarget = 0;
  }

  incrementTimeMs(dt) { this.t += dt; }

  reset(x, vTarget = 0) {
    this.xInitial = x;
    this.xTarget = x;
    this.vTarget = vTarget;
    this.t = 0;
  }

  setTarget(xTarget) {
    if (xTarget === this.xTarget) return;     // 目标没变就不要重启动画
    const x = this.getValue();
    this.xInitial = x;
    this.xTarget = xTarget;
    this.t = 0;

    const d = xTarget - x;
    const sgn = Math.sign(d) || 1;
    const accAbs = this.move.acceleration;
    this.acc = accAbs * sgn;                  // 关键：加速度带方向
    const vmax = this.move.maxSpeed;
    const dist = Math.abs(d);
    const t1 = vmax / accAbs;
    const dAcc = accAbs * t1 * t1;            // 加速+减速覆盖的距离
    if (dist >= dAcc) {
      this.t1 = t1;
      this.tCoast = (dist - dAcc) / vmax;
    } else {
      this.t1 = Math.sqrt(dist / accAbs);     // 太短走三角形
      this.tCoast = 0;
    }
  }

  resetToTarget() { this.reset(this.xTarget, 0); }

  getValue() {
    const { t1, tCoast, acc, xInitial, xTarget, vTarget, move } = this;
    const sgn = Math.sign(xTarget - xInitial);
    let tt = this.t / 1000;
    if (tt < t1) return xInitial + (acc * tt * tt) / 2 + vTarget * tt;
    if (tt < t1 + tCoast) {
      tt -= t1;
      return xInitial + (acc * t1 * t1) / 2 + tt * move.maxSpeed * sgn + vTarget * (t1 + tt);
    }
    const total = t1 * 2 + tCoast;
    if (tt < total) {
      tt = total - tt;
      return xTarget - (acc * tt * tt) / 2 + vTarget * (total - tt);
    }
    return xTarget + vTarget * tt;
  }
}

export const Action = { MOVE_UP: 'MOVE_UP', MOVE_DOWN: 'MOVE_DOWN', MOVE_OUT: 'MOVE_OUT' };

/**
 * 队列本体。每帧调用 update(dt)，然后拿 records 的 anim.getValue() 当行号画。
 */
export class JudgeQueue {
  /**
   * @param opts.judged(sub)  -> 是否已判
   * @param opts.solved(sub)  -> 是否通过
   * @param opts.frozen()     -> 是否封榜中
   */
  constructor(opts = {}) {
    this.records = [];
    this.reservedRows = 0;
    this.opts = opts;
  }

  /** 新提交进队（JudgePresentation.createSubmissionRecord） */
  add(submission) {
    const existing = this.records.find(r => r.submission.id === submission.id);
    if (existing) { existing.submission = submission; return existing; }

    const last = this.records[this.records.length - 1];
    const initialX = last
      ? Math.min(last.anim.getValue() + 1, TEAMS_PER_SCREEN * 2)
      : 0;
    const sr = {
      submission,
      anim: new Animator(Math.max(initialX, TEAMS_PER_SCREEN + 2), SUBMISSION_MOVEMENT),
      action: null,
      actionAge: 0,
      fullAge: 0,
    };
    this.records.push(sr);
    this.updateTargets(false);
    return sr;
  }

  /** JudgePresentation.updateTargets */
  updateTargets(force) {
    const { judged, solved, frozen } = this.opts;
    let count = 0;
    const count2 = this.reservedRows;

    const numSolvedTotal = this.records.filter(r => solved && solved(r.submission)).length;
    let numSolved = numSolvedTotal;

    for (const sr of this.records) {
      let target = 0;
      if (this.reservedRows === 0) {
        target = count;
        if (sr.action === Action.MOVE_UP && sr.actionAge > TIME_TO_KEEP_SOLVED) {
          target = -TEAMS_PER_SCREEN;
        } else if (sr.action === Action.MOVE_DOWN && sr.actionAge > TIME_TO_KEEP_FAILED) {
          target = TEAMS_PER_SCREEN * 2;
        } else if (sr.action === Action.MOVE_OUT && sr.actionAge > TIME_TO_FADE_RECENT / 3) {
          // 滑出中不占行
        } else if (count < TEAMS_PER_SCREEN * 2) {
          count++;
        }
      } else {
        if (sr.action === Action.MOVE_UP) {
          if (sr.actionAge > TIME_TO_KEEP_SOLVED || numSolved > this.reservedRows) {
            target = -TEAMS_PER_SCREEN;
            numSolved--;
          } else target = count++;
        } else if (sr.action === Action.MOVE_DOWN && sr.actionAge > TIME_TO_FADE_RECENT / 2) {
          target = TEAMS_PER_SCREEN * 2;
        } else if (sr.action === Action.MOVE_OUT && sr.actionAge > TIME_TO_FADE_RECENT / 3) {
          // 不占行
        } else {
          target = count2++;
        }
      }
      if (force) sr.anim.reset(target);
      else sr.anim.setTarget(target);
    }
  }

  /** JudgePresentation.updateRecords */
  update(dt) {
    const { judged, solved, frozen } = this.opts;
    const remove = [];

    for (const sr of this.records) {
      sr.anim.incrementTimeMs(dt);
      sr.fullAge += dt;

      if (!sr.action) {
        if (frozen && frozen()) {
          if (sr.fullAge > TIME_TO_KEEP_RECENT) sr.action = Action.MOVE_OUT;
        } else if (judged && judged(sr.submission)) {
          sr.action = solved(sr.submission) ? Action.MOVE_UP : Action.MOVE_DOWN;
        }
      } else {
        sr.actionAge += dt;
      }

      const v = sr.anim.getValue();
      if (sr.action === Action.MOVE_UP && v < -1) remove.push(sr);
      else if (sr.action === Action.MOVE_DOWN && v > TEAMS_PER_SCREEN) remove.push(sr);
      else if (sr.action === Action.MOVE_OUT && sr.actionAge > TIME_TO_FADE_RECENT) remove.push(sr);
    }

    for (const r of remove) {
      const i = this.records.indexOf(r);
      if (i >= 0) this.records.splice(i, 1);
    }
    this.updateTargets(false);
  }

  /** 这一行当前的不透明度（MOVE_DOWN 淡出 / MOVE_OUT 消失） */
  alphaOf(sr) {
    if (sr.action === Action.MOVE_DOWN) {
      return Math.min(1.0, Math.max(0.1,
        1.0 - (sr.actionAge - TIME_TO_KEEP_FAILED * 0.75) * 2.0 / TIME_TO_KEEP_FAILED));
    }
    if (sr.action === Action.MOVE_OUT) {
      return Math.max(0, 1.0 - sr.actionAge / TIME_TO_FADE_RECENT);
    }
    return 1;
  }
}

export { TEAMS_PER_SCREEN };
