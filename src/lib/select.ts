// Smart selection for the Select & Remove tool.
//
// Two ways in:
//  - wandSelect: click a point, flood-fills contiguous similar colors.
//  - lassoSelect: rough freehand outline. The "smart" part: inside the
//    outline we split colors into two clusters and keep the cluster that
//    looks LEAST like the fabric just outside the outline — so a sloppy
//    lasso that overlaps the garment still only grabs the foreign remnant.
//
// Both return a full-resolution mask over the cutout; applyRemoval() then
// erases it with a feathered edge (transparency, no inpainting).

export interface SelectionMask {
  width: number;
  height: number;
  data: Uint8Array; // 255 = selected
  count: number;
}

const ALPHA_MIN = 12; // below this a pixel is "already transparent"

function getImage(cv: HTMLCanvasElement): ImageData {
  return cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height);
}

/** Contiguous magic-wand selection from a seed point (cutout coords). */
export function wandSelect(
  cutout: HTMLCanvasElement, seedX: number, seedY: number, tolerance: number,
): SelectionMask | null {
  const w = cutout.width;
  const h = cutout.height;
  const sx = Math.round(seedX);
  const sy = Math.round(seedY);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  const d = getImage(cutout).data;
  if (d[(sy * w + sx) * 4 + 3] < ALPHA_MIN) return null; // clicked empty space

  // Seed color = mean of the opaque 3×3 neighbourhood (kills pixel noise).
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = sx + dx, y = sy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const q = (y * w + x) * 4;
      if (d[q + 3] >= ALPHA_MIN) { r += d[q]; g += d[q + 1]; b += d[q + 2]; n++; }
    }
  }
  r /= n; g /= n; b /= n;

  const tol2 = tolerance * tolerance * 3;
  const mask = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let sp = 0;
  let count = 0;
  const start = sy * w + sx;
  mask[start] = 255;
  stack[sp++] = start;

  const tryPush = (j: number) => {
    if (mask[j]) return;
    const q = j * 4;
    if (d[q + 3] < ALPHA_MIN) return;
    const dr = d[q] - r, dg = d[q + 1] - g, db = d[q + 2] - b;
    if (dr * dr + dg * dg + db * db <= tol2) {
      mask[j] = 255;
      stack[sp++] = j;
    }
  };

  while (sp) {
    const i = stack[--sp];
    count++;
    const px = i % w;
    if (px > 0) tryPush(i - 1);
    if (px < w - 1) tryPush(i + 1);
    if (i >= w) tryPush(i - w);
    if (i < w * (h - 1)) tryPush(i + w);
  }
  return count ? { width: w, height: h, data: mask, count } : null;
}

/** 3×3 majority vote over the interior — removes speckles, fills pinholes. */
function majoritySmooth(mask: Uint8Array, w: number, h: number, interior: Int32Array) {
  const src = mask.slice();
  for (let k = 0; k < interior.length; k++) {
    const i = interior[k];
    const x = i % w;
    const y = (i / w) | 0;
    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
    let cnt = 0;
    for (let dy = -1; dy <= 1; dy++) {
      const row = i + dy * w;
      if (src[row - 1]) cnt++;
      if (src[row]) cnt++;
      if (src[row + 1]) cnt++;
    }
    mask[i] = cnt >= 5 ? 255 : 0;
  }
}

