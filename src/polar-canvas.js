/* 圆环倒计时 —— PolarCountdownPresentation + CountdownPresentation + ClockPresentation 移植
 *
 * 源码：
 *   clock/PolarCountdownPresentation.java   三圈同心环（蓝=小时、黄=分钟、红=秒）
 *   clock/CountdownPresentation.java        clock 动画 + 封榜后变红 + 倒计时/正计时切换
 *   clock/ClockPresentation.java            DigitalFont 画中心数字
 *
 * 几何（PolarCountdownPresentation.setSize）：
 *   diam      = min(W,H) - verticalOffset - 5
 *   r(i)      = diam * (NUM_ARCS+1-i) / (NUM_ARCS+1) / 2      i=0 最外圈
 *   arcWidth  = diam / (NUM_ARCS+1) / 2 - ARC_GAP
 *
 * 角度（PolarCountdownPresentation.paint:51-62）：
 *   s = floor(clock/1000)，clock 为负表示倒计时
 *   s < 0 : angle[0] = -(59 + s%120)*6            // 秒
 *           angle[1] = -(60 + (s/60)%120)*6       // 分
 *           angle[2] = -(maxHours + (s/3600)%maxHours) * (360/maxHours)   // 时
 *   s >= 0: 同式但去掉那个 59/60 的偏移
 *   绘制时倒序取：外圈用 angle[2]，中圈 angle[1]，内圈 angle[0]
 */

import { drawDigital, digitalWidth } from './digital-font.js';

export const NUM_ARCS = 3;
export const ARC_GAP = 8;

/** ICPCColors.BLUE / YELLOW / RED */
export const ARC_COLORS = [
  [92, 138, 221],
  [255, 223, 54],
  [196, 58, 36],
];

const FAMILY = '"ICPCFont", Arial, "Microsoft YaHei", sans-serif';

/** CountdownPresentation.EOC_COLOR = RED.brighter().brighter().brighter() */
function brighter3(c) {
  const FACTOR = 0.7;
  const step = v => (v === 0 ? 0 : Math.min(Math.trunc(v / FACTOR), 255));
  let [r, g, b] = c;
  for (let k = 0; k < 3; k++) {
    r = step(r); g = step(g); b = step(b);
    if (r < 3 && r > 0) r = 3;
    if (g < 3 && g > 0) g = 3;
    if (b < 3 && b > 0) b = 3;
  }
  return [r, g, b];
}
const EOC_COLOR = brighter3(ARC_COLORS[2]);

const css = c => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;

/**
 * PolarCountdownPresentation.setSize 的几何
 * @param verticalOffset banner 高度的一半（没有 banner 时传 0）
 */
export function polarLayout(W, H, verticalOffset = 0) {
  const diam = Math.min(W, H) - verticalOffset - 5;

  const arcs = [];
  for (let i = 0; i < NUM_ARCS; i++) {
    const r = Math.trunc((diam * (NUM_ARCS + 1 - i)) / (NUM_ARCS + 1) / 2);
    arcs.push({
      cx: W / 2,
      cy: H / 2 - verticalOffset,
      r,
      x: W / 2 - r,
      y: H / 2 - r - verticalOffset,
      w: r * 2,
      h: r * 2,
    });
  }

  const arcWidth = Math.trunc(diam / (NUM_ARCS + 1) / 2) - ARC_GAP;
  return { W, H, diam, arcs, arcWidth, verticalOffset };
}

/**
 * 三个扇角（度，正数=逆时针，与 Java fillArc 的 extent 同号）
 * @param clockMs 负值表示倒计时
 * @param durationMs 比赛总时长
 */
export function polarAngles(clockMs, durationMs) {
  const angle = [0, 0, 0];
  const s = Math.floor(clockMs / 1000);
  const maxHours = Math.trunc(durationMs / 3600000);
  if (maxHours === 0) return angle;

  const perHour = 360 / maxHours;
  if (s < 0) {
    angle[0] = -(59 + (s % 120)) * 6;
    angle[1] = -(60 + (Math.trunc(s / 60) % 120)) * 6;
    angle[2] = Math.trunc(-((maxHours + (Math.trunc(s / 3600) % maxHours)) * perHour));
  } else {
    angle[0] = -(s % 120) * 6;
    angle[1] = -(Math.trunc(s / 60) % 120) * 6;
    angle[2] = Math.trunc(-((Math.trunc(s / 3600) % maxHours) * perHour));
  }
  return angle;
}

