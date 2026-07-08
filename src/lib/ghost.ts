import { GhostOpts, ItemData } from '../types';

/**
 * Ghost mannequin ("hollow man") effect, computed procedurally in 3 passes:
 *
 * 1. Body warp — each pixel row is re-scaled horizontally around the garment
 *    center following a torso width profile (per garment type + fit), then
 *    each column is shifted down toward the sides (shoulder drape), giving a
 *    flat garment rounded shoulders and a worn silhouette.
 * 2. Neck / waist opening — the garment's real top-edge profile is scanned
 *    to find the collar line; an opening sized from the torso width (not the
 *    sleeve span) is carved into it and the interior back panel is rendered
 *    behind it using fabric color sampled from the photo.
 * 3. Volume shading — a soft-light gradient masked to the garment suggests
 *    body roundness.
 *
 * Both warps are analytically invertible (row scale + column shift), so the
 * retouch brushes stay cursor-accurate while the effect is enabled.
 */

export const DEFAULT_GHOST: GhostOpts = {
  garment: 'shirt',
  view: 'front',
  fit: 'male',
  volume: 0.6,
  neckWidth: 0.5,
  neckDepth: 0.5,
  neckY: 0,
};

// Width profiles: [t along garment height, inset factor]; row scale = 1 - inset * volume
const PROFILES: Record<string, [number, number][]> = {
  'shirt-male': [[0, 0.01], [0.12, 0], [0.3, 0.01], [0.55, 0.12], [0.75, 0.07], [1, 0.01]],
  'shirt-female': [[0, 0.01], [0.15, 0], [0.32, 0.005], [0.52, 0.18], [0.7, 0.08], [0.88, 0.02], [1, 0]],
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
      u = u * u * (3 - 2 * u);
      return 1 - (d0 + (d1 - d0) * u) * volume;
    }
  }
  return 1 - pts[pts.length - 1][1] * volume;
}

interface Scan {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  topCx: number; // alpha centroid of the top band
  torsoW: number; // garment width near the hem — excludes flat-lay sleeves
}

// Cutout analysis is expensive (full getImageData); cache it per revision so
// slider drags only redo the cheap warp passes.
const scanCache = new WeakMap<HTMLCanvasElement, { rev: number; scan: Scan | null }>();

function getScan(cutout: HTMLCanvasElement, rev: number): Scan | null {
  const hit = scanCache.get(cutout);
  if (hit && hit.rev === rev) return hit.scan;

  const w = cutout.width;
  const h = cutout.height;
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
  let scan: Scan | null = null;
  if (maxX >= 0 && maxY - minY >= 20) {
    const gh = maxY - minY;
    let tcSum = 0, tcN = 0;
    const bandEnd = minY + Math.max(4, Math.round(gh * 0.08));
    for (let y = minY; y <= bandEnd; y++) {
      for (let x = minX; x <= maxX; x += 2) {
        if (src[(y * w + x) * 4 + 3] > 16) { tcSum += x; tcN++; }
      }
    }
    // torso width: median row span over the 72–92% height band (below sleeves)
    const spans: number[] = [];
    for (let f = 0.72; f <= 0.92; f += 0.04) {
      const y = Math.min(h - 1, Math.round(minY + gh * f));
      let lo = -1, hi = -1;
      for (let x = minX; x <= maxX; x++) {
        if (src[(y * w + x) * 4 + 3] > 16) { if (lo < 0) lo = x; hi = x; }
      }
      if (lo >= 0) spans.push(hi - lo + 1);
    }
    spans.sort((a, b) => a - b);
    const torsoW = spans.length ? spans[Math.floor(spans.length / 2)] : (maxX - minX) * 0.5;
    scan = { minX, minY, maxX, maxY, topCx: tcN ? tcSum / tcN : (minX + maxX) / 2, torsoW };
  }
  scanCache.set(cutout, { rev, scan });
  return scan;
}

/** Returns the subject to composite: ghost canvas when enabled, else the raw cutout. */
export function resolveSubject(data: ItemData): HTMLCanvasElement {
  if (!data.cutout) return data.original;
  if (!data.ghost) return data.cutout;
  const key = JSON.stringify(data.ghost) + ':' + data.cutoutRev;
  if (data.ghostCache?.key === key) return data.ghostCache.canvas;
  data.ghostCache = buildGhost(data.cutout, data.ghost, data.cutoutRev, key);
  return data.ghostCache.canvas;
}

