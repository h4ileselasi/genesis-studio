export interface RefreshOpts {
  smooth: number; // 0..1 — wrinkle-shading removal strength
  brighten: number; // 0..1 — "fresh laundry" luminance lift
}

/**
 * "Iron & freshen" for garments, done with frequency separation:
 *
 * Wrinkles read as mid-frequency shading on the fabric — softer than fine
 * texture (weave, seams) but sharper than the garment's overall light falloff.
 * We isolate that band as smallBlur(L) − bigBlur(L) on the luminance channel
 * and subtract it, which flattens wrinkle shadows while leaving both fine
 * detail and the large-scale shading intact. RGB is rescaled by the luminance
 * ratio so hue and saturation don't shift. Blurs are alpha-normalized so
 * transparent surroundings of the cutout can't bleed dark halos into edges.
 */
export function fabricRefresh(canvas: HTMLCanvasElement, opts: RefreshOpts) {
  const w = canvas.width;
  const h = canvas.height;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const n = w * h;

  const lum = new Float32Array(n);
  const mask = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (d[i * 4 + 3] > 8) {
      mask[i] = 1;
      lum[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
    }
  }

  const rSmall = Math.max(1, Math.round(Math.min(w, h) * 0.004));
  const rBig = Math.max(rSmall * 4, Math.round(Math.min(w, h) * 0.028));
  const small = blurNorm(lum, mask, w, h, rSmall);
  const big = blurNorm(lum, mask, w, h, rBig);

  const s = Math.max(0, Math.min(1, opts.smooth)) * 0.9;
  const br = Math.max(0, Math.min(1, opts.brighten));

  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const L0 = lum[i];
    if (L0 < 0.5) continue;
    const mid = small[i] - big[i];
    let L1 = L0 - s * mid;
    if (br > 0) L1 += br * 0.35 * (255 - L1) * (L1 / 255);
    const k = L1 / L0;
    d[i * 4] *= k;
    d[i * 4 + 1] *= k;
    d[i * 4 + 2] *= k;
  }

  ctx.putImageData(img, 0, 0);
}

/** Alpha-normalized approximate gaussian: blur(v·m)/blur(m), 2 box passes. */
function blurNorm(
  v: Float32Array, m: Float32Array, w: number, h: number, r: number,
): Float32Array {
  const a = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) a[i] = v[i] * m[i];
  const b = m.slice();
  const tmp = new Float32Array(v.length);
  for (let pass = 0; pass < 2; pass++) {
    boxPassH(a, tmp, w, h, r);
    boxPassV(tmp, a, w, h, r);
    boxPassH(b, tmp, w, h, r);
    boxPassV(tmp, b, w, h, r);
  }
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    out[i] = b[i] > 1e-4 ? a[i] / b[i] : v[i];
  }
  return out;
}

function boxPassH(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const win = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let x = -r; x <= r; x++) {
      sum += src[row + Math.min(w - 1, Math.max(0, x))];
    }
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum / win;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
}

function boxPassV(src: Float32Array, dst: Float32Array, w: number, h: number, r: number) {
  const win = 2 * r + 1;
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) {
      sum += src[Math.min(h - 1, Math.max(0, y)) * w + x];
    }
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum / win;
      sum += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
    }
  }
}
