import { PointerEvent as ReactPointerEvent, useEffect, useRef } from 'react';
import { BackgroundSpec, ItemData, ItemMeta, ShadowSpec, Tool, Transform } from '../types';
import { canvasToSubject, drawCover, layoutSubject, renderComposite, subjectToCanvas } from '../lib/compositor';
import { HealPoint, healRegion } from '../lib/inpaint';
import { cutoutToGhost, ghostToCutout, resolveSubject } from '../lib/ghost';

interface Props {
  meta: ItemMeta | null;
  data: ItemData | undefined;
  background: BackgroundSpec;
  bgImage: HTMLImageElement | null;
  shadow: ShadowSpec;
  tool: Tool;
  brushSize: number;
  aspect: number | null; // null = follow image aspect
  editVersion: number;
  onEdited: () => void;
}

interface Stroke {
  tool: Tool;
  r: number; // brush radius in image px
  pts: HealPoint[]; // heal points, image coords
  last: { x: number; y: number }; // image coords
}

export default function EditorCanvas(props: Props) {
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

  // Sizing happens inside draw() so a missed observer notification (hidden
  // tab, zero-size mount) can never leave the canvas permanently tiny.
  function draw() {
    const { meta, data, background, bgImage, shadow, tool, brushSize, aspect: presetAspect } = propsRef.current;
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

    // Ghost mannequin (when enabled) is rendered in place of the raw cutout;
    // it shares the cutout's dimensions so all layout math is unchanged.
    const subject = resolveSubject(data);

    renderComposite({
      ctx,
      width: w,
      height: h,
      background,
      bgImage,
      subject,
      transform: data.transform,
      shadow,
      checker: background.kind === 'transparent',
    });

    // Pending heal stroke preview (stroke points are cutout coords — map
    // through the ghost warp so the preview lands under the cursor)
    const st = strokeRef.current;
    if (st && st.tool === 'heal' && st.pts.length) {
      const L = layoutSubject(w, h, subject.width, subject.height, data.transform);
      ctx.fillStyle = 'rgba(255, 90, 140, 0.35)';
      for (const p of st.pts) {
        const g = cutoutToGhost(data, p.x, p.y);
        const c = subjectToCanvas(g.x, g.y, L, data.transform, subject.width, subject.height);
        ctx.beginPath();
        ctx.arc(c.x, c.y, brushSize / 2, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Brush cursor ring
    const cur = cursorRef.current;
    if (cur.visible && tool !== 'move') {
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
  ]);

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
    // when ghost is on, undo its warps so brushes hit the real cutout pixels
    const ip = ghostToCutout(data!, p.x, p.y);
    return { x: ip.x, y: ip.y, L };
  }

  function stampErase(from: { x: number; y: number }, to: { x: number; y: number }, r: number) {
    const { data } = propsRef.current;
    const c = data!.cutout!.getContext('2d')!;
    c.save();
    c.globalCompositeOperation = 'destination-out';
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
    c.restore();
    data!.cutoutRev++;
  }

  function stampRestore(p: { x: number; y: number }, r: number) {
    const { data } = propsRef.current;
    const cut = data!.cutout!;
    const c = cut.getContext('2d')!;
    c.save();
    c.beginPath();
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
    c.clip();
    c.drawImage(data!.original, 0, 0, cut.width, cut.height);
    c.restore();
    data!.cutoutRev++;
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
    const { tool, brushSize } = propsRef.current;

    if (tool === 'move') {
      dragRef.current = { sx: px, sy: py, t0: { ...rd.data.transform } };
      return;
    }
    const { x, y, L } = toImage(px, py);
    const r = brushSize / 2 / L.scale;
    const ip = { x, y };
    strokeRef.current = { tool, r, pts: [{ x, y, r }], last: ip };
    if (tool === 'erase') stampErase(ip, ip, r);
    if (tool === 'restore') stampRestore(ip, r);
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

    const st = strokeRef.current;
    if (st) {
      const { x, y } = toImage(px, py);
      const dx = x - st.last.x;
      const dy = y - st.last.y;
      const dist = Math.hypot(dx, dy);
      const step = Math.max(1, st.r * 0.6);
      if (dist >= step) {
        const n = Math.ceil(dist / step);
        for (let i = 1; i <= n; i++) {
          const mx = st.last.x + (dx * i) / n;
          const my = st.last.y + (dy * i) / n;
          if (st.tool === 'erase') stampErase({ x: st.last.x + (dx * (i - 1)) / n, y: st.last.y + (dy * (i - 1)) / n }, { x: mx, y: my }, st.r);
          if (st.tool === 'restore') stampRestore({ x: mx, y: my }, st.r);
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
    const st = strokeRef.current;
    if (st) {
      strokeRef.current = null;
      const { data, onEdited } = propsRef.current;
      if (st.tool === 'heal' && data?.cutout) {
        healRegion(data.cutout, st.pts);
        data.cutoutRev++;
      }
      onEdited();
      scheduleDraw();
    }
  }

  function onPointerLeave() {
    cursorRef.current.visible = false;
    scheduleDraw();
  }

  return (
    <div className="canvas-box" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="editor-canvas"
        style={{ cursor: props.tool === 'move' ? 'grab' : 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onPointerLeave={onPointerLeave}
      />
    </div>
  );
}