function idx(arr: Float32Array, i: number): number {
  return arr[Math.max(0, Math.min(arr.length - 1, Math.round(i)))];
}

/** Display (ghost) point → cutout point, for brush input while ghost is on. */
export function ghostToCutout(data: ItemData, x: number, y: number): { x: number; y: number } {
  const c = data.ghostCache;
  if (!data.ghost || !c) return { x, y };
  const sy = y - idx(c.dyByCol, x);
  const s = idx(c.scaleByRow, sy) || 1;
  return { x: c.cx + (x - c.cx) / s, y: sy };
}

/** Cutout point → display (ghost) point, for overlays drawn in cutout coords. */
export function cutoutToGhost(data: ItemData, x: number, y: number): { x: number; y: number } {
  const c = data.ghostCache;
  if (!data.ghost || !c) return { x, y };
  const s = idx(c.scaleByRow, y) || 1;
  const gx = c.cx + (x - c.cx) * s;
  return { x: gx, y: y + idx(c.dyByCol, gx) };
}

interface GhostBuild {
  key: string;
  canvas: HTMLCanvasElement;
  scaleByRow: Float32Array;
  dyByCol: Float32Array;
  cx: number;
}

function buildGhost(cutout: HTMLCanvasElement, opts: GhostOpts, rev: number, key: string): GhostBuild {
  const w = cutout.width;
  const h = cutout.height;
  const scaleByRow = new Float32Array(h).fill(1);
  const dyByCol = new Float32Array(w).fill(0);
  const scan = getScan(cutout, rev);
  if (!scan) {
    return { key, canvas: cutout, scaleByRow, dyByCol, cx: w / 2 };
  }
  const { minX, maxX, minY, maxY, topCx, torsoW } = scan;
  const gh = maxY - minY;
  const cx = (minX + maxX) / 2;
  const isShirt = opts.garment === 'shirt';

  // --- pass 1: horizontal body-profile warp ---
  const profile = PROFILES[`${opts.garment}-${opts.fit}`];
  for (let y = minY; y <= maxY; y++) {
    scaleByRow[y] = evalProfile(profile, (y - minY) / gh, opts.volume);
  }
  const mid = document.createElement('canvas');
  mid.width = w;
  mid.height = h;
  const mctx = mid.getContext('2d')!;
  for (let y = 0; y < h; y++) {
    const s = scaleByRow[y];
    if (s === 1) mctx.drawImage(cutout, 0, y, w, 1, 0, y, w, 1);
    else mctx.drawImage(cutout, 0, y, w, 1, cx * (1 - s), y, w * s, 1);
  }

  // --- pass 2: shoulder drape (columns droop toward the sides) ---
  const halfW = Math.max(1, (maxX - minX) / 2);
  const dropAmp = isShirt
    ? Math.min(gh * 0.05 * opts.volume, h - 1 - maxY) // don't push past the canvas
    : 0;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  if (dropAmp > 0.5) {
    for (let x = 0; x < w; x++) {
      const u = Math.min(1.15, Math.abs(x - cx) / halfW);
      dyByCol[x] = dropAmp * Math.pow(u, 1.8);
      octx.drawImage(mid, x, 0, 1, h, x, dyByCol[x], 1, h);
    }
  } else {
    octx.drawImage(mid, 0, 0);
  }

  // --- pass 3: volume shading (soft-light, masked to the garment) ---
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

  // --- pass 4: the opening, anchored to the garment's real top edge ---
  if (opts.neckDepth > 0.02) {
    // opening width from the torso, never the sleeve span
    const rx = (isShirt ? 0.15 + 0.17 * opts.neckWidth : 0.24 + 0.20 * opts.neckWidth)
      * torsoW * idx(scaleByRow, minY + gh * 0.05);
    const ncx = cx + (topCx - cx) * idx(scaleByRow, minY + 4);

    // scan the post-warp top-edge profile around the opening
    const x0 = Math.max(0, Math.floor(ncx - rx * 1.4));
    const x1 = Math.min(w, Math.ceil(ncx + rx * 1.4));
    const yLim = Math.min(h, Math.ceil(minY + gh * 0.45 + dropAmp));
    if (x1 - x0 > 8 && yLim > 4) {
      const band = octx.getImageData(x0, 0, x1 - x0, yLim).data;
      const cols = x1 - x0;
      const edge = new Float32Array(cols).fill(yLim);
      for (let i = 0; i < cols; i++) {
        for (let y = 0; y < yLim; y++) {
          if (band[(y * cols + i) * 4 + 3] > 16) { edge[i] = y; break; }
        }
      }
      // collar line: deepest top edge near the center of the opening
      let centerEdge = 0, found = false;
      const c0 = Math.max(0, Math.floor(ncx - rx * 0.3 - x0));
      const c1 = Math.min(cols - 1, Math.ceil(ncx + rx * 0.3 - x0));
      for (let i = c0; i <= c1; i++) {
        if (edge[i] < yLim) { centerEdge = Math.max(centerEdge, edge[i]); found = true; }
      }
      if (found) {
        const ry = gh * (0.02 + 0.09 * opts.neckDepth);
        const ncy = centerEdge + ry * (0.35 + opts.neckY * 0.7);

        // fabric color from a band just below the opening
        const sd = octx.getImageData(
          Math.max(0, Math.round(ncx - rx * 0.5)),
          Math.min(h - 4, Math.round(ncy + ry)),
          Math.max(2, Math.round(rx)),
          Math.max(4, Math.round(gh * 0.05)),
        ).data;
        let r = 0, g2 = 0, b = 0, n = 0;
        for (let i = 0; i < sd.length; i += 4) {
          if (sd[i + 3] > 128) { r += sd[i]; g2 += sd[i + 1]; b += sd[i + 2]; n++; }
        }
        if (!n) { r = 150; g2 = 150; b = 150; n = 1; }
        r /= n; g2 /= n; b /= n;
        const shade = (f: number) => `rgb(${Math.round(r * f)},${Math.round(g2 * f)},${Math.round(b * f)})`;

        // carve only the upper part of the ellipse — an open scoop, not a hole punch
        octx.save();
        octx.beginPath();
        octx.rect(x0, 0, x1 - x0, ncy + ry * 0.15);
        octx.clip();
        octx.globalCompositeOperation = 'destination-out';
        octx.beginPath();
        octx.ellipse(ncx, ncy, rx, ry, 0, 0, Math.PI * 2);
        octx.fill();
        octx.restore();

        // interior back panel: gradient + inner collar band, clipped to the
        // ellipse and trimmed above the garment's own top edge
        const interior = document.createElement('canvas');
        interior.width = w;
        interior.height = h;
        const ictx = interior.getContext('2d')!;
        ictx.save();
        ictx.beginPath();
        ictx.ellipse(ncx, ncy, rx, ry, 0, 0, Math.PI * 2);
        ictx.clip();
        const ig = ictx.createLinearGradient(0, ncy - ry, 0, ncy + ry * 0.3);
        if (opts.view === 'front') {
          ig.addColorStop(0, shade(0.85));
          ig.addColorStop(1, shade(0.28));
        } else {
          ig.addColorStop(0, shade(0.68));
          ig.addColorStop(1, shade(0.42));
        }
        ictx.fillStyle = ig;
        ictx.fillRect(ncx - rx, ncy - ry, rx * 2, ry * 2);
        ictx.strokeStyle = shade(opts.view === 'front' ? 0.95 : 0.8);
        ictx.lineWidth = Math.max(2, ry * 0.3);
        ictx.beginPath();
        ictx.ellipse(ncx, ncy, rx * 0.96, ry * 0.88, 0, Math.PI, Math.PI * 2);
        ictx.stroke();
        ictx.restore();
        // Trim spill: the interior may rise above the front collar curve (that
        // is the point — you are looking at the inside back panel), but never
        // above the collar-point line, and never in columns with no garment.
        let minEdge = yLim;
        for (let i = 0; i < cols; i++) if (edge[i] < minEdge) minEdge = edge[i];
        ictx.globalCompositeOperation = 'destination-out';
        ictx.fillRect(x0, 0, cols, Math.max(0, minEdge - 2));
        for (let i = 0; i < cols; i++) {
          if (edge[i] >= yLim) ictx.fillRect(x0 + i, 0, 1, h);
        }
        // show it only behind the garment / inside the carved scoop
        octx.globalCompositeOperation = 'destination-over';
        octx.drawImage(interior, 0, 0);
        octx.globalCompositeOperation = 'source-over';
      }
    }
  }

  return { key, canvas: out, scaleByRow, dyByCol, cx };
}
