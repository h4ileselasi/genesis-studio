import {
  PointerEvent as ReactPointerEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import {
  BackgroundSpec, ItemData, ItemMeta, MagnifierSpec, SelectMode, ShadowSpec, Tool, Transform,
} from '../types';
import { canvasToSubject, drawCover, layoutSubject, renderComposite, subjectToCanvas } from '../lib/compositor';
import { HealPoint, healRegion } from '../lib/inpaint';
import { SelectionMask, applyRemoval, lassoSelect, overlayForMask, wandSelect } from '../lib/select';

interface Props {
  meta: ItemMeta | null;
  data: ItemData | undefined;
  background: BackgroundSpec;
  bgImage: HTMLImageElement | null;
  shadow: ShadowSpec;
  tool: Tool;
  brushSize: number;
  hardness: number; // 0..1 — brush edge hardness (erase/restore)
  magnifier: MagnifierSpec;
  selectMode: SelectMode;
  wandTolerance: number;
  aspect: number | null; // null = follow image aspect
  editVersion: number;
  onEdited: () => void;
  onSelectionChange: (has: boolean) => void;
}

export interface EditorCanvasHandle {
  applySelection: () => void;
  clearSelection: () => void;
}

interface Stroke {
  tool: Tool;
  r: number; // brush radius in image px
  hard: number; // hardness locked at stroke start
  pts: HealPoint[]; // heal points, image coords
  last: { x: number; y: number }; // image coords
}

const BRUSH_TOOLS: Tool[] = ['erase', 'restore', 'heal'];

let loupeChecker: HTMLCanvasElement | null = null;
function getLoupeChecker(): HTMLCanvasElement {
  if (!loupeChecker) {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const x = c.getContext('2d')!;
    x.fillStyle = '#26262e';
    x.fillRect(0, 0, 16, 16);
    x.fillStyle = '#33333e';
    x.fillRect(0, 0, 8, 8);
    x.fillRect(8, 8, 8, 8);
    loupeChecker = c;
  }
  return loupeChecker;
}

const EditorCanvas = forwardRef<EditorCanvasHandle, Props>(function EditorCanvas(props, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  const sizeRef = useRef({ w: 0, h: 0 });
  const rafRef = useRef(0);
  const fallbackRef = useRef(0);
  const retryRef = useRef(0);
  const dragRef = useRef<{ sx: number; sy: number; t0: Transform } | null>(null);
  const strokeRef = useRef<Stroke | null>(null);
  const cursorRef = useRef({ x: 0, y: 0, visible: false });
  const scratchRef = useRef<HTMLCanvasElement | null>(null); // soft-restore stamp buffer
  const selectionRef = useRef<{ mask: SelectionMask; overlay: HTMLCanvasElement } | null>(null);
  const lassoRef = useRef<{ x: number; y: number }[] | null>(null); // canvas coords

  function dropSelection(notify = true) {
    lassoRef.current = null;
    if (selectionRef.current) {
      selectionRef.current = null;
      if (notify) propsRef.current.onSelectionChange(false);
    }
    scheduleDraw();
  }

  useImperativeHandle(ref, () => ({
    applySelection() {
      const sel = selectionRef.current;
      const { data, onEdited, onSelectionChange } = propsRef.current;
      if (!sel || !data?.cutout || sel.mask.width !== data.cutout.width) return;
      applyRemoval(data.cutout, sel.mask);
      selectionRef.current = null;
      onSelectionChange(false);
      onEdited();
      scheduleDraw();
    },
    clearSelection() {
      dropSelection();
    },
  }));

  // Sizing happens inside draw() so a missed observer notification (hidden
  // tab, zero-size mount) can never leave the canvas permanently tiny.
  function draw() {
    const {
      meta, data, background, bgImage, shadow, tool, brushSize, magnifier,
      aspect: presetAspect,
    } = propsRef.current;
    const el = containerRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;

    const availW = Math.max(0, el.clientWidth - 48);
    const availH = Math.max(0, el.clientHeight - 48);
    const imgAspect = data
      ? (data.cutout ?? data.original).width / (data.cutout ?? data.original).height
      : 4 / 3;
    const aspect = presetAspect ?? imgAspect;
    let w = availW;
    let h = aspect > 0 ? w / aspect : availH;
    if (h > availH) {
      h = availH;
      w = h * aspect;
    }
    w = Math.floor(w);
    h = Math.floor(h);
    if (w < 2 || h < 2) {
      // Container not laid out yet — try again shortly.
      if (!retryRef.current) {
        retryRef.current = window.setTimeout(() => {
          retryRef.current = 0;
          scheduleDraw();
        }, 200);
      }
      return;
    }
    sizeRef.current = { w, h };
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;

    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!meta || !data) return;

    if (meta.status !== 'ready' || !data.cutout) {
      ctx.globalAlpha = 0.35;
      drawCover(ctx, data.original, w, h);
      ctx.globalAlpha = 1;
      return;
    }

    const cut = data.cutout;
    renderComposite({
      ctx,
      width: w,
      height: h,
      background,
      bgImage,
      subject: cut,
      transform: data.transform,
      shadow,
      checker: background.kind === 'transparent',
    });

    const L = layoutSubject(w, h, cut.width, cut.height, data.transform);
    const t = data.transform;

    // Pending heal stroke preview
    const st = strokeRef.current;
    if (st && st.tool === 'heal' && st.pts.length) {
      ctx.fillStyle = 'rgba(255, 90, 140, 0.35)';
      for (const p of st.pts) {
        const c = subjectToCanvas(p.x, p.y, L, t, cut.width, cut.height);
        ctx.beginPath();
        ctx.arc(c.x, c.y, brushSize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Selection overlay (drawn in subject space so it tracks the transform)
    const sel = selectionRef.current;
    if (sel && sel.mask.width === cut.width && sel.mask.height === cut.height) {
      ctx.save();
      ctx.translate(L.cx, L.cy);
      ctx.rotate((t.rotation * Math.PI) / 180);
      ctx.scale(t.flipX ? -1 : 1, t.flipY ? -1 : 1);
      ctx.drawImage(sel.overlay, -L.dw / 2, -L.dh / 2, L.dw, L.dh);
      ctx.restore();
    }

    // Live lasso outline
    const lasso = lassoRef.current;
    if (lasso && lasso.length > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(lasso[0].x, lasso[0].y);
      for (let i = 1; i < lasso.length; i++) ctx.lineTo(lasso[i].x, lasso[i].y);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }

    const cur = cursorRef.current;
    const isBrush = BRUSH_TOOLS.includes(tool);

    // Magnifier loupe — floats beside the cursor while brushing so the
    // user's hand never hides the spot being edited. Drawn BEFORE the
    // cursor ring so the zoom snapshot doesn't contain the ring (we draw a
    // properly scaled ring inside the loupe instead).
    if (magnifier.enabled && cur.visible && isBrush) {
      const R = Math.max(40, Math.min(72, Math.min(w, h) * 0.18));
      const lift = R + brushSize / 2 + 26;
      let lx = cur.x;
      let ly = cur.y - lift;
      if (ly - R < 6) ly = cur.y + lift; // near top edge — flip below
      lx = Math.min(w - R - 6, Math.max(R + 6, lx));
      ly = Math.min(h - R - 6, Math.max(R + 6, ly));
      const z = Math.max(2, magnifier.zoom);

      ctx.save();
      ctx.beginPath();
      ctx.arc(lx, ly, R, 0, Math.PI * 2);
      ctx.clip();
      if (magnifier.mode === 'zoom') {
        // Zoomed snapshot of the canvas around the cursor. Source rect is
        // in device pixels because the canvas is its own image source.
        const srcSize = ((2 * R) / z) * dpr;
        ctx.drawImage(
          canvas,
          cur.x * dpr - srcSize / 2, cur.y * dpr - srcSize / 2, srcSize, srcSize,
          lx - R, ly - R, 2 * R, 2 * R,
        );
        // Brush ring at the loupe's scale
        ctx.beginPath();
        ctx.arc(lx, ly, (brushSize / 2) * z, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.55)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.95)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      } else {
        // Brush-profile preview: checkerboard + the actual alpha falloff.
        const pat = ctx.createPattern(getLoupeChecker(), 'repeat')!;
        ctx.fillStyle = pat;
        ctx.fillRect(lx - R, ly - R, 2 * R, 2 * R);
        const br = Math.min(R - 8, (brushSize / 2) * z);
        const hardStop = Math.max(0, Math.min(0.95, propsRef.current.hardness));
        const g = ctx.createRadialGradient(lx, ly, 0, lx, ly, br);
        g.addColorStop(0, 'rgba(255,255,255,0.92)');
        g.addColorStop(hardStop, 'rgba(255,255,255,0.92)');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(lx, ly, br, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      // Loupe rim
      ctx.beginPath();
      ctx.arc(lx, ly, R, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 4;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Brush cursor ring / select crosshair
    if (cur.visible && isBrush) {
      ctx.beginPath();
      ctx.arc(cur.x, cur.y, brushSize / 2, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  // rAF for smooth visible-tab drawing, with a timer fallback because rAF
  // never fires in hidden tabs (frames are suspended there).
  function scheduleDraw() {
    if (!fallbackRef.current) {
      fallbackRef.current = window.setTimeout(() => {
        fallbackRef.current = 0;
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        draw();
      }, 120);
    }
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      if (fallbackRef.current) {
        clearTimeout(fallbackRef.current);
        fallbackRef.current = 0;
      }
      draw();
    });
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => scheduleDraw());
    ro.observe(el);
    const onResize = () => scheduleDraw();
    const onVisible = () => scheduleDraw();
    window.addEventListener('resize', onResize);
    document.addEventListener('visibilitychange', onVisible);
    scheduleDraw();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisible);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (fallbackRef.current) clearTimeout(fallbackRef.current);
      if (retryRef.current) clearTimeout(retryRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    scheduleDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    props.meta?.id, props.meta?.status, props.background, props.bgImage,
    props.shadow, props.editVersion, props.tool, props.brushSize, props.aspect,
    props.hardness, props.magnifier, props.selectMode,
  ]);

  // A selection belongs to one cutout — drop it when the image changes,
  // gets re-cut, or the user leaves the select tool.
  useEffect(() => {
    dropSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.meta?.id, props.meta?.status]);
  useEffect(() => {
    if (props.tool !== 'select') dropSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tool]);

  // Wheel zoom needs a non-passive native listener.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const { meta, data, onEdited } = propsRef.current;
      if (!meta || !data || meta.status !== 'ready') return;
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.06 : 1 / 1.06;
      data.transform.scale = Math.min(4, Math.max(0.2, data.transform.scale * f));
      onEdited();
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

  function ready() {
    const { meta, data } = propsRef.current;
    return meta && data && meta.status === 'ready' && data.cutout ? { meta, data } : null;
  }

  function toImage(px: number, py: number) {
    const { data } = propsRef.current;
    const { w, h } = sizeRef.current;
    const cut = data!.cutout!;
    const L = layoutSubject(w, h, cut.width, cut.height, data!.transform);
    const p = canvasToSubject(px, py, L, data!.transform, cut.width, cut.height);
    return { x: p.x, y: p.y, L };
  }

  function brushStops(g: CanvasGradient, hard: number) {
    const inner = Math.max(0, Math.min(0.95, hard));
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(inner, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
  }

  function stampErase(from: { x: number; y: number }, to: { x: number; y: number }, r: number, hard: number) {
    const { data } = propsRef.current;
    const c = data!.cutout!.getContext('2d')!;
    c.save();
    c.globalCompositeOperation = 'destination-out';
    if (hard >= 0.99) {
      c.fillStyle = '#000';
      c.strokeStyle = '#000';
      if (from.x === to.x && from.y === to.y) {
        c.beginPath();
        c.arc(to.x, to.y, r, 0, Math.PI * 2);
        c.fill();
      } else {
        c.lineWidth = r * 2;
        c.lineCap = 'round';
        c.beginPath();
        c.moveTo(from.x, from.y);
        c.lineTo(to.x, to.y);
        c.stroke();
      }
    } else {
      // Soft brush: gradient stamp with alpha falloff past the hard core.
      const g = c.createRadialGradient(to.x, to.y, 0, to.x, to.y, r);
      brushStops(g, hard);
      c.fillStyle = g;
      c.beginPath();
      c.arc(to.x, to.y, r, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  function stampRestore(p: { x: number; y: number }, r: number, hard: number) {
    const { data } = propsRef.current;
    const cut = data!.cutout!;
    const orig = data!.original;
    if (hard >= 0.99) {
      const c = cut.getContext('2d')!;
      c.save();
      c.beginPath();
      c.arc(p.x, p.y, r, 0, Math.PI * 2);
      c.clip();
      c.drawImage(orig, 0, 0, cut.width, cut.height);
      c.restore();
      return;
    }
    // Soft restore: build a feathered stamp of the original in a scratch
    // buffer, then composite it over the cutout.
    const s = Math.max(2, Math.ceil(r * 2));
    let sc = scratchRef.current;
    if (!sc) {
      sc = document.createElement('canvas');
      scratchRef.current = sc;
    }
    if (sc.width < s) sc.width = s;
    if (sc.height < s) sc.height = s;
    const sx = sc.getContext('2d')!;
    sx.clearRect(0, 0, s, s);
    const g = sx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, r);
    brushStops(g, hard);
    sx.fillStyle = g;
    sx.beginPath();
    sx.arc(s / 2, s / 2, r, 0, Math.PI * 2);
    sx.fill();
    sx.globalCompositeOperation = 'source-in';
    const kx = orig.width / cut.width;
    const ky = orig.height / cut.height;
    sx.drawImage(orig, (p.x - s / 2) * kx, (p.y - s / 2) * ky, s * kx, s * ky, 0, 0, s, s);
    sx.globalCompositeOperation = 'source-over';
    cut.getContext('2d')!.drawImage(sc, 0, 0, s, s, p.x - s / 2, p.y - s / 2, s, s);
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    const rd = ready();
    if (!rd) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // untrusted/synthetic pointers can't be captured — brushing still works
    }
    const px = e.nativeEvent.offsetX;
    const py = e.nativeEvent.offsetY;
    const { tool, brushSize, hardness, selectMode, wandTolerance } = propsRef.current;

    if (tool === 'move') {
      dragRef.current = { sx: px, sy: py, t0: { ...rd.data.transform } };
      return;
    }

    if (tool === 'select') {
      dropSelection();
      if (selectMode === 'wand') {
        const p = toImage(px, py);
        const mask = wandSelect(rd.data.cutout!, p.x, p.y, wandTolerance);
        if (mask) {
          selectionRef.current = { mask, overlay: overlayForMask(mask) };
          propsRef.current.onSelectionChange(true);
        }
      } else {
        lassoRef.current = [{ x: px, y: py }];
      }
      scheduleDraw();
      return;
    }

    const { x, y, L } = toImage(px, py);
    const r = brushSize / 2 / L.scale;
    const ip = { x, y };
    strokeRef.current = { tool, r, hard: hardness, pts: [{ x, y, r }], last: ip };
    if (tool === 'erase') stampErase(ip, ip, r, hardness);
    if (tool === 'restore') stampRestore(ip, r, hardness);
    scheduleDraw();
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const px = e.nativeEvent.offsetX;
    const py = e.nativeEvent.offsetY;
    cursorRef.current = { x: px, y: py, visible: true };

    const drag = dragRef.current;
    if (drag) {
      const { data, onEdited } = propsRef.current;
      const { w, h } = sizeRef.current;
      if (data && w && h) {
        data.transform = {
          ...drag.t0,
          x: drag.t0.x + (px - drag.sx) / w,
          y: drag.t0.y + (py - drag.sy) / h,
        };
        onEdited();
      }
      return;
    }

    const lasso = lassoRef.current;
    if (lasso) {
      const last = lasso[lasso.length - 1];
      if (Math.hypot(px - last.x, py - last.y) > 3) lasso.push({ x: px, y: py });
      scheduleDraw();
      return;
    }

    const st = strokeRef.current;
    if (st) {
      const { x, y } = toImage(px, py);
      const dx = x - st.last.x;
      const dy = y - st.last.y;
      const dist = Math.hypot(dx, dy);
      // soft brushes stamp closer together for an even edge
      const step = Math.max(1, st.r * (st.hard >= 0.99 ? 0.6 : 0.35));
      if (dist >= step) {
        const n = Math.ceil(dist / step);
        for (let i = 1; i <= n; i++) {
          const mx = st.last.x + (dx * i) / n;
          const my = st.last.y + (dy * i) / n;
          if (st.tool === 'erase') stampErase({ x: st.last.x + (dx * (i - 1)) / n, y: st.last.y + (dy * (i - 1)) / n }, { x: mx, y: my }, st.r, st.hard);
          if (st.tool === 'restore') stampRestore({ x: mx, y: my }, st.r, st.hard);
          if (st.tool === 'heal') st.pts.push({ x: mx, y: my, r: st.r });
        }
        st.last = { x, y };
      }
    }
    scheduleDraw();
  }

  function onPointerUp() {
    if (dragRef.current) {
      dragRef.current = null;
      propsRef.current.onEdited();
    }
    const lasso = lassoRef.current;
    if (lasso) {
      lassoRef.current = null;
      const { data } = propsRef.current;
      if (lasso.length >= 3 && data?.cutout) {
        const imgPts = lasso.map((p) => {
          const q = toImage(p.x, p.y);
          return { x: q.x, y: q.y };
        });
        const mask = lassoSelect(data.cutout, imgPts);
        if (mask) {
          selectionRef.current = { mask, overlay: overlayForMask(mask) };
          propsRef.current.onSelectionChange(true);
        }
      }
      scheduleDraw();
      return;
    }
    const st = strokeRef.current;
    if (st) {
      strokeRef.current = null;
      const { data, onEdited } = propsRef.current;
      if (st.tool === 'heal' && data?.cutout) {
        healRegion(data.cutout, st.pts);
      }
      onEdited();
      scheduleDraw();
    }
  }

  function onPointerLeave() {
    cursorRef.current.visible = false;
    scheduleDraw();
  }

  const cursor = props.tool === 'move' ? 'grab' : props.tool === 'select' ? 'crosshair' : 'none';

  return (
    <div className="canvas-box" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="editor-canvas"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
      />
    </div>
  );
});

export default EditorCanvas;
