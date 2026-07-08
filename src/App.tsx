import { ChangeEvent, DragEvent, useCallback, useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import { BackgroundSpec, ItemData, ItemMeta, MagnifierSpec, SelectMode, ShadowSpec, Tool } from './types';
import { EXPORT_PRESETS } from './lib/presets';
import { removeBg } from './lib/removeBg';
import { renderComposite } from './lib/compositor';
import EditorCanvas, { EditorCanvasHandle } from './components/EditorCanvas';
import Panels, { ExportFormat, PanelTab } from './components/Panels';

const MAX_DIM = 2048;

const IDENTITY = { x: 0, y: 0, scale: 1, rotation: 0, flipX: false, flipY: false };

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = url;
  });
}

function imageToCanvas(img: HTMLImageElement, maxDim = Infinity): HTMLCanvasElement {
  const s = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.naturalWidth * s));
  c.height = Math.max(1, Math.round(img.naturalHeight * s));
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

function canvasToBlob(cv: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    cv.toBlob((b) => (b ? resolve(b) : reject(new Error('Export failed'))), type, quality);
  });
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function makeThumb(cv: HTMLCanvasElement): string {
  const s = 96 / Math.max(cv.width, cv.height);
  const t = document.createElement('canvas');
  t.width = Math.max(1, Math.round(cv.width * s));
  t.height = Math.max(1, Math.round(cv.height * s));
  t.getContext('2d')!.drawImage(cv, 0, 0, t.width, t.height);
  return t.toDataURL();
}

const TOOLS: { v: Tool; label: string; icon: string; hint: string }[] = [
  { v: 'move', label: 'Move', icon: '✥', hint: 'Drag to move, scroll to resize' },
  { v: 'erase', label: 'Erase', icon: '◌', hint: 'Brush away leftover background' },
  { v: 'restore', label: 'Restore', icon: '✚', hint: 'Paint back parts the AI removed' },
  { v: 'heal', label: 'Heal', icon: '✦', hint: 'Magic-erase blemishes, text, reflections' },
  { v: 'select', label: 'Select', icon: '⬚', hint: 'Smart-select a leftover patch, then remove it' },
];

