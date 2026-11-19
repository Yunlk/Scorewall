/* 倒计时（#15 Countdown with sites status）
 *
 * 来源：
 *   StatusCountdownPresentation.paint()      状态文字 + 工位开关布局
 *   StatusCountdownPresentation.drawStatus() 三档滑块（红/橙/绿）
 *   CountdownPresentation                    七段数字（这里用多边形复刻）
 */

import { fmtClock } from './scoring.js';
import { drawDigital, digitalWidth } from './digital-font.js';

/** 工位滑块：三档 NO(0) / UNDECIDED(1) / YES(2) —— StatusCountdownPresentation.drawStatus */
function drawStatus(ctx, W, H, px, py, label, status) {
  const o = Math.floor(W / 75);
  const x0 = px - o / 2;
  const y = py - o / 2;
  const lightMode = false;

  // 两个空心圈
  ctx.strokeStyle = lightMode ? '#ccc' : 'gray';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x0 + o / 2, y + o / 2, o / 2, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x0 + o * 3 + o / 2, y + o / 2, o / 2, 0, Math.PI * 2);
  ctx.stroke();

  // 填充圈：val 0..100 映射到 0..3o 的横向位置
  const val = status === 0 ? 0 : status === 1 ? 50 : 100;
  const col = val < 5 ? 'red' : val > 95 ? 'lime' : 'orange';
  const fx = x0 + Math.round(val * o * 3 / 100);
  ctx.fillStyle = col;
  ctx.beginPath();
  ctx.arc(fx + o / 2, y + o / 2, o / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = lightMode ? '#000' : '#fff';
  ctx.stroke();

  // 标签：TextHelper.drawString 会按可用宽度缩字号
  const w = W * 3 / 10 - W * 6 / 75;
  let fs = o * 1.6;
  ctx.font = `${fs}px "ICPCFont", Arial, "Microsoft YaHei", sans-serif`;
  const tw = ctx.measureText(label).width;
  if (tw > w) fs = Math.max(8, fs * w / tw);
  ctx.font = `${fs}px "ICPCFont", Arial, "Microsoft YaHei", sans-serif`;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, px + o * 5, py);
}

/**
 * 画倒计时一帧。
 * @param sites [{label, status}]
 * @param remainMs 剩余毫秒（负数=还没开始）
 * @param running 比赛是否进行中
 */
export function drawCountdown(ctx, W, H, sites, remainMs, running) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  // 七段数字：DigitalFont 移植，灭段用暗灰一起画（仪表盘观感）
  const str = fmtClock(remainMs, true);
  let digitH = H * 0.30;
  let w = digitalWidth(str, digitH);
  const avail = W * 0.90;
  if (w > avail) { digitH *= avail / w; w = digitalWidth(str, digitH); }
  const bottomY = H * 0.56 + digitH / 2;          // 左下角 y
  drawDigital(ctx, str, (W - w) / 2, bottomY, digitH, '#fff', '#1e1e1e');

  // 状态文字（源码：y = (H + H/2.5)/2 + fm.getHeight()*2）
  let s = 'Status: Go';
  for (const it of sites) if (it.status === 0) s = 'Status: Active countdown';
  if (running) s = 'Status: Contest started';

  const statusFs = Math.max(12, Math.floor(H / 40));
  ctx.font = `${statusFs}px "ICPCFont", Arial, "Microsoft YaHei", sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#fff';
  const sy = (H + H / 2.5) / 2 + statusFs * 2;
  ctx.fillText(s, W / 2, sy);
  ctx.textAlign = 'left';

  // 工位开关：x = W/20 + (n%3)*W*3/10，y = 40 + (n/3)*(H/18)
  ctx.font = `${Math.floor(H / 40)}px "ICPCFont", Arial, "Microsoft YaHei", sans-serif`;
  sites.forEach((it, n) => {
    const px = Math.floor(W / 20 + (n % 3) * W * 3 / 10);
    const py = Math.floor(40 + Math.floor(n / 3) * (H / 18));
    drawStatus(ctx, W, H, px, py, it.label, it.status);
  });

  // 右下角也放个 logo（源码用 contest logo，没有就跳过）
}
