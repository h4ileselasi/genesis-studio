import { GhostOpts, ItemData } from '../types';

/**
 * Ghost mannequin ("hollow man") effect, computed procedurally:
 *
 * 1. Body warp — each pixel row of the garment is re-scaled horizontally
 *    around the garment's center following a torso width profile (different
 *    curves per garment type and fit), so a flat garment takes on a worn
 *    silhouette (shoulders, waist taper, hip flare).
 * 2. Opening — the neckline (shirts) or waistband (trousers) is carved out
 *    and the interior back panel is rendered behind it: a shaded surface
 *    using fabric color sampled from the photo, plus an inner collar band.
 * 3. Volume shading — a soft-light gradient masked to the garment suggests
 *    body roundness.
 *
 * The warp is horizontal-only, so it is exactly invertible per row — the
 * mapping helpers below keep the retouch brushes accurate while the effect
 * is enabled.
 */

export const DEFAULT_GHOST: GhostOpts = {
  garment: 'shirt',
  view: 'front',
  fit: 'male',
  volume: 0.5,
  neckWidth: 0.5,
  neckDepth: 0.45,
  neckY: 0,
};

// Width profiles: [t along garment height, inset factor]; row scale = 1 - inset * volume
const PROFILES: Record<string, [number, number][]> = {
  'shirt-male': [[0, 0.01], [0.12, 0], [0.3, 0.005], [0.55, 0.10], [0.75, 0.06], [1, 0.005]],
  'shirt-female': [[0, 0.01], [0.15, 0], [0.32, 0], [0.52, 0.16], [0.7, 0.07], [0.88, 0.02], [1, 0]],
  'trousers-male': [[0, 0.04], [0.12, 0], [0.3, 0.01], [1, 0.08]],
  'trousers-female': [[0, 0.06], [0.15, 0], [0.35, 0.005], [1, 0.09]],
};

function evalProfile(pts: [number, number][], t: number, volume: number): number {
  if (t <= pts[0][0]) return 1 - pts[0][1] * volume;
  for (let i = 0; i < pts.length - 1; i++) {
    const [t0, d0] = pts[i];
    const [t1, d1] = pts[i + 1];
    if (t <= t1) {
      let u = (t - t0) / (t1 - t0);
      u = u * u * (3 - 2 * u); // smoothstep between key points
      return 1 - (d0 + (d1 - d0) * u) * volume;
    }
  }
  return 1 - pts[pts.length - 1][1] * volume;
}

/** Returns the subject to composite: ghost canvas when enabled, else the raw cutout. */
export function resolveSubject(data: ItemData): HTMLCanvasElement {
  if (!data.cutout) return data.original;
  if (!data.ghost) return data.cutout;
  const key = JSON.stringify(data.ghost) + ':' + data.cutoutRev;
  if (data.ghostCache?.key === key) return data.ghostCache.canvas;
  data.ghostCache = buildGhost(data.cutout, data.ghost, key);
  return data.ghostCache.canvas;
}

/** Display (ghost) x → cutout x, for brush input while ghost is on. */
export function ghostToCutoutX(data: ItemData, x: number, y: number): number {
  const c = data.ghostCache;
  if (!data.ghost || !c) return x;
  const s = c.scaleByRow[Math.max(0, Math.min(c.scaleByRow.length - 1, Math.round(y)))] || 1;
  return c.cx + (x - c.cx) / s;
}

/** Cutout x → display (ghost) x, for overlays drawn in cutout coordinates. */
export function cutoutToGhostX(data: ItemData, x: number, y: number): number {
  const c = data.ghostCache;
  if (!data.ghost || !c) return x;
  const s = c.scaleByRow[Math.max(0, Math.min(c.scaleByRow.length - 1, Math.round(y)))] || 1;
  return c.cx + (x - c.cx) * s;
}

interface GhostBuild {
  key: string;
  canvas: HTMLCanvasElement;
  scaleByRow: Float32Array;
  cx: number;
}

