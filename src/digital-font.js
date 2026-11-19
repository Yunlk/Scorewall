/* 七段数字 —— DigitalFont.java 的完整移植
 *
 * 坐标系：x ∈ [874, 6983]，y ∈ [-10204, 0]，左下角为原点
 * 缩放：scale = h / 10240
 *
 * 源码里每个字符都是先 translate(-874) 再画，画完前进一个宽度：
 *   数字 6109、冒号 1092、减号 4884
 */

// 7 段多边形（顺序：上、左上、右上、中、左下、右下、下）
const SEGMENTS = [
  [[6779, -10204], [5700, -9111], [2157, -9111], [1079, -10204]],
  [[874, -5714], [874, -10000], [1968, -8907], [1968, -5991], [1283, -5306]],
  [[5904, -5991], [5904, -8907], [6983, -10000], [6983, -5714], [6589, -5306]],
  [[5831, -5642], [6371, -5102], [5831, -4562], [2026, -4562], [1486, -5102], [2026, -5642]],
  [[1968, -4213], [1968, -1297], [874, -204], [874, -4475], [1283, -4898]],
  [[6983, -4475], [6983, -204], [5904, -1297], [5904, -4213], [6589, -4898]],
  [[6779, 0], [1079, 0], [2157, -1093], [5700, -1093]],
];

// 冒号上下两块
const COLON_TOP = [[1210, -7406], [1210, -8499], [2303, -8499], [2303, -7406]];
const COLON_BOTTOM = [[1210, -1501], [1210, -2491], [2303, -2491], [2303, -1501]];

// 减号
const MINUS = [[5219, -5642], [5758, -5102], [5219, -4562], [1414, -4562], [874, -5102], [1414, -5642]];

// 数字 -> 哪几段亮（digital2）
const DIGIT_MAP = {
  '0': [1, 1, 1, 0, 1, 1, 1],
  '1': [0, 0, 1, 0, 0, 1, 0],
  '2': [1, 0, 1, 1, 1, 0, 1],
  '3': [1, 0, 1, 1, 0, 1, 1],
  '4': [0, 1, 1, 1, 0, 1, 0],
  '5': [1, 1, 0, 1, 0, 1, 1],
  '6': [1, 1, 0, 1, 1, 1, 1],
  '7': [1, 0, 1, 0, 0, 1, 0],
  '8': [1, 1, 1, 1, 1, 1, 1],
  '9': [1, 1, 1, 1, 0, 1, 0],
};

const ADVANCE_DIGIT = 6109;
const ADVANCE_COLON = 1092;
const ADVANCE_MINUS = 4884;
const FONT_HEIGHT = 10240;

function poly(ctx, pts, ox, oy, scale) {
  ctx.beginPath();
  ctx.moveTo(ox + pts[0][0] * scale, oy + pts[0][1] * scale);
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(ox + pts[i][0] * scale, oy + pts[i][1] * scale);
  }
  ctx.closePath();
  ctx.fill();
}

/**
 * 对应 DigitalFont.drawString(g, s, x, y, h, fg, bg)
 * @param x 左下角 x
 * @param y 左下角 y
 * @param h 数字高度（像素）
 * @param fg 亮段颜色
 * @param bg 灭段颜色（null = 不画灭段）
 * @returns 总宽度（像素）
 */
export function drawDigital(ctx, s, x, y, h, fg, bg) {
  const scale = h / FONT_HEIGHT;
  let cur = x;

  for (const c of s) {
    cur -= 874 * scale;                        // 87: 每字符左移 874

    if (DIGIT_MAP[c]) {
      const bits = DIGIT_MAP[c];
      for (let i = 0; i < 7; i++) {
        if (bits[i] === 1) {
          ctx.fillStyle = fg;
          poly(ctx, SEGMENTS[i], cur, y, scale);
        } else if (bg) {
          ctx.fillStyle = bg;
          poly(ctx, SEGMENTS[i], cur, y, scale);
        }
      }
      cur += ADVANCE_DIGIT * scale;            // 111

    } else if (c === ':') {
      ctx.fillStyle = fg;
      poly(ctx, COLON_TOP, cur, y, scale);
      poly(ctx, COLON_BOTTOM, cur, y, scale);
      cur += ADVANCE_COLON * scale;            // 118

    } else if (c === '-') {
      ctx.fillStyle = fg;
      poly(ctx, MINUS, cur, y, scale);
      cur += ADVANCE_MINUS * scale;            // 130

    } else if (c === '.') {
      ctx.fillStyle = fg;
      poly(ctx, COLON_BOTTOM, cur, y, scale);
      cur += ADVANCE_COLON * scale;
    }

    cur += 1750 * scale;                       // 144: 所有字符统一步进
  }
  return cur - x;
}

/** 预估宽度（用于居中） */
export function digitalWidth(s, h) {
  // 对齐 DigitalFont.stringWidth：876*(len-1) + Σ advance
  const scale = h / FONT_HEIGHT;
  let w = 876 * Math.max(0, s.length - 1);
  for (const c of s) {
    if (DIGIT_MAP[c]) w += ADVANCE_DIGIT;
    else if (c === ':') w += ADVANCE_COLON;
    else if (c === '-') w += ADVANCE_MINUS;
    else if (c === '.') w += ADVANCE_COLON;
  }
  return w * scale;
}
