export interface HealPoint {
  x: number;
  y: number;
  r: number;
}

/**
 * Content-aware fill for the magic heal brush.
 *
 * Fills the stroked region by flooding inward from its boundary (onion peel),
 * averaging already-known neighbor colors, then smooths the filled area.
 * Only pixels with meaningful alpha are treated as sources or targets, so
 * healing near a cutout edge cannot bleed transparency into the subject.
 */
export function healRegion(canvas: HTMLCanvasElement, pts: HealPoint[]) {
  if (!pts.length) return;
  const W = canvas.width;
  const H = canvas.height;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x - p.r);
    minY = Math.min(minY, p.y - p.r);
    maxX = Math.max(maxX, p.x + p.r);
    maxY = Math.max(maxY, p.y + p.r);
  }
  const bx = Math.max(0, Math.floor(minX) - 6);
  const by = Math.max(0, Math.floor(minY) - 6);
  const ex = Math.min(W, Math.ceil(maxX) + 6);
  const ey = Math.min(H, Math.ceil(maxY) + 6);
  const w = ex - bx;
  const h = ey - by;
  if (w <= 0 || h <= 0) return;

  const ctx = canvas.getContext('2d')!;
  const img = ctx.getImageData(bx, by, w, h);
  const d = img.data;

  const mask = new Uint8Array(w * h);
  for (const p of pts) {
    const r2 = p.r * p.r;
    const x0 = Math.max(0, Math.floor(p.x - p.r - bx));
    const x1 = Math.min(w - 1, Math.ceil(p.x + p.r - bx));
    const y0 = Math.max(0, Math.floor(p.y - p.r - by));
    const y1 = Math.min(h - 1, Math.ceil(p.y + p.r - by));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + bx - p.x;
        const dy = y + by - p.y;
        if (dx * dx + dy * dy <= r2) mask[y * w + x] = 1;
      }
    }
  }

  // Transparent pixels are neither targets nor sources.
  for (let i = 0; i < w * h; i++) {
    if (mask[i] && d[i * 4 + 3] <= 8) mask[i] = 0;
  }
  const origMask = mask.slice();

  const filled = new Uint8Array(w * h);
  let anySource = false;
  for (let i = 0; i < w * h; i++) {
    filled[i] = !mask[i] && d[i * 4 + 3] > 8 ? 1 : 0;
    if (filled[i]) anySource = true;
  }
  if (!anySource) return;

  // Seed the queue with masked pixels touching a known pixel, then flood inward.
  const inQ = new Uint8Array(w * h);
  const queue: number[] = [];
  const push = (i: number) => {
    if (mask[i] && !inQ[i]) {
      inQ[i] = 1;
      queue.push(i);
    }
  };
  for (let i = 0; i < w * h; i++) {
    if (!mask[i]) continue;
    const x = i % w;
    const y = (i / w) | 0;
    if (
      (x > 0 && filled[i - 1]) || (x < w - 1 && filled[i + 1]) ||
      (y > 0 && filled[i - w]) || (y < h - 1 && filled[i + w])
    ) {
      push(i);
    }
  }

  let qi = 0;
  while (qi < queue.length) {
    const i = queue[qi++];
    if (!mask[i]) continue;
    const x = i % w;
    const y = (i / w) | 0;
    let r = 0, g = 0, b = 0, n = 0;
    const acc = (j: number) => {
      if (filled[j]) {
        r += d[j * 4];
        g += d[j * 4 + 1];
        b += d[j * 4 + 2];
        n++;
      }
    };
    if (x > 0) acc(i - 1);
    if (x < w - 1) acc(i + 1);
    if (y > 0) acc(i - w);
    if (y < h - 1) acc(i + w);
    if (x > 0 && y > 0) acc(i - w - 1);
    if (x < w - 1 && y > 0) acc(i - w + 1);
    if (x > 0 && y < h - 1) acc(i + w - 1);
    if (x < w - 1 && y < h - 1) acc(i + w + 1);
    if (!n) continue;
    d[i * 4] = r / n;
    d[i * 4 + 1] = g / n;
    d[i * 4 + 2] = b / n;
    filled[i] = 1;
    mask[i] = 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }

  // Smooth the healed area to hide flood-fill streaks.
  for (let pass = 0; pass < 2; pass++) {
    const src = new Uint8ClampedArray(d);
    for (let i = 0; i < w * h; i++) {
      if (!origMask[i] || d[i * 4 + 3] <= 8) continue;
      const x = i % w;
      const y = (i / w) | 0;
      let r = 0, g = 0, b = 0, n = 0;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const j = ny * w + nx;
          if (src[j * 4 + 3] <= 8) continue;
          r += src[j * 4];
          g += src[j * 4 + 1];
          b += src[j * 4 + 2];
          n++;
        }
      }
      if (n) {
        d[i * 4] = r / n;
        d[i * 4 + 1] = g / n;
        d[i * 4 + 2] = b / n;
      }
    }
  }

  ctx.putImageData(img, bx, by);
}
