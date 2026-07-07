import { BackgroundSpec, SceneId, ShadowSpec, Transform } from '../types';

export interface SubjectLayout {
  dx: number;
  dy: number;
  dw: number;
  dh: number;
  scale: number;
  cx: number; // subject center on canvas
  cy: number;
}

/** Where the subject cutout lands on a w×h canvas for a given transform. */
export function layoutSubject(
  w: number, h: number, sw: number, sh: number, t: Transform,
): SubjectLayout {
  const base = Math.min(w / sw, h / sh) * 0.82 * t.scale;
  const dw = sw * base;
  const dh = sh * base;
  const dx = (w - dw) / 2 + t.x * w;
  const dy = (h - dh) / 2 + t.y * h;
  return { dx, dy, dw, dh, scale: base, cx: dx + dw / 2, cy: dy + dh / 2 };
}

/** Canvas point → cutout-image point, honouring rotation and flips. */
export function canvasToSubject(
  px: number, py: number, L: SubjectLayout, t: Transform, sw: number, sh: number,
): { x: number; y: number } {
  const rad = (-t.rotation * Math.PI) / 180;
  const vx = px - L.cx;
  const vy = py - L.cy;
  const ca = Math.cos(rad);
  const sa = Math.sin(rad);
  let rx = vx * ca - vy * sa;
  let ry = vx * sa + vy * ca;
  if (t.flipX) rx = -rx;
  if (t.flipY) ry = -ry;
  return { x: rx / L.scale + sw / 2, y: ry / L.scale + sh / 2 };
}

/** Cutout-image point → canvas point, honouring rotation and flips. */
export function subjectToCanvas(
  ix: number, iy: number, L: SubjectLayout, t: Transform, sw: number, sh: number,
): { x: number; y: number } {
  let rx = (ix - sw / 2) * L.scale;
  let ry = (iy - sh / 2) * L.scale;
  if (t.flipX) rx = -rx;
  if (t.flipY) ry = -ry;
  const rad = (t.rotation * Math.PI) / 180;
  const ca = Math.cos(rad);
  const sa = Math.sin(rad);
  return { x: L.cx + rx * ca - ry * sa, y: L.cy + rx * sa + ry * ca };
}

export function drawCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | HTMLCanvasElement,
  w: number,
  h: number,
) {
  const iw = img.width;
  const ih = img.height;
  if (!iw || !ih) return;
  const s = Math.max(w / iw, h / ih);
  const dw = iw * s;
  const dh = ih * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

let checkerTile: HTMLCanvasElement | null = null;
function getCheckerTile(): HTMLCanvasElement {
  if (!checkerTile) {
    const c = document.createElement('canvas');
    c.width = c.height = 24;
    const x = c.getContext('2d')!;
    x.fillStyle = '#26262e';
    x.fillRect(0, 0, 24, 24);
    x.fillStyle = '#33333e';
    x.fillRect(0, 0, 12, 12);
    x.fillRect(12, 12, 12, 12);
    checkerTile = c;
  }
  return checkerTile;
}

function linearGrad(
  ctx: CanvasRenderingContext2D,
  w: number, h: number, angleDeg: number, from: string, to: string,
): CanvasGradient {
  const a = ((angleDeg - 90) * Math.PI) / 180;
  const cx = w / 2;
  const cy = h / 2;
  const len = (Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a))) / 2;
  const g = ctx.createLinearGradient(
    cx - Math.cos(a) * len, cy - Math.sin(a) * len,
    cx + Math.cos(a) * len, cy + Math.sin(a) * len,
  );
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  return g;
}