function buildGhost(cutout: HTMLCanvasElement, opts: GhostOpts, key: string): GhostBuild {
  const w = cutout.width;
  const h = cutout.height;
  const scaleByRow = new Float32Array(h).fill(1);

  // --- garment bounding box + top-center from the alpha channel ---
  const src = cutout.getContext('2d')!.getImageData(0, 0, w, h).data;
  let minX = w, maxX = -1, minY = h, maxY = -1;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (src[(y * w + x) * 4 + 3] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0 || maxY - minY < 20) {
    return { key, canvas: cutout, scaleByRow, cx: w / 2 };
  }
  const gh = maxY - minY;
  const cx = (minX + maxX) / 2;

  // centroid of the top band → where the neck opening sits
  let tcSum = 0, tcN = 0;
  const bandEnd = minY + Math.max(4, Math.round(gh * 0.08));
  for (let y = minY; y <= bandEnd; y++) {
    for (let x = minX; x <= maxX; x += 2) {
      if (src[(y * w + x) * 4 + 3] > 16) { tcSum += x; tcN++; }
    }
  }
  const topCx = tcN ? tcSum / tcN : cx;

  // --- 1. body warp ---
  const profile = PROFILES[`${opts.garment}-${opts.fit}`];
  for (let y = minY; y <= maxY; y++) {
    scaleByRow[y] = evalProfile(profile, (y - minY) / gh, opts.volume);
  }
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  const strip = h > 1400 ? 2 : 1;
  for (let y = 0; y < h; y += strip) {
    const s = scaleByRow[y];
    const sh = Math.min(strip, h - y);
    if (s === 1) {
      octx.drawImage(cutout, 0, y, w, sh, 0, y, w, sh);
    } else {
      octx.drawImage(cutout, 0, y, w, sh, cx * (1 - s), y, w * s, sh);
    }
  }

  // --- 3. volume shading (before carving, so the opening rim stays clean) ---
  if (opts.volume > 0) {
    const a = 0.12 + 0.26 * opts.volume;
    const tmp = document.createElement('canvas');
    tmp.width = w;
    tmp.height = h;
    const tctx = tmp.getContext('2d')!;
    const g = tctx.createLinearGradient(minX, 0, maxX, 0);
    g.addColorStop(0, `rgba(0,0,0,${a})`);
    g.addColorStop(0.18, `rgba(0,0,0,${a * 0.45})`);
    g.addColorStop(0.5, `rgba(255,255,255,${a * 0.5})`);
    g.addColorStop(0.82, `rgba(0,0,0,${a * 0.45})`);
    g.addColorStop(1, `rgba(0,0,0,${a})`);
    tctx.fillStyle = g;
    tctx.fillRect(0, 0, w, h);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(out, 0, 0);
    octx.globalCompositeOperation = 'soft-light';
    octx.drawImage(tmp, 0, 0);
    octx.globalCompositeOperation = 'source-over';
  }

  // --- 2. neck / waistband opening with interior back panel ---
  if (opts.neckDepth > 0.02) {
    const sTop = scaleByRow[Math.min(h - 1, minY + 4)] || 1;
    const warpedTopW = (maxX - minX) * sTop;
    const ncx = cx + (topCx - cx) * sTop;
    const isShirt = opts.garment === 'shirt';
    const rxx = (isShirt ? 0.10 + 0.20 * opts.neckWidth : 0.18 + 0.24 * opts.neckWidth) * warpedTopW;
    const ry = gh * (isShirt ? 0.015 + 0.075 * opts.neckDepth : 0.008 + 0.04 * opts.neckDepth);
    const ncy = minY + ry * (1 + opts.neckY * 0.9) + gh * 0.004;

    // fabric color sampled from a band just below the opening (post-warp)
    const octxData = octx.getImageData(
      Math.max(0, Math.round(ncx - rxx * 0.6)),
      Math.max(0, Math.round(ncy + ry)),
      Math.max(2, Math.round(rxx * 1.2)),
      Math.max(4, Math.round(gh * 0.04)),
    ).data;
    let r = 0, g2 = 0, b = 0, n = 0;
    for (let i = 0; i < octxData.length; i += 4) {
      if (octxData[i + 3] > 128) { r += octxData[i]; g2 += octxData[i + 1]; b += octxData[i + 2]; n++; }
    }
    if (!n) { r = 150; g2 = 150; b = 150; n = 1; }
    r /= n; g2 /= n; b /= n;
    const shade = (f: number) => `rgb(${Math.round(r * f)},${Math.round(g2 * f)},${Math.round(b * f)})`;

    // keep the pre-carve alpha to mask the interior to the garment
    const preCarve = document.createElement('canvas');
    preCarve.width = w;
    preCarve.height = h;
    preCarve.getContext('2d')!.drawImage(out, 0, 0);

    // carve the opening
    octx.globalCompositeOperation = 'destination-out';
    octx.beginPath();
    octx.ellipse(ncx, ncy, rxx, ry, 0, 0, Math.PI * 2);
    octx.fill();
    octx.globalCompositeOperation = 'source-over';

    // interior back panel, shaded + inner collar band, masked to the garment
    const interior = document.createElement('canvas');
    interior.width = w;
    interior.height = h;
    const ictx = interior.getContext('2d')!;
    ictx.save();
    ictx.beginPath();
    ictx.ellipse(ncx, ncy, rxx, ry, 0, 0, Math.PI * 2);
    ictx.clip();
    const ig = ictx.createLinearGradient(0, ncy - ry, 0, ncy + ry);
    if (opts.view === 'front') {
      ig.addColorStop(0, shade(0.72));
      ig.addColorStop(1, shade(0.36));
    } else {
      ig.addColorStop(0, shade(0.62));
      ig.addColorStop(1, shade(0.46));
    }
    ictx.fillStyle = ig;
    ictx.fillRect(ncx - rxx, ncy - ry, rxx * 2, ry * 2);
    // inner collar band along the top of the opening
    ictx.strokeStyle = shade(opts.view === 'front' ? 0.88 : 0.78);
    ictx.lineWidth = Math.max(2, ry * 0.35);
    ictx.beginPath();
    ictx.ellipse(ncx, ncy, rxx * 0.97, ry * 0.9, 0, Math.PI, Math.PI * 2);
    ictx.stroke();
    ictx.restore();
    ictx.globalCompositeOperation = 'destination-in';
    ictx.drawImage(preCarve, 0, 0);
    octx.globalCompositeOperation = 'destination-over';
    octx.drawImage(interior, 0, 0);
    octx.globalCompositeOperation = 'source-over';
  }

  return { key, canvas: out, scaleByRow, cx };
}