export default function App() {
  const [metas, setMetas] = useState<ItemMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const dataRef = useRef(new Map<string, ItemData>());
  const busyRef = useRef(false);
  const [editVersion, setEditVersion] = useState(0);

  const [background, setBackground] = useState<BackgroundSpec>({ kind: 'transparent' });
  const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
  const [shadow, setShadow] = useState<ShadowSpec>({ kind: 'ground', opacity: 0.35, blur: 24, offsetY: 14 });
  const [tool, setTool] = useState<Tool>('move');
  const [brushSize, setBrushSize] = useState(36);
  const [hardness, setHardness] = useState(0.8);
  const [magnifier, setMagnifier] = useState<MagnifierSpec>({ enabled: true, mode: 'zoom', zoom: 3 });
  const [selectMode, setSelectMode] = useState<SelectMode>('lasso');
  const [wandTolerance, setWandTolerance] = useState(28);
  const [hasSelection, setHasSelection] = useState(false);
  const editorRef = useRef<EditorCanvasHandle>(null);
  const [tab, setTab] = useState<PanelTab>('background');
  const [exportPresetId, setExportPresetId] = useState('original');
  const [format, setFormat] = useState<ExportFormat>('png');
  const [quality, setQuality] = useState(0.92);
  const [exporting, setExporting] = useState(false);
  const [dragging, setDragging] = useState(false);

  const bump = useCallback(() => setEditVersion((v) => v + 1), []);
  const patchMeta = useCallback((id: string, patch: Partial<ItemMeta>) => {
    setMetas((ms) => ms.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const addFiles = useCallback(async (files: Iterable<File>) => {
    const added: ItemMeta[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      const url = URL.createObjectURL(f);
      try {
        const img = await loadImage(url);
        const original = imageToCanvas(img, MAX_DIM);
        const id = crypto.randomUUID();
        dataRef.current.set(id, { original, cutout: null, transform: { ...IDENTITY } });
        added.push({
          id,
          name: f.name.replace(/\.[^.]+$/, '') || 'image',
          status: 'queued',
          progress: 0,
          progressLabel: 'Waiting…',
          thumb: url,
        });
      } catch {
        URL.revokeObjectURL(url);
      }
    }
    if (added.length) {
      setMetas((ms) => [...ms, ...added]);
      setSelectedId((id) => id ?? added[0].id);
    }
  }, []);

  // Background-removal queue: one image at a time through the model.
  useEffect(() => {
    if (busyRef.current) return;
    const next = metas.find((m) => m.status === 'queued');
    if (!next) return;
    busyRef.current = true;
    patchMeta(next.id, { status: 'removing', progress: 0, progressLabel: 'Starting…' });
    (async () => {
      const data = dataRef.current.get(next.id);
      try {
        if (!data) throw new Error('Image data missing');
        const blob = await canvasToBlob(data.original);
        let lastP = -1;
        const out = await removeBg(blob, (p, label) => {
          if (Math.abs(p - lastP) > 0.02 || p >= 1) {
            lastP = p;
            patchMeta(next.id, { progress: p, progressLabel: label });
          }
        });
        const url = URL.createObjectURL(out);
        try {
          const img = await loadImage(url);
          data.cutout = imageToCanvas(img);
        } finally {
          URL.revokeObjectURL(url);
        }
        patchMeta(next.id, { status: 'ready', progress: 1, progressLabel: '', thumb: makeThumb(data.cutout) });
        bump();
      } catch (e) {
        patchMeta(next.id, {
          status: 'error',
          error: e instanceof Error ? e.message : String(e),
        });
      } finally {
        busyRef.current = false;
        setMetas((ms) => [...ms]); // let the queue pick the next item
      }
    })();
  }, [metas, patchMeta, bump]);

  // Preload custom backdrop image.
  useEffect(() => {
    if (background.kind === 'image') {
      let alive = true;
      const im = new Image();
      im.onload = () => { if (alive) setBgImage(im); };
      im.src = background.url;
      return () => { alive = false; };
    }
    setBgImage(null);
  }, [background]);

  // Paste images from clipboard.
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const fs = e.clipboardData?.files;
      if (fs?.length) addFiles(fs);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [addFiles]);

  const selected = metas.find((m) => m.id === selectedId) ?? null;
  const selData = selectedId ? dataRef.current.get(selectedId) : undefined;

  const removeItem = (id: string) => {
    const meta = metas.find((m) => m.id === id);
    if (meta?.thumb.startsWith('blob:')) URL.revokeObjectURL(meta.thumb);
    dataRef.current.delete(id);
    setMetas((ms) => {
      const rest = ms.filter((m) => m.id !== id);
      if (selectedId === id) setSelectedId(rest[0]?.id ?? null);
      return rest;
    });
  };

  const recut = () => {
    if (!selectedId) return;
    const d = dataRef.current.get(selectedId);
    if (d) d.cutout = null;
    patchMeta(selectedId, { status: 'queued', progress: 0, progressLabel: 'Waiting…' });
  };

  const retry = () => {
    if (selectedId) patchMeta(selectedId, { status: 'queued', progress: 0, progressLabel: 'Waiting…', error: undefined });
  };

  const preset = EXPORT_PRESETS.find((p) => p.id === exportPresetId) ?? EXPORT_PRESETS[0];
  const aspect = preset.w && preset.h ? preset.w / preset.h : null;

  const renderItem = (data: ItemData): HTMLCanvasElement => {
    const sub = data.cutout!;
    const w = preset.w ?? sub.width;
    const h = preset.h ?? sub.height;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext('2d')!;
    if (format !== 'png' && background.kind === 'transparent') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
    }
    renderComposite({
      ctx, width: w, height: h, background, bgImage,
      subject: sub, transform: data.transform, shadow, checker: false,
    });
    return cv;
  };

  const mime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  const ext = format === 'jpeg' ? 'jpg' : format;

  const exportCurrent = async () => {
    if (!selData?.cutout || !selected) return;
    setExporting(true);
    try {
      const blob = await canvasToBlob(renderItem(selData), mime, quality);
      download(blob, `${selected.name}-genesis.${ext}`);
    } finally {
      setExporting(false);
    }
  };

  const exportAll = async () => {
    const ready = metas.filter((m) => m.status === 'ready');
    if (!ready.length) return;
    setExporting(true);
    try {
      const zip = new JSZip();
      const used = new Set<string>();
      for (const m of ready) {
        const d = dataRef.current.get(m.id);
        if (!d?.cutout) continue;
        const blob = await canvasToBlob(renderItem(d), mime, quality);
        let name = `${m.name}-genesis.${ext}`;
        let i = 2;
        while (used.has(name)) name = `${m.name}-genesis-${i++}.${ext}`;
        used.add(name);
        zip.file(name, blob);
      }
      download(await zip.generateAsync({ type: 'blob' }), 'genesis-export.zip');
    } finally {
      setExporting(false);
    }
  };

  const onPickFiles = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.length) addFiles(e.target.files);
    e.target.value = '';
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
  };

  const readyCount = metas.filter((m) => m.status === 'ready').length;

  return (
    <div
      className="app"
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={(e) => { if (!e.relatedTarget) setDragging(false); }}
      onDrop={onDrop}
    >
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">G</span>
          <span>GENESIS <em>Studio</em></span>
        </div>
        <div className="topbar-right">
          <label className="btn ghost">
            + Add images
            <input type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
          </label>
          <button
            className="btn primary"
            disabled={!metas.length}
            onClick={() => setTab('export')}
          >
            Export
          </button>
        </div>
      </header>

      {metas.length === 0 ? (
        <div className="empty">
          <div className="empty-card">
            <div className="empty-glyph">✦</div>
            <h1>Studio-quality product photos,<br />right in your browser.</h1>
            <p>
              Drop a photo and the AI cuts out the subject automatically — then restage it
              on any backdrop, heal imperfections, and export marketplace-ready images.
              Nothing is uploaded; everything runs on your device.
            </p>
            <label className="btn primary big">
              Choose images
              <input type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
            </label>
            <div className="empty-hint">…or drag &amp; drop / paste from clipboard</div>
            <div className="feature-row">
              <div className="feature"><b>AI cutout</b>On-device background removal</div>
              <div className="feature"><b>Magic heal</b>Brush away text &amp; blemishes</div>
              <div className="feature"><b>Batch + ZIP</b>Whole catalogs in one go</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="main">
          <aside className="rail">
            {metas.map((m) => (
              <div
                key={m.id}
                className={[
                  'thumb',
                  m.id === selectedId ? 'selected' : '',
                  m.status,
                ].join(' ')}
                title={m.name}
                onClick={() => setSelectedId(m.id)}
              >
                <img src={m.thumb} alt={m.name} draggable={false} />
                {m.status === 'removing' && (
                  <span className="thumb-bar"><i style={{ width: `${m.progress * 100}%` }} /></span>
                )}
                {m.status === 'error' && <span className="thumb-err">!</span>}
                <button
                  className="thumb-x"
                  title="Remove"
                  onClick={(e) => { e.stopPropagation(); removeItem(m.id); }}
                >
                  ×
                </button>
              </div>
            ))}
            <label className="rail-add" title="Add images">
              +
              <input type="file" accept="image/*" multiple hidden onChange={onPickFiles} />
            </label>
          </aside>

          <section className="stage">
            <EditorCanvas
              ref={editorRef}
              meta={selected}
              data={selData}
              background={background}
              bgImage={bgImage}
              shadow={shadow}
              tool={tool}
              brushSize={brushSize}
              hardness={hardness}
              magnifier={magnifier}
              selectMode={selectMode}
              wandTolerance={wandTolerance}
              aspect={aspect}
              editVersion={editVersion}
              onEdited={bump}
              onSelectionChange={setHasSelection}
            />

            {selected && selected.status !== 'ready' && (
              <div className="overlay">
                {selected.status === 'error' ? (
                  <>
                    <p className="overlay-err">Cutout failed: {selected.error}</p>
                    <button className="btn primary" onClick={retry}>Retry</button>
                  </>
                ) : (
                  <>
                    <div className="spinner" />
                    <p>{selected.progressLabel || 'Waiting…'}</p>
                    <div className="bar"><i style={{ width: `${selected.progress * 100}%` }} /></div>
                    <span className="overlay-pct">{Math.round(selected.progress * 100)}%</span>
                  </>
                )}
              </div>
            )}

            {selected?.status === 'ready' && (
              <div className="toolbar">
                {TOOLS.map((t) => (
                  <button
                    key={t.v}
                    className={tool === t.v ? 'tool active' : 'tool'}
                    title={t.hint}
                    onClick={() => setTool(t.v)}
                  >
                    <span className="tool-icon">{t.icon}</span>
                    {t.label}
                  </button>
                ))}
                {tool !== 'move' && tool !== 'select' && (
                  <>
                    <span className="tb-label">Size</span>
                    <input
                      className="brush-slider"
                      type="range"
                      min={8}
                      max={120}
                      value={brushSize}
                      title="Brush size"
                      onChange={(e) => setBrushSize(Number(e.target.value))}
                    />
                  </>
                )}
                {(tool === 'erase' || tool === 'restore') && (
                  <>
                    <span className="tb-label">Edge</span>
                    <input
                      className="brush-slider"
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(hardness * 100)}
                      title="Brush hardness — left is soft, right is hard"
                      onChange={(e) => setHardness(Number(e.target.value) / 100)}
                    />
                  </>
                )}
                {tool === 'select' && (
                  <>
                    <div className="mini-seg">
                      <button
                        className={selectMode === 'lasso' ? 'on' : ''}
                        title="Draw a rough outline around the unwanted area"
                        onClick={() => setSelectMode('lasso')}
                      >
                        Lasso
                      </button>
                      <button
                        className={selectMode === 'wand' ? 'on' : ''}
                        title="Click a spot to select similar colors around it"
                        onClick={() => setSelectMode('wand')}
                      >
                        Wand
                      </button>
                    </div>
                    {selectMode === 'wand' && (
                      <>
                        <span className="tb-label">Range</span>
                        <input
                          className="brush-slider"
                          type="range"
                          min={4}
                          max={90}
                          value={wandTolerance}
                          title="How similar colors must be to join the selection"
                          onChange={(e) => setWandTolerance(Number(e.target.value))}
                        />
                      </>
                    )}
                    {hasSelection && (
                      <>
                        <button
                          className="tool danger"
                          title="Erase the selected area (leaves transparency)"
                          onClick={() => editorRef.current?.applySelection()}
                        >
                          ✕ Remove
                        </button>
                        <button className="tool" onClick={() => editorRef.current?.clearSelection()}>
                          Cancel
                        </button>
                      </>
                    )}
                  </>
                )}
              </div>
            )}
          </section>

          <Panels
            tab={tab}
            setTab={setTab}
            background={background}
            setBackground={setBackground}
            shadow={shadow}
            setShadow={setShadow}
            subjectScale={selData?.transform.scale ?? 1}
            onSubjectScale={(v) => {
              if (selData) { selData.transform.scale = v; bump(); }
            }}
            onResetTransform={() => {
              if (selData) { selData.transform = { ...IDENTITY }; bump(); }
            }}
            rotation={selData?.transform.rotation ?? 0}
            onRotate={(v) => {
              if (selData) { selData.transform.rotation = v; bump(); }
            }}
            flipX={selData?.transform.flipX ?? false}
            flipY={selData?.transform.flipY ?? false}
            onFlipX={() => {
              if (selData) { selData.transform.flipX = !selData.transform.flipX; bump(); }
            }}
            onFlipY={() => {
              if (selData) { selData.transform.flipY = !selData.transform.flipY; bump(); }
            }}
            magnifier={magnifier}
            setMagnifier={setMagnifier}
            onRecut={recut}
            onBgImageUpload={(f) => setBackground({ kind: 'image', url: URL.createObjectURL(f) })}
            exportPresetId={exportPresetId}
            setExportPresetId={setExportPresetId}
            format={format}
            setFormat={setFormat}
            quality={quality}
            setQuality={setQuality}
            onExportCurrent={exportCurrent}
            onExportAll={exportAll}
            exporting={exporting}
            canExport={selected?.status === 'ready'}
            readyCount={readyCount}
          />
        </div>
      )}

      {dragging && <div className="drop-veil">Drop images anywhere</div>}
    </div>
  );
}