/** Rough freehand outline (cutout coords) → smart mask of the foreign bits. */
export function lassoSelect(
  cutout: HTMLCanvasElement, pts: { x: number; y: number }[],
): SelectionMask | null {
  if (pts.length < 3) return null;
  const w = cutout.width;
  const h = cutout.height;
  const d = getImage(cutout).data;

  // Rasterise the outline: filled interior, plus a stroked band that gives
  // us the "context" pixels just outside the outline.
  const rc = document.createElement('canvas');
  rc.width = w;
  rc.height = h;
  const rx = rc.getContext('2d', { willReadFrequently: true })!;
  const tracePath = () => {
    rx.beginPath();
    rx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) rx.lineTo(pts[i].x, pts[i].y);
    rx.closePath();
  };
  tracePath();
  rx.fillStyle = '#fff';
  rx.fill();
  const polyA = rx.getImageData(0, 0, w, h).data;
  const band = Math.max(6, Math.round(Math.min(w, h) * 0.012));
  rx.clearRect(0, 0, w, h);
  tracePath();
  rx.lineWidth = band * 2;
  rx.strokeStyle = '#fff';
  rx.stroke();
  const ringA = rx.getImageData(0, 0, w, h).data;

  // Partition opaque pixels: inside the outline vs the surrounding ring.
  let interiorN = 0;
  let ringR = 0, ringG = 0, ringB = 0, ringN = 0;
  for (let i = 0; i < w * h; i++) {
    const q = i * 4;
    if (d[q + 3] < ALPHA_MIN) continue;
    if (polyA[q + 3] > 127) interiorN++;
    else if (ringA[q + 3] > 127) {
      ringR += d[q]; ringG += d[q + 1]; ringB += d[q + 2]; ringN++;
    }
  }
  if (!interiorN) return null;
  const interior = new Int32Array(interiorN);
  for (let i = 0, k = 0; i < w * h; i++) {
    if (polyA[i * 4 + 3] > 127 && d[i * 4 + 3] >= ALPHA_MIN) interior[k++] = i;
  }

  const mask = new Uint8Array(w * h);
  let count = 0;
  const selectAll = () => {
    for (let k = 0; k < interior.length; k++) mask[interior[k]] = 255;
    count = interior.length;
  };

  if (ringN < 60) {
    // Isolated remnant — nothing solid around the outline, take the lot.
    selectAll();
  } else {
    // 2-means over interior colors.
    const step = Math.max(1, Math.floor(interiorN / 20000));
    const samples: number[] = [];
    for (let k = 0; k < interiorN; k += step) samples.push(interior[k] * 4);

    let mr = 0, mg = 0, mb = 0;
    for (const q of samples) { mr += d[q]; mg += d[q + 1]; mb += d[q + 2]; }
    mr /= samples.length; mg /= samples.length; mb /= samples.length;

    const d2 = (q: number, r: number, g: number, b: number) => {
      const x = d[q] - r, y = d[q + 1] - g, z = d[q + 2] - b;
      return x * x + y * y + z * z;
    };
    const farthest = (r: number, g: number, b: number) => {
      let best = samples[0], bd = -1;
      for (const q of samples) {
        const dd = d2(q, r, g, b);
        if (dd > bd) { bd = dd; best = q; }
      }
      return best;
    };
    let q1 = farthest(mr, mg, mb);
    let c1: number[] = [d[q1], d[q1 + 1], d[q1 + 2]];
    const q2 = farthest(c1[0], c1[1], c1[2]);
    let c2: number[] = [d[q2], d[q2 + 1], d[q2 + 2]];

    let degenerate = false;
    for (let it = 0; it < 10; it++) {
      let s1 = [0, 0, 0, 0], s2 = [0, 0, 0, 0];
      for (const q of samples) {
        const s = d2(q, c1[0], c1[1], c1[2]) <= d2(q, c2[0], c2[1], c2[2]) ? s1 : s2;
        s[0] += d[q]; s[1] += d[q + 1]; s[2] += d[q + 2]; s[3]++;
      }
      if (!s1[3] || !s2[3]) { degenerate = true; break; }
      c1 = [s1[0] / s1[3], s1[1] / s1[3], s1[2] / s1[3]];
      c2 = [s2[0] / s2[3], s2[1] / s2[3], s2[2] / s2[3]];
    }

    const sep = Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2]);
    if (degenerate || sep < 14) {
      // Interior is one homogeneous thing — trust the outline literally.
      selectAll();
    } else {
      // The cluster least like the surrounding fabric is the unwanted one.
      const rr = ringR / ringN, rg = ringG / ringN, rb = ringB / ringN;
      const dc1 = Math.hypot(c1[0] - rr, c1[1] - rg, c1[2] - rb);
      const dc2 = Math.hypot(c2[0] - rr, c2[1] - rg, c2[2] - rb);
      const u = dc1 >= dc2 ? c1 : c2;
      const v = dc1 >= dc2 ? c2 : c1;
      for (let k = 0; k < interiorN; k++) {
        const i = interior[k];
        const q = i * 4;
        if (d2(q, u[0], u[1], u[2]) <= d2(q, v[0], v[1], v[2])) mask[i] = 255;
      }
      majoritySmooth(mask, w, h, interior);
      majoritySmooth(mask, w, h, interior);
      count = 0;
      for (let k = 0; k < interiorN; k++) if (mask[interior[k]]) count++;
    }
  }

  return count ? { width: w, height: h, data: mask, count } : null;
}

/** Erase the selected pixels from the cutout with a feathered edge. */
export function applyRemoval(cutout: HTMLCanvasElement, mask: SelectionMask, feather = 1.5) {
  const mc = document.createElement('canvas');
  mc.width = mask.width;
  mc.height = mask.height;
  const mcx = mc.getContext('2d')!;
  const mi = mcx.createImageData(mask.width, mask.height);
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i]) mi.data[i * 4 + 3] = 255;
  }
  mcx.putImageData(mi, 0, 0);

  const c = cutout.getContext('2d')!;
  c.save();
  c.globalCompositeOperation = 'destination-out';
  c.filter = `blur(${feather}px)`;
  c.drawImage(mc, 0, 0);
  c.filter = 'none';
  c.restore();
}

/** Tinted preview of a mask (pink fill, white rim) at cutout resolution. */
export function overlayForMask(mask: SelectionMask): HTMLCanvasElement {
  const { width: w, height: h, data } = mask;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const o = img.data;
  for (let i = 0; i < data.length; i++) {
    if (!data[i]) continue;
    const x = i % w;
    const y = (i / w) | 0;
    const edge =
      x === 0 || x === w - 1 || y === 0 || y === h - 1 ||
      !data[i - 1] || !data[i + 1] || !data[i - w] || !data[i + w];
    const q = i * 4;
    if (edge) {
      o[q] = 255; o[q + 1] = 255; o[q + 2] = 255; o[q + 3] = 235;
    } else {
      o[q] = 255; o[q + 1] = 64; o[q + 2] = 129; o[q + 3] = 105;
    }
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}
