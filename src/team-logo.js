/* 队伍校徽 —— 三处共用的实现
 *
 * 上游三处画队标，公式完全一致，只是尺寸基准不同：
 *
 *   AbstractScoreboardPresentation.getSmallTeamLogo:390-404
 *     org.getLogoImage(rowHeight - 10, rowHeight - 10, getModeTag(), true, true)
 *   drawTeamGrid / JudgePresentation.paintCell:314-318 / FirstToSolvePresentation:252-256
 *     nx = (rowHeight - img.width) / 2
 *     ny = (rowHeight - img.height) / 2
 *     g.drawImage(img, BORDER + fm.stringWidth("199 ") + nx, ny, null)
 *
 *   TeamTileHelper.paintTile:150-167（瓦片内）
 *     logoWidth = tileDim.height - 10
 *     gg.drawImage(logoImg, ww + (tileDim.height - logoImg.width) / 2,
 *                            (tileDim.height - logoImg.height) / 2, null)
 *
 * 选图走 ContestObject.getBestFileReference:410-455：先按 tag 过滤，再优先 SVG，
 * 否则挑尺寸最接近目标的。缩放走 ImageScaler.scaleImage:30-40，等比装进方框，不拉伸。
 */

const FONT = '"ICPCFont", Arial, "Microsoft YaHei", sans-serif';

/**
 * getBestFileReference：按 tag 过滤 → 优先 SVG → 挑尺寸最接近目标
 * @param org 组织对象（org.logo 是 FileReference 列表）
 * @param size 目标边长（像素）
 * @param tag 'dark' | 'light'（对应 FileReference.TAG_DARK / TAG_LIGHT）
 */
export function pickLogoRef(org, size, tag) {
  const list = Array.isArray(org && org.logo) ? org.logo
    : (org && org.logo ? [org.logo] : []);
  if (!list.length) return null;

  let pool = list;
  if (tag) {
    const withTag = list.filter(r => r && Array.isArray(r.tags) && r.tags.includes(tag));
    const untagged = list.filter(r => r && (!Array.isArray(r.tags) || !r.tags.length));
    if (withTag.length) pool = withTag;
    else if (untagged.length) pool = untagged;
  }

  const svg = pool.find(r => r && r.mime === 'image/svg+xml');
  if (svg) return svg;

  let best = null;
  for (const r of pool) {
    if (!r) continue;
    if (!best) { best = r; continue; }
    const bw = best.width || 0, bh = best.height || 0;
    const rw = r.width || 0, rh = r.height || 0;
    if (bw < size && bh < size) {
      if (rw > bw || rh > bh) best = r;
    } else if (bw > size && bh > size) {
      if (rw < bw || rh < bh) { if (rw >= size || rh >= size) best = r; }
    }
  }
  return best;
}

/**
 * 在 size×size 的方框内画队伍校徽
 * @param x 方框左边缘
 * @param y 方框上边缘
 * @param size 方框边长（行内是 rowH，瓦片内是 tileH）
 * @param team 队伍（读 organization_id / name）
 * @param orgs Map<orgId, org>
 * @param showLogo 是否画（config 里「显示校徽」开关）
 */
export function drawTeamLogo(ctx, x, y, size, team, orgs, showLogo) {
  if (!showLogo) return;
  // 调用方可能只给了 teamName，没给完整 team 对象 —— 别让一次取不到字段打断整行渲染
  if (!team || typeof team !== 'object') return;
  const org = orgs && team.organization_id ? orgs.get(team.organization_id) : null;
  const img = org && org._logoImg;

  if (img && img.complete && img.naturalWidth > 0) {
    // ImageScaler.scaleImage：等比缩到装进 size×size
    const sc = Math.min(size / img.naturalWidth, size / img.naturalHeight);
    const dw = Math.round(img.naturalWidth * sc);
    const dh = Math.round(img.naturalHeight * sc);
    // 再在方框内居中（不与 getSmallTeamLogo 的 nx/ny 重复计算，这里合并成一步）
    ctx.drawImage(img, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
    return;
  }

  // 没有组织/logo 时用队名首字 + 名字哈希出的颜色占位（上游是直接留空）
  let h = 0;
  for (const ch of String(team.name || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  ctx.save();
  ctx.fillStyle = `hsl(${h % 360},42%,40%)`;
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.floor(size * 0.52)}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(team.name || '?').charAt(0), x + size / 2, y + size / 2 + 1);
  ctx.restore();
}