function drawScene(ctx: CanvasRenderingContext2D, id: SceneId, w: number, h: number) {
  const vGrad = (from: string, to: string) => {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, from);
    g.addColorStop(1, to);
    return g;
  };
  const highlight = (alpha: number) => {
    const r = Math.max(w, h) * 0.75;
    const g = ctx.createRadialGradient(w / 2, h * 0.22, 0, w / 2, h * 0.22, r);
    g.addColorStop(0, `rgba(255,255,255,${alpha})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  };
  const floor = (alpha: number) => {
    const g = ctx.createLinearGradient(0, h * 0.68, 0, h);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${alpha})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, h * 0.68, w, h * 0.32);
  };

  switch (id) {
    case 'studio-light':
      ctx.fillStyle = vGrad('#f7f7fa', '#d4d4dc');
      ctx.fillRect(0, 0, w, h);
      highlight(0.85);
      floor(0.1);
      break;
    case 'studio-dark':
      ctx.fillStyle = vGrad('#34343e', '#0c0c10');
      ctx.fillRect(0, 0, w, h);
      highlight(0.12);
      floor(0.35);
      break;
    case 'sand':
      ctx.fillStyle = vGrad('#eeddc0', '#c9a87c');
      ctx.fillRect(0, 0, w, h);
      highlight(0.3);
      floor(0.12);
      break;
    case 'sage':
      ctx.fillStyle = vGrad('#dfe8dc', '#9db39a');
      ctx.fillRect(0, 0, w, h);
      highlight(0.3);
      floor(0.12);
      break;
    case 'sky':
      ctx.fillStyle = vGrad('#dff1ff', '#9cc8ee');
      ctx.fillRect(0, 0, w, h);
      highlight(0.4);
      floor(0.08);
      break;
    case 'blush':
      ctx.fillStyle = vGrad('#fbe3e8', '#e3a5b8');
      ctx.fillRect(0, 0, w, h);
      highlight(0.35);
      floor(0.1);
      break;
  }
}

export interface CompositeOpts {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  background: BackgroundSpec;
  bgImage?: HTMLImageElement | null;
  subject: HTMLCanvasElement;
  transform: Transform;
  shadow: ShadowSpec;
  checker?: boolean;
}

export function renderComposite(o: CompositeOpts) {
  const { ctx, width: w, height: h, background: bg } = o;

  if (bg.kind === 'transparent') {
    if (o.checker) {
      const pat = ctx.createPattern(getCheckerTile(), 'repeat')!;
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, w, h);
    }
  } else if (bg.kind === 'color') {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, w, h);
  } else if (bg.kind === 'gradient') {
    ctx.fillStyle = linearGrad(ctx, w, h, bg.angle, bg.from, bg.to);
    ctx.fillRect(0, 0, w, h);
  } else if (bg.kind === 'scene') {
    drawScene(ctx, bg.id, w, h);
  } else if (bg.kind === 'image' && o.bgImage) {
    drawCover(ctx, o.bgImage, w, h);
  }

  const sub = o.subject;
  const t = o.transform;
  const L = layoutSubject(w, h, sub.width, sub.height, t);
  const sh = o.shadow;
  const unit = Math.max(w, h) / 1000; // scale-independent shadow sizing
  const rad = (t.rotation * Math.PI) / 180;

  const drawSubject = () => {
    ctx.save();
    ctx.translate(L.cx, L.cy);
    ctx.rotate(rad);
    ctx.scale(t.flipX ? -1 : 1, t.flipY ? -1 : 1);
    ctx.drawImage(sub, -L.dw / 2, -L.dh / 2, L.dw, L.dh);
    ctx.restore();
  };

  if (sh.kind === 'ground' && sh.opacity > 0) {
    // ellipse sits under the rotated bounding box
    const hw = (Math.abs(Math.cos(rad)) * L.dw + Math.abs(Math.sin(rad)) * L.dh) / 2;
    const hh = (Math.abs(Math.sin(rad)) * L.dw + Math.abs(Math.cos(rad)) * L.dh) / 2;
    const cx = L.cx;
    const cy = L.cy + hh - 4 * unit;
    const rx = hw * 0.84;
    const ry = Math.max(6 * unit, hw * 0.11 + sh.blur * unit * 0.15);
    if (rx > 0 && ry > 0) {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, rx);
      g.addColorStop(0, `rgba(0,0,0,${sh.opacity})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(1, ry / rx);
      ctx.translate(-cx, -cy);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, rx, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  if (sh.kind === 'drop' && sh.opacity > 0) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${sh.opacity})`;
    ctx.shadowBlur = sh.blur * unit;
    ctx.shadowOffsetY = sh.offsetY * unit;
    drawSubject();
    ctx.restore();
  }

  drawSubject();
}