/** 一圈：填充环 + 用背景色挖掉内圆 */
function drawArc(ctx, dim, arcWidth, ang, color, bg) {
  const { x, y, w, h } = dim;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const r = w / 2;

  ctx.fillStyle = css(color);
  ctx.beginPath();
  // fillArc 填的是「扇形」：圆心 → 起点 → 弧 → 圆心。
  // canvas 的 arc() 只给弧，必须先 moveTo(cx, cy)，否则 closePath 连的是弦，画出来是弓形。
  ctx.moveTo(cx, cy);
  if (ang >= -360) {
    // Java: fillArc(x, y, w, h, 90, ang) —— 90° 是 12 点，ang 为负即顺时针
    ctx.arc(cx, cy, r, -Math.PI / 2, -(Math.PI / 2 + (ang * Math.PI) / 180));
  } else {
    // Java: fillArc(450+ang, -720-ang) —— 超过一整圈时画补集那一块
    const start = 450 + ang;
    const extent = -720 - ang;
    ctx.arc(cx, cy, r,
      -(start * Math.PI) / 180,
      -((start + extent) * Math.PI) / 180);
  }
  ctx.closePath();
  ctx.fill();

  // 挖空内圆，形成环
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.arc(cx, cy, Math.max(0, r - arcWidth), 0, Math.PI * 2);
  ctx.fill();
}

/**
 * 画一帧
 * @param opts { clockMs, durationMs, verticalOffset, nowMs, lightMode }
 */
export function drawPolarCountdown(ctx, W, H, opts = {}) {
  const { clockMs = 0, durationMs = 5 * 3600 * 1000, verticalOffset = 0, nowMs = 0 } = opts;

  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);

  const L = polarLayout(W, H, verticalOffset);
  const bg = '#000';

  const angle = polarAngles(clockMs, durationMs);
  // 外圈用小时、中圈分钟、内圈秒
  for (let i = 0; i < NUM_ARCS; i++) {
    drawArc(ctx, L.arcs[i], L.arcWidth, angle[NUM_ARCS - i - 1], ARC_COLORS[i], bg);
  }

  // 中心数字（ClockPresentation.paint）
  const time = fmtClockAbs(clockMs);
  const withSign = time.startsWith('-') ? time : '+' + time;

  // ClockPresentation.paint:64-68 —— 只有这两步，没有别的上限。
  // 但 digitalWidth 抄的是 DigitalFont.stringWidth = 876*(len-1) + Σadvance，
  // 而 drawDigital 每字符还有一次 -874/+1750，实际净推进多出一个字符宽，
  // 所以判断要不要缩的时候得把这个偏差算进去，否则会溢出屏幕。
  // 每个数字格的实际推进 = (-874 + 6109 + 1750) / 10240 ≈ 0.683 倍字高，
  // 冒号/减号更窄。直接按字符数 × 0.683 估总宽，比 stringWidth 的公式可靠。
  // 实测每字符横向推进 ≈ 0.48 × 字高（数字格 6109 + 步进 1750 - 左移 874，
  // 再除以 FONT_HEIGHT 10240 之后落在 0.48 附近），按它估宽能保证不溢出。
  const ADV = 0.55;   // 实测约 0.50，取 0.55 留 10% 余量
  let yh = Math.min(0.225 * W, H * 0.55);
  const maxH = (W * 0.94) / (withSign.length * ADV);
  if (yh > maxH) yh = maxH;
  const w = withSign.length * ADV * yh;

  const cx = (W - w) / 2;
  const cy = (H + H / 2.5) / 2 - verticalOffset;

  // getTextBackgroundColor() 返回 null —— 数字直接压在环上，不画底板
  drawDigital(ctx, withSign, cx, cy, yh, '#fff', null);
}

/** AbstractICPCPresentation.getTime(ms, true)：h:mm:ss，负值带前导 '-' */
function fmtClockAbs(ms) {
  const neg = ms < 0;
  let sec = Math.floor(Math.abs(ms) / 1000);
  const h = Math.floor(sec / 3600) % 48;
  const m = Math.floor(sec / 60) % 60;
  const s = sec % 60;
  const p = n => String(n).padStart(2, '0');
  return (neg ? '-' : '') + h + ':' + p(m) + ':' + p(s);
}

export { EOC_COLOR };
