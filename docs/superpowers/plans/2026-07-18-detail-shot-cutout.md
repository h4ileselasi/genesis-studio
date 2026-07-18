# Detail Shot Cutout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Detail shot" mode to Genesis Studio: the user taps (or boxes) the visible product portion in a close-up photo, SlimSAM segments exactly that region in-browser, and the result flows into the existing cutout pipeline unchanged.

**Architecture:** A second on-device model (SlimSAM via transformers.js) sits beside ISNet. New items uploaded as "detail" skip the auto queue and enter a `select` status rendered by a new `SelectStage` component (tap/box prompts, live mask preview, zoom). Applying the selection produces the same cutout-canvas shape ISNet produces, so compositor/brushes/export need zero changes.

**Tech Stack:** Vite 5 + React 18 + TypeScript (strict), `@huggingface/transformers` (SlimSAM `Xenova/slimsam-77-uniform`, WASM, q8), vitest for pure-logic tests.

**Spec:** `docs/superpowers/specs/2026-07-18-detail-shot-cutout-design.md`

## Global Constraints

- Browser-only, no backend, no per-image cost. Models fetched from CDN on first use, cached by the browser.
- App source root: `C:\Users\HP\Desktop\Project-Host`. Dev server: port **5174** (launch config `genesis-studio` in `Desktop\GENESIS\.claude\launch.json`).
- **Never run `npm run build` while the dev server is running** — it clobbers the shared `node_modules/.vite` cache and blanks the app. Stop the server first; restart it (and clear `.vite` if needed) after.
- Canvas sizing/drawing must never rely on rAF or ResizeObserver alone (hidden tabs suspend both). Copy `EditorCanvas`'s `scheduleDraw` rAF + 120 ms `setTimeout` fallback pattern. Wrap `setPointerCapture` in try/catch.
- ISNet path (`src/lib/removeBg.ts`, the `queued`/`removing` statuses) must keep working unchanged.
- No new UI framework/CSS libs — plain CSS in `src/styles.css` using the existing custom properties (`--accent`, `--panel-2`, etc.) and classes (`.toolbar`, `.tool`, `.overlay`, `.btn`).
- Verification of visual output = magnified screenshots of actual renders, not "the code ran". Pixel-probe protocol: sample→act→verify inside ONE eval; ground shadow off first.

---

### Task 1: Model wrapper + browser spike

Prove the SlimSAM pipeline (load → encode → point decode → box decode) works in this app's browser environment before any UI is built. The wrapper's API is what every later task consumes.

**Files:**
- Modify: `package.json` (dependency)
- Modify: `vite.config.ts`
- Create: `src/lib/detailSelect.ts`
- Create: `spike.html` (repo root; temporary, deleted in Task 5)
- Create: `src/spikeMain.ts` (temporary, deleted in Task 5)

**Interfaces (Produces — later tasks rely on these exact names):**

```ts
// src/lib/detailSelect.ts
export interface PromptPoint { x: number; y: number; label: 0 | 1 } // original-image px; 1=keep, 0=exclude
export interface PromptBox { x1: number; y1: number; x2: number; y2: number } // original-image px
export interface EncodedImage {
  embeddings: Record<string, unknown>;
  originalSize: [number, number]; // [h, w]
  reshapedSize: [number, number]; // [h, w]
}
export interface DetailMask { width: number; height: number; data: Uint8Array; score: number } // data: 255=subject, at original resolution
export function loadDetailModel(onProgress?: (p: number) => void): Promise<void>
export function encodeDetailImage(original: HTMLCanvasElement): Promise<EncodedImage>
export function decodeDetailMask(enc: EncodedImage, points: PromptPoint[], box: PromptBox | null): Promise<DetailMask | null>
```

- [ ] **Step 1: Install the dependency**

Run (dev server may keep running for npm install; just don't run `npm run build`):

```
npm --prefix C:\Users\HP\Desktop\Project-Host install @huggingface/transformers
```

Expected: `added N packages` and `@huggingface/transformers` ^3.x in `package.json` dependencies.

- [ ] **Step 2: Exclude the library from Vite pre-bundling**

`vite.config.ts` — transformers.js ships its own WASM assets that Vite's optimizer mangles. Current file exports `defineConfig({ plugins: [react()], ... })`; add the `optimizeDeps` key at the top level of the config object:

```ts
export default defineConfig({
  plugins: [react()],
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
  // ...keep whatever else is already there (e.g. server config) unchanged
});
```

Restart the dev server after this change.

- [ ] **Step 3: Write the model wrapper**

Create `src/lib/detailSelect.ts`:

```ts
// Tap/box promptable segmentation for Detail Shot mode.
//
// Wraps SlimSAM (compact Segment Anything) via transformers.js. Runs fully
// in-browser (WASM, q8 quantized, ~10-30 MB fetched from the HF CDN once).
// Two phases: encode once per image (seconds), then each point/box prompt
// decodes in well under a second — that's what makes tapping feel live.

import { AutoProcessor, RawImage, SamModel, Tensor } from '@huggingface/transformers';

export interface PromptPoint { x: number; y: number; label: 0 | 1 } // original px; 1=keep, 0=exclude
export interface PromptBox { x1: number; y1: number; x2: number; y2: number } // original px

export interface EncodedImage {
  embeddings: Record<string, unknown>;
  originalSize: [number, number]; // [h, w]
  reshapedSize: [number, number]; // [h, w]
}

export interface DetailMask {
  width: number; // original image width
  height: number;
  data: Uint8Array; // 255 = subject
  score: number; // model confidence for the chosen mask
}

const MODEL_ID = 'Xenova/slimsam-77-uniform';

let loaded: { model: SamModel; processor: Awaited<ReturnType<typeof AutoProcessor.from_pretrained>> } | null = null;
let loading: Promise<typeof loaded> | null = null;

async function getModel(onProgress?: (p: number) => void) {
  if (loaded) return loaded;
  if (!loading) {
    // Aggregate per-file download progress into one 0..1 number.
    const perFile = new Map<string, number>();
    const progress_callback = (info: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (info.status === 'progress' && info.file && info.total) {
        perFile.set(info.file, (info.loaded ?? 0) / info.total);
        let s = 0;
        for (const v of perFile.values()) s += v;
        onProgress?.(Math.min(1, s / perFile.size));
      }
    };
    loading = (async () => {
      const [model, processor] = await Promise.all([
        SamModel.from_pretrained(MODEL_ID, { dtype: 'q8', progress_callback }),
        AutoProcessor.from_pretrained(MODEL_ID, { progress_callback }),
      ]);
      loaded = { model: model as SamModel, processor };
      return loaded;
    })();
    loading.catch(() => { loading = null; }); // allow retry after a failed download
  }
  return (await loading)!;
}

/** Lazy-load the model once. progress covers the CDN download. */
export async function loadDetailModel(onProgress?: (p: number) => void): Promise<void> {
  await getModel(onProgress);
}

/** Run the heavy once-per-image encoder. */
export async function encodeDetailImage(original: HTMLCanvasElement): Promise<EncodedImage> {
  const { model, processor } = await getModel();
  // RawImage.fromCanvas exists in transformers.js v3; if a version lacks it,
  // fall back to: await RawImage.fromURL(original.toDataURL('image/png'))
  const image = RawImage.fromCanvas(original);
  const inputs = await processor(image);
  const embeddings = await model.get_image_embeddings(inputs);
  return {
    embeddings,
    originalSize: inputs.original_sizes[0] as [number, number],
    reshapedSize: inputs.reshaped_input_sizes[0] as [number, number],
  };
}

/** Decode a mask for the given prompts. Returns null when there are no prompts. */
export async function decodeDetailMask(
  enc: EncodedImage,
  points: PromptPoint[],
  box: PromptBox | null,
): Promise<DetailMask | null> {
  if (!points.length && !box) return null;
  const { model, processor } = await getModel();
  const [oh, ow] = enc.originalSize;
  const [rh, rw] = enc.reshapedSize;
  const sx = rw / ow;
  const sy = rh / oh;

  const feeds: Record<string, unknown> = { ...enc.embeddings };
  if (points.length) {
    feeds.input_points = new Tensor(
      'float32',
      Float32Array.from(points.flatMap((p) => [p.x * sx, p.y * sy])),
      [1, 1, points.length, 2],
    );
    feeds.input_labels = new Tensor(
      'int64',
      BigInt64Array.from(points.map((p) => BigInt(p.label))),
      [1, 1, points.length],
    );
  }
  if (box) {
    feeds.input_boxes = new Tensor(
      'float32',
      Float32Array.from([box.x1 * sx, box.y1 * sy, box.x2 * sx, box.y2 * sy]),
      [1, 1, 4],
    );
  }

  const outputs = await model(feeds);
  // pred_masks upscaled to the original resolution; 3 candidates per prompt set.
  const masks = await processor.post_process_masks(
    outputs.pred_masks,
    [enc.originalSize],
    [enc.reshapedSize],
  );
  const scores = outputs.iou_scores.data as Float32Array;
  let best = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[best]) best = i;

  const m = masks[0]; // Tensor [1, numMasks, H, W]
  const dims = m.dims as number[];
  const H = dims[dims.length - 2];
  const W = dims[dims.length - 1];
  const src = m.data as Uint8Array; // 0/1 per pixel, mask planes back to back
  const off = best * H * W;
  const out = new Uint8Array(H * W);
  for (let i = 0; i < H * W; i++) out[i] = src[off + i] ? 255 : 0;
  return { width: W, height: H, data: out, score: scores[best] };
}
```

Note for the implementer: exact transformers.js typings are loose in places — if `tsc` complains about `SamModel`/processor types, widen with `as unknown as` at the assignment, not with `any` sprinkled through the logic. If `input_boxes` combined with cached embeddings errors at runtime, that is a wrapper-level bug to fix here (check the installed transformers.js version's SAM support on GitHub); every later task depends only on `decodeDetailMask`'s signature, so fix it inside this module.

- [ ] **Step 4: Write the spike page**

Create `spike.html` in the repo root (Vite serves root .html files in dev):

```html
<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>SAM spike</title></head>
  <body style="background:#111;color:#eee;font-family:monospace">
    <pre id="log">loading…</pre>
    <canvas id="cv" width="1024" height="768" style="max-width:100%"></canvas>
    <script type="module" src="/src/spikeMain.ts"></script>
  </body>
</html>
```

Create `src/spikeMain.ts`:

```ts
// Temporary spike: proves load/encode/point/box decode in the real browser.
import { decodeDetailMask, encodeDetailImage, loadDetailModel } from './lib/detailSelect';

const log = (s: string) => { document.getElementById('log')!.textContent += `\n${s}`; };

function testScene(): HTMLCanvasElement {
  const cv = document.getElementById('cv') as HTMLCanvasElement;
  const x = cv.getContext('2d')!;
  // Busy background: gradient + grid, so segmentation isn't trivial.
  const g = x.createLinearGradient(0, 0, 1024, 768);
  g.addColorStop(0, '#c9b18a'); g.addColorStop(1, '#8a7b5f');
  x.fillStyle = g; x.fillRect(0, 0, 1024, 768);
  x.strokeStyle = 'rgba(0,0,0,0.15)';
  for (let i = 0; i < 1024; i += 32) { x.beginPath(); x.moveTo(i, 0); x.lineTo(i, 768); x.stroke(); }
  // "Product part" A: red rounded slab cropped by the LEFT frame edge.
  x.fillStyle = '#b3223a';
  x.beginPath(); x.roundRect(-80, 200, 380, 320, 40); x.fill();
  x.fillStyle = '#7e1628'; x.fillRect(-80, 340, 380, 24); // a seam for texture
  // Object B: blue ellipse, off-center right.
  x.fillStyle = '#2b4fb3';
  x.beginPath(); x.ellipse(780, 520, 150, 100, 0.4, 0, Math.PI * 2); x.fill();
  return cv;
}

const at = (m: { width: number; data: Uint8Array }, px: number, py: number) =>
  m.data[py * m.width + px];
const frac = (m: { data: Uint8Array }) => {
  let n = 0; for (let i = 0; i < m.data.length; i++) if (m.data[i]) n++;
  return n / m.data.length;
};

(window as unknown as { __spike: () => Promise<string> }).__spike = async () => {
  const cv = testScene();
  const t0 = performance.now();
  await loadDetailModel((p) => { document.title = `dl ${(p * 100) | 0}%`; });
  log(`model loaded in ${((performance.now() - t0) / 1000).toFixed(1)}s`);
  const t1 = performance.now();
  const enc = await encodeDetailImage(cv);
  log(`encoded in ${((performance.now() - t1) / 1000).toFixed(1)}s; orig=${enc.originalSize} reshaped=${enc.reshapedSize}`);

  const results: Record<string, boolean | number | string> = {};
  // 1. positive point on red slab
  const m1 = await decodeDetailMask(enc, [{ x: 120, y: 360, label: 1 }], null);
  results.pointRedHit = !!m1 && at(m1, 120, 360) === 255;
  results.pointRedExcludesBlue = !!m1 && at(m1, 780, 520) === 0;
  results.pointRedFrac = m1 ? +frac(m1).toFixed(3) : -1;
  results.pointScore = m1 ? +m1.score.toFixed(3) : -1;
  // 2. negative point keeps blue out even when tapped near both
  const m2 = await decodeDetailMask(
    enc,
    [{ x: 120, y: 360, label: 1 }, { x: 780, y: 520, label: 0 }],
    null,
  );
  results.negBlueExcluded = !!m2 && at(m2, 780, 520) === 0;
  // 3. box-only around the blue ellipse
  const m3 = await decodeDetailMask(enc, [], { x1: 600, y1: 400, x2: 960, y2: 640 });
  results.boxBlueHit = !!m3 && at(m3, 780, 520) === 255;
  results.boxExcludesRed = !!m3 && at(m3, 120, 360) === 0;
  // 4. decode latency (the thing that must feel live)
  const t2 = performance.now();
  await decodeDetailMask(enc, [{ x: 780, y: 520, label: 1 }], null);
  results.decodeMs = Math.round(performance.now() - t2);

  const out = JSON.stringify(results, null, 2);
  log(out);
  return out;
};
log('ready — run __spike() in the console');
```

- [ ] **Step 5: Run the spike and verify**

Start the dev server (preview_start with name `genesis-studio`), navigate the browser preview to `http://localhost:5174/spike.html`, then execute `await __spike()` via the JS tool.

Expected (this is the test — all must hold):
- `pointRedHit: true`, `pointRedExcludesBlue: true`, `pointRedFrac` between 0.02 and 0.5
- `negBlueExcluded: true`
- `boxBlueHit: true`, `boxExcludesRed: true`
- `decodeMs` under 1500 (typically well under)
- No errors in the browser console.

If box-only decode fails, fix inside `detailSelect.ts` per the Step 3 note before proceeding.

- [ ] **Step 6: Commit**

```
git -C C:\Users\HP\Desktop\Project-Host add package.json package-lock.json vite.config.ts src/lib/detailSelect.ts spike.html src/spikeMain.ts
git -C C:\Users\HP\Desktop\Project-Host commit -m "feat: SlimSAM tap/box segmentation wrapper + spike"
```

---

### Task 2: Mask refinement module (TDD)

Cleans raw SAM masks into production alpha: speckle removal (pure, unit-tested) + feathered edges that stay hard at the photo frame (canvas, verified in-app later).

**Files:**
- Modify: `package.json` (devDependency + script)
- Create: `src/lib/maskRefine.ts`
- Test: `src/lib/maskRefine.test.ts`

**Interfaces:**
- Consumes: `DetailMask` from `src/lib/detailSelect.ts` (type-only import).
- Produces:

```ts
export function majorityVote(mask: Uint8Array, w: number, h: number): Uint8Array // one 3x3 majority pass, new array
export function refineMask(mask: Uint8Array, w: number, h: number): Uint8Array   // two majority passes
export function maskToCanvas(data: Uint8Array, w: number, h: number): HTMLCanvasElement // opaque-alpha mask canvas
export function featherMask(data: Uint8Array, w: number, h: number, feather?: number): HTMLCanvasElement // soft edges, hard at frame
export function applyMaskToOriginal(original: HTMLCanvasElement, mask: DetailMask, feather?: number): HTMLCanvasElement // the final cutout canvas
```

- [ ] **Step 1: Install vitest and add the test script**

```
npm --prefix C:\Users\HP\Desktop\Project-Host install -D vitest
```

In `package.json` scripts add: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing tests**

Create `src/lib/maskRefine.test.ts` (pure-array functions only — no DOM in node):

```ts
import { describe, expect, it } from 'vitest';
import { majorityVote, refineMask } from './maskRefine';

// Build a w*h mask from rows of '.' (0) and '#' (255).
function grid(rows: string[]): { m: Uint8Array; w: number; h: number } {
  const h = rows.length;
  const w = rows[0].length;
  const m = new Uint8Array(w * h);
  rows.forEach((r, y) => [...r].forEach((c, x) => { m[y * w + x] = c === '#' ? 255 : 0; }));
  return { m, w, h };
}
const show = (m: Uint8Array, w: number, h: number) =>
  Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => (m[y * w + x] ? '#' : '.')).join(''));

describe('majorityVote', () => {
  it('removes an isolated speckle', () => {
    const { m, w, h } = grid([
      '.....',
      '..#..',
      '.....',
      '.....',
      '.....',
    ]);
    expect(show(majorityVote(m, w, h), w, h)).toEqual([
      '.....', '.....', '.....', '.....', '.....',
    ]);
  });

  it('fills a pinhole inside a solid block', () => {
    const { m, w, h } = grid([
      '#####',
      '#####',
      '##.##',
      '#####',
      '#####',
    ]);
    expect(show(majorityVote(m, w, h), w, h)).toEqual([
      '#####', '#####', '#####', '#####', '#####',
    ]);
  });

  it('keeps a solid block intact, including its border pixels', () => {
    const { m, w, h } = grid([
      '#####',
      '#####',
      '#####',
      '#####',
      '#####',
    ]);
    expect(show(majorityVote(m, w, h), w, h)).toEqual([
      '#####', '#####', '#####', '#####', '#####',
    ]);
  });

  it('does not mutate its input', () => {
    const { m, w, h } = grid(['.#.', '...', '...']);
    const copy = m.slice();
    majorityVote(m, w, h);
    expect(m).toEqual(copy);
  });
});

describe('refineMask', () => {
  it('clears speckle clusters a single pass leaves behind', () => {
    const { m, w, h } = grid([
      '......',
      '.##...',
      '......',
      '...###',
      '...###',
      '...###',
    ]);
    const out = refineMask(m, w, h);
    const rows = show(out, w, h);
    expect(rows[1]).toBe('......'); // 2-px speckle gone
    expect(rows[4].endsWith('###')).toBe(true); // solid corner block survives
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `npm --prefix C:\Users\HP\Desktop\Project-Host run test`
Expected: FAIL — `Cannot find module './maskRefine'` (or equivalent).

- [ ] **Step 4: Implement the module**

Create `src/lib/maskRefine.ts`:

```ts
// Cleanup for raw SAM masks before they become the cutout alpha.
//
// SAM thinks at low resolution: its upsampled masks carry speckles, pinholes
// and staircase edges. refineMask kills the noise (pure, unit-tested);
// featherMask softens the contour ~1.5px — EXCEPT where the mask touches the
// photo frame, where a cropped detail shot must keep a hard straight edge
// (replicate-padding before the blur achieves exactly that).

import type { DetailMask } from './detailSelect';

/** One 3x3 majority pass over the full frame. Returns a new array. */
export function majorityVote(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let cnt = 0;
      let tot = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          tot++;
          if (mask[yy * w + xx]) cnt++;
        }
      }
      out[y * w + x] = cnt * 2 > tot ? 255 : 0;
    }
  }
  return out;
}

/** Two majority passes — enough to clear SAM speckle without eating corners. */
export function refineMask(mask: Uint8Array, w: number, h: number): Uint8Array {
  return majorityVote(majorityVote(mask, w, h), w, h);
}

/** Mask as an alpha-only canvas (opaque where selected). */
export function maskToCanvas(data: Uint8Array, w: number, h: number): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  for (let i = 0; i < data.length; i++) {
    if (data[i]) img.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

/**
 * Feathered mask canvas. Replicate-pads the mask before blurring so edges at
 * the photo frame stay hard/straight, then crops the padding back off.
 */
export function featherMask(data: Uint8Array, w: number, h: number, feather = 1.5): HTMLCanvasElement {
  const mc = maskToCanvas(data, w, h);
  const P = Math.ceil(feather * 3);
  const pc = document.createElement('canvas');
  pc.width = w + 2 * P;
  pc.height = h + 2 * P;
  const px = pc.getContext('2d')!;
  px.imageSmoothingEnabled = false;
  px.drawImage(mc, P, P);
  // replicate 1px border rows/cols into the padding
  px.drawImage(mc, 0, 0, w, 1, P, 0, w, P); // top
  px.drawImage(mc, 0, h - 1, w, 1, P, h + P, w, P); // bottom
  px.drawImage(mc, 0, 0, 1, h, 0, P, P, h); // left
  px.drawImage(mc, w - 1, 0, 1, h, w + P, P, P, h); // right
  px.drawImage(mc, 0, 0, 1, 1, 0, 0, P, P); // corners
  px.drawImage(mc, w - 1, 0, 1, 1, w + P, 0, P, P);
  px.drawImage(mc, 0, h - 1, 1, 1, 0, h + P, P, P);
  px.drawImage(mc, w - 1, h - 1, 1, 1, w + P, h + P, P, P);

  const fc = document.createElement('canvas');
  fc.width = w;
  fc.height = h;
  const fx = fc.getContext('2d')!;
  fx.filter = `blur(${feather}px)`;
  fx.drawImage(pc, -P, -P);
  fx.filter = 'none';
  return fc;
}

/** Refine + feather the mask and apply it as the alpha of a full-res copy of the original. */
export function applyMaskToOriginal(
  original: HTMLCanvasElement,
  mask: DetailMask,
  feather = 1.5,
): HTMLCanvasElement {
  const cut = document.createElement('canvas');
  cut.width = original.width;
  cut.height = original.height;
  const ctx = cut.getContext('2d')!;
  ctx.drawImage(original, 0, 0);
  const refined = refineMask(mask.data, mask.width, mask.height);
  const soft = featherMask(refined, mask.width, mask.height, feather);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(soft, 0, 0, cut.width, cut.height); // scaled guard if sizes ever differ
  ctx.globalCompositeOperation = 'source-over';
  return cut;
}
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `npm --prefix C:\Users\HP\Desktop\Project-Host run test`
Expected: PASS — 5 tests.

- [ ] **Step 6: Commit**

```
git -C C:\Users\HP\Desktop\Project-Host add package.json package-lock.json src/lib/maskRefine.ts src/lib/maskRefine.test.ts
git -C C:\Users\HP\Desktop\Project-Host commit -m "feat: mask refinement (speckle cleanup + frame-aware feather) with tests"
```

---

### Task 3: Types, queue routing, and upload-mode UI

Detail items must exist as first-class queue citizens that *skip* ISNet. After this task: uploading via a "Detail shot" button creates an item in `select` status showing a placeholder overlay (replaced by the real UI in Task 4), and the Adjust panel can switch any image between auto and detail cutting.

**Files:**
- Modify: `src/types.ts:38-48`
- Modify: `src/App.tsx` (addFiles ~94-120, recut ~198-203, topbar ~293-305, empty screen ~308-329, stage ~384-400, Panels props ~495-536)
- Modify: `src/components/Panels.tsx` (Props ~8-39, "AI cutout" section ~323-330)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CutMode = 'auto' | 'detail'`; `Status` gains `'select'`; `ItemMeta.mode: CutMode`; App handlers `detailSelect(): void` and `applyDetailCutout(id: string, cutout: HTMLCanvasElement): void` (the latter wired to the real UI in Task 4); Panels props `mode: CutMode` and `onDetailSelect: () => void`.

- [ ] **Step 1: Extend the types**

`src/types.ts` — replace:

```ts
export type Status = 'queued' | 'removing' | 'ready' | 'error';
```

with:

```ts
export type CutMode = 'auto' | 'detail';

// 'select' = detail-shot item waiting for (or in) the tap-to-select stage.
export type Status = 'queued' | 'removing' | 'select' | 'ready' | 'error';
```

and add `mode: CutMode;` to `ItemMeta` (after `status`).

- [ ] **Step 2: Route uploads by mode in App.tsx**

Import `CutMode` from `./types`. Change `addFiles` to take a mode (detail items are born in `select` status, so the existing queue effect — which only picks `status === 'queued'` — never sends them to ISNet; **the queue effect itself is untouched**):

```ts
const addFiles = useCallback(async (files: Iterable<File>, mode: CutMode = 'auto') => {
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
        status: mode === 'detail' ? 'select' : 'queued',
        mode,
        progress: 0,
        progressLabel: mode === 'detail' ? '' : 'Waiting…',
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
```

Update `onPickFiles` to a curried handler and its three call sites (topbar label, empty screen label, rail-add label all currently pass `onPickFiles` directly):

```ts
const onPickFiles = (mode: CutMode) => (e: ChangeEvent<HTMLInputElement>) => {
  if (e.target.files?.length) addFiles(e.target.files, mode);
  e.target.value = '';
};
```

Existing call sites become `onChange={onPickFiles('auto')}`. Drag-drop and paste keep calling `addFiles(files)` (auto default).

- [ ] **Step 3: Add the Detail-shot upload entry points**

Topbar (next to the existing "+ Add images" label):

```tsx
<label className="btn ghost">
  ⬚ Detail shot
  <input type="file" accept="image/*" multiple hidden onChange={onPickFiles('detail')} />
</label>
```

Empty screen (after the existing "Choose images" label, before the hint):

```tsx
<label className="btn ghost big">
  ⬚ Detail shot — tap what to keep
  <input type="file" accept="image/*" multiple hidden onChange={onPickFiles('detail')} />
</label>
```

- [ ] **Step 4: Mode-aware recut + detail-select handlers**

Replace `recut` and add `detailSelect` + `applyDetailCutout`:

```ts
// Auto re-cut always goes back through ISNet, even for detail items.
const recut = () => {
  if (!selectedId) return;
  const d = dataRef.current.get(selectedId);
  if (d) d.cutout = null;
  patchMeta(selectedId, { mode: 'auto', status: 'queued', progress: 0, progressLabel: 'Waiting…', error: undefined });
};

// Enter (or re-enter) the tap-to-select stage for the current image.
const detailSelect = () => {
  if (!selectedId) return;
  const d = dataRef.current.get(selectedId);
  if (d) d.cutout = null;
  patchMeta(selectedId, { mode: 'detail', status: 'select', progress: 0, progressLabel: '', error: undefined });
};

const applyDetailCutout = (id: string, cutout: HTMLCanvasElement) => {
  const d = dataRef.current.get(id);
  if (!d) return;
  d.cutout = cutout;
  d.transform = { ...IDENTITY };
  patchMeta(id, { status: 'ready', progress: 1, progressLabel: '', thumb: makeThumb(cutout) });
  bump();
};
```

(`applyDetailCutout` is unused until Task 4 — prefix a `void applyDetailCutout;` statement or wire it into the placeholder to keep `tsc` quiet, and remove that in Task 4.)

- [ ] **Step 5: Placeholder stage for 'select' status**

The status overlay currently renders for any `status !== 'ready'`. `'select'` would fall into the spinner branch; give it its own placeholder instead. In the overlay block, add a first branch:

```tsx
{selected.status === 'select' ? (
  <p>Detail selection UI arrives in the next task.</p>
) : selected.status === 'error' ? (
  /* existing error branch unchanged */
) : (
  /* existing spinner branch unchanged */
)}
```

- [ ] **Step 6: Panels — mode switch buttons**

`Panels.tsx` Props: add `mode: CutMode; onDetailSelect: () => void;` (import `CutMode` from `../types`). Replace the "AI cutout" section:

```tsx
<Section title="AI cutout">
  <button className="btn ghost full" onClick={p.onRecut}>
    ↺ Auto re-cut (whole product)
  </button>
  <button className="btn ghost full" onClick={p.onDetailSelect}>
    ⬚ {p.mode === 'detail' ? 'Re-select subject' : 'Detail select (tap what to keep)'}
  </button>
  <div className="hint">
    Auto re-cut finds the whole product by itself. Detail select is for
    close-up shots — you tap exactly what to keep. Both discard manual edits.
  </div>
</Section>
```

In App.tsx pass the new props: `mode={selected?.mode ?? 'auto'}` and `onDetailSelect={detailSelect}`.

- [ ] **Step 7: Verify in the browser**

Dev server up; in the preview:
1. Upload an image via "+ Add images" → flows through ISNet to `ready` exactly as before (regression check).
2. Upload an image via "⬚ Detail shot" → item appears, shows "Detail selection UI arrives in the next task.", never enters `removing`, and the OTHER (auto) item still processed fine alongside it.
3. On the auto item: Adjust → "Detail select" → status flips to `select` placeholder. Then "Auto re-cut" → goes `queued` → `removing` → `ready` again.
4. No console errors.

- [ ] **Step 8: Commit**

```
git -C C:\Users\HP\Desktop\Project-Host add src/types.ts src/App.tsx src/components/Panels.tsx
git -C C:\Users\HP\Desktop\Project-Host commit -m "feat: detail-shot mode plumbing — select status, upload entry points, mode switching"
```

---### Task 4: SelectStage component — the tap/box UI

The heart of the feature. A dedicated stage canvas (NOT EditorCanvas — that one is for ready cutouts) with: model load/encode progress, tap = positive pin, tap-on-selection = negative pin, tap-on-pin = remove pin, box tool, live bright-subject preview, wheel/pinch zoom with pan, and "Cut it out".

**Files:**
- Create: `src/components/SelectStage.tsx`
- Modify: `src/App.tsx` (stage block — mount SelectStage for `select` status, remove Task 3 placeholder + `void applyDetailCutout;`)
- Modify: `src/styles.css` (append)

**Interfaces:**
- Consumes: `loadDetailModel`, `encodeDetailImage`, `decodeDetailMask`, `PromptPoint`, `PromptBox`, `EncodedImage`, `DetailMask` from `../lib/detailSelect`; `maskToCanvas`, `applyMaskToOriginal` from `../lib/maskRefine`; `ItemMeta`, `ItemData` from `../types`.
- Produces: `export default SelectStage` with props `{ meta: ItemMeta; data: ItemData; onApply: (cutout: HTMLCanvasElement) => void }`.

- [ ] **Step 1: Write the component**

Create `src/components/SelectStage.tsx`:

```tsx
import {
  PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ItemData, ItemMeta } from '../types';
import {
  DetailMask, EncodedImage, PromptBox, PromptPoint,
  decodeDetailMask, encodeDetailImage, loadDetailModel,
} from '../lib/detailSelect';
import { applyMaskToOriginal, maskToCanvas } from '../lib/maskRefine';

interface Props {
  meta: ItemMeta;
  data: ItemData;
  onApply: (cutout: HTMLCanvasElement) => void;
}

type Phase = 'loading' | 'encoding' | 'ready' | 'error';

interface Gesture {
  mode: 'tap' | 'box' | 'pan' | 'none';
  sx: number; // canvas px at pointerdown
  sy: number;
  cx: number; // current canvas px
  cy: number;
  panX0: number;
  panY0: number;
}

const PIN_R = 9; // pin radius, canvas px
const MIN_ZOOM = 1;
const MAX_ZOOM = 8;

export default function SelectStage({ meta, data, onApply }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sizeRef = useRef({ w: 0, h: 0 });
  const rafRef = useRef(0);
  const fallbackRef = useRef(0);
  const retryTimerRef = useRef(0);

  const viewRef = useRef({ zoom: 1, panX: 0, panY: 0 });
  const pointsRef = useRef<PromptPoint[]>([]);
  const boxRef = useRef<PromptBox | null>(null);
  const encRef = useRef<EncodedImage | null>(null);
  const maskRef = useRef<DetailMask | null>(null);
  const previewRef = useRef<HTMLCanvasElement | null>(null); // bright masked original
  const decodingRef = useRef(false);
  const pendingRef = useRef(false);
  const gestureRef = useRef<Gesture | null>(null);
  const pinchRef = useRef<{ d0: number; zoom0: number } | null>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());

  const [phase, setPhase] = useState<Phase>('loading');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [boxTool, setBoxTool] = useState(false);
  const [hasMask, setHasMask] = useState(false);
  const [hasPrompts, setHasPrompts] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  // ---- geometry -----------------------------------------------------------

  function layout() {
    const { w, h } = sizeRef.current;
    const iw = data.original.width;
    const ih = data.original.height;
    const v = viewRef.current;
    const s = Math.min(w / iw, h / ih) * 0.96 * v.zoom;
    const ox = (w - iw * s) / 2 + v.panX;
    const oy = (h - ih * s) / 2 + v.panY;
    return { s, ox, oy, iw, ih };
  }
  const toImage = (px: number, py: number) => {
    const L = layout();
    return { x: (px - L.ox) / L.s, y: (py - L.oy) / L.s };
  };
  const toCanvas = (ix: number, iy: number) => {
    const L = layout();
    return { x: L.ox + ix * L.s, y: L.oy + iy * L.s };
  };

  function zoomTo(newZoom: number, cx: number, cy: number) {
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
    const L = layout();
    const ix = (cx - L.ox) / L.s;
    const iy = (cy - L.oy) / L.s;
    const v = viewRef.current;
    v.zoom = z;
    const { w, h } = sizeRef.current;
    const s2 = Math.min(w / L.iw, h / L.ih) * 0.96 * z;
    v.panX = cx - ix * s2 - (w - L.iw * s2) / 2;
    v.panY = cy - iy * s2 - (h - L.ih * s2) / 2;
    if (z === MIN_ZOOM) { v.panX = 0; v.panY = 0; }
    scheduleDraw();
  }

  // ---- drawing (rAF + timeout fallback — hidden tabs suspend rAF) --------

  function draw() {
    const el = containerRef.current;
    const canvas = canvasRef.current;
    if (!el || !canvas) return;
    const availW = Math.max(0, el.clientWidth - 48);
    const availH = Math.max(0, el.clientHeight - 48);
    if (availW < 2 || availH < 2) {
      if (!retryTimerRef.current) {
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = 0;
          scheduleDraw();
        }, 200);
      }
      return;
    }
    sizeRef.current = { w: availW, h: availH };
    canvas.style.width = `${availW}px`;
    canvas.style.height = `${availH}px`;
    const dpr = window.devicePixelRatio || 1;
    const pw = Math.round(availW * dpr);
    const ph = Math.round(availH * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, availW, availH);

    const L = layout();
    ctx.drawImage(data.original, L.ox, L.oy, L.iw * L.s, L.ih * L.s);

    // Live preview: dim everything, then re-draw the selected region bright.
    if (previewRef.current) {
      ctx.fillStyle = 'rgba(8, 8, 12, 0.55)';
      ctx.fillRect(L.ox, L.oy, L.iw * L.s, L.ih * L.s);
      ctx.drawImage(previewRef.current, L.ox, L.oy, L.iw * L.s, L.ih * L.s);
    }

    // Committed box, or the one being dragged.
    const g = gestureRef.current;
    let bx: { x: number; y: number; w: number; h: number } | null = null;
    if (g?.mode === 'box') {
      bx = {
        x: Math.min(g.sx, g.cx), y: Math.min(g.sy, g.cy),
        w: Math.abs(g.cx - g.sx), h: Math.abs(g.cy - g.sy),
      };
    } else if (boxRef.current) {
      const a = toCanvas(boxRef.current.x1, boxRef.current.y1);
      const b = toCanvas(boxRef.current.x2, boxRef.current.y2);
      bx = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
    }
    if (bx) {
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = 3;
      ctx.strokeRect(bx.x, bx.y, bx.w, bx.h);
      ctx.setLineDash([6, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.95)';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(bx.x, bx.y, bx.w, bx.h);
      ctx.restore();
    }

    // Pins: green + for keep, red − for exclude.
    for (const p of pointsRef.current) {
      const c = toCanvas(p.x, p.y);
      ctx.beginPath();
      ctx.arc(c.x, c.y, PIN_R, 0, Math.PI * 2);
      ctx.fillStyle = p.label === 1 ? '#22c55e' : '#ef4444';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(c.x - 4, c.y);
      ctx.lineTo(c.x + 4, c.y);
      if (p.label === 1) {
        ctx.moveTo(c.x, c.y - 4);
        ctx.lineTo(c.x, c.y + 4);
      }
      ctx.stroke();
    }
  }

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
    const onVis = () => scheduleDraw();
    window.addEventListener('resize', onVis);
    document.addEventListener('visibilitychange', onVis);
    scheduleDraw();
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', onVis);
      document.removeEventListener('visibilitychange', onVis);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      if (fallbackRef.current) clearTimeout(fallbackRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- model: load once, encode per image --------------------------------

  useEffect(() => {
    let alive = true;
    pointsRef.current = [];
    boxRef.current = null;
    maskRef.current = null;
    previewRef.current = null;
    viewRef.current = { zoom: 1, panX: 0, panY: 0 };
    setHasMask(false);
    setHasPrompts(false);
    setError('');
    setPhase('loading');
    setProgress(0);
    (async () => {
      try {
        await loadDetailModel((p) => { if (alive) setProgress(p); });
        if (!alive) return;
        setPhase('encoding');
        const enc = await encodeDetailImage(data.original);
        if (!alive) return;
        encRef.current = enc;
        setPhase('ready');
        scheduleDraw();
      } catch (e) {
        if (alive) {
          setPhase('error');
          setError(e instanceof Error ? e.message : String(e));
        }
      }
    })();
    return () => {
      alive = false;
      encRef.current = null; // release embedding memory
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.id, retryTick]);

  // ---- decoding (serialized, latest-wins) --------------------------------

  function syncPromptState() {
    setHasPrompts(pointsRef.current.length > 0 || !!boxRef.current);
  }

  async function runDecode() {
    const enc = encRef.current;
    if (!enc) return;
    if (!pointsRef.current.length && !boxRef.current) {
      maskRef.current = null;
      previewRef.current = null;
      setHasMask(false);
      scheduleDraw();
      return;
    }
    if (decodingRef.current) {
      pendingRef.current = true;
      return;
    }
    decodingRef.current = true;
    try {
      const mask = await decodeDetailMask(enc, pointsRef.current, boxRef.current);
      maskRef.current = mask;
      if (mask) {
        const pv = document.createElement('canvas');
        pv.width = data.original.width;
        pv.height = data.original.height;
        const px = pv.getContext('2d')!;
        px.drawImage(data.original, 0, 0);
        px.globalCompositeOperation = 'destination-in';
        px.drawImage(maskToCanvas(mask.data, mask.width, mask.height), 0, 0, pv.width, pv.height);
        previewRef.current = pv;
      } else {
        previewRef.current = null;
      }
      setHasMask(!!mask);
    } catch (e) {
      console.error('decode failed', e);
    }
    decodingRef.current = false;
    if (pendingRef.current) {
      pendingRef.current = false;
      runDecode();
    } else {
      scheduleDraw();
    }
  }

  // ---- pointers ----------------------------------------------------------

  function handleTap(px: number, py: number) {
    // Tap on an existing pin removes it.
    for (let i = 0; i < pointsRef.current.length; i++) {
      const c = toCanvas(pointsRef.current[i].x, pointsRef.current[i].y);
      if (Math.hypot(px - c.x, py - c.y) <= PIN_R + 4) {
        pointsRef.current.splice(i, 1);
        syncPromptState();
        runDecode();
        return;
      }
    }
    const p = toImage(px, py);
    const L = layout();
    if (p.x < 0 || p.y < 0 || p.x >= L.iw || p.y >= L.ih) return;
    const m = maskRef.current;
    const inMask = m
      ? m.data[Math.min(m.height - 1, Math.round(p.y)) * m.width + Math.min(m.width - 1, Math.round(p.x))] > 0
      : false;
    pointsRef.current.push({ x: p.x, y: p.y, label: inMask ? 0 : 1 });
    syncPromptState();
    runDecode();
  }

  function onPointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (phase !== 'ready') return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch { /* synthetic pointers can't be captured */ }
    const px = e.nativeEvent.offsetX;
    const py = e.nativeEvent.offsetY;
    pointersRef.current.set(e.pointerId, { x: px, y: py });
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = { d0: Math.hypot(a.x - b.x, a.y - b.y), zoom0: viewRef.current.zoom };
      gestureRef.current = null;
      return;
    }
    gestureRef.current = {
      mode: boxTool ? 'box' : 'tap',
      sx: px, sy: py, cx: px, cy: py,
      panX0: viewRef.current.panX, panY0: viewRef.current.panY,
    };
  }

  function onPointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    const px = e.nativeEvent.offsetX;
    const py = e.nativeEvent.offsetY;
    if (pointersRef.current.has(e.pointerId)) pointersRef.current.set(e.pointerId, { x: px, y: py });

    const pinch = pinchRef.current;
    if (pinch && pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.d0 > 0) zoomTo(pinch.zoom0 * (d / pinch.d0), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }

    const g = gestureRef.current;
    if (!g) return;
    g.cx = px;
    g.cy = py;
    const moved = Math.hypot(px - g.sx, py - g.sy) > 6;
    if (g.mode === 'tap' && moved) {
      // Drag with the tap tool pans when zoomed in; otherwise cancels the tap.
      g.mode = viewRef.current.zoom > 1 ? 'pan' : 'none';
    }
    if (g.mode === 'pan') {
      viewRef.current.panX = g.panX0 + (px - g.sx);
      viewRef.current.panY = g.panY0 + (py - g.sy);
    }
    if (g.mode === 'pan' || g.mode === 'box') scheduleDraw();
  }

  function onPointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
    pointersRef.current.delete(e.pointerId);
    if (pinchRef.current && pointersRef.current.size < 2) pinchRef.current = null;
    const g = gestureRef.current;
    gestureRef.current = null;
    if (!g) return;
    if (g.mode === 'tap') {
      handleTap(g.cx, g.cy);
    } else if (g.mode === 'box') {
      if (Math.abs(g.cx - g.sx) > 8 && Math.abs(g.cy - g.sy) > 8) {
        const a = toImage(Math.min(g.sx, g.cx), Math.min(g.sy, g.cy));
        const b = toImage(Math.max(g.sx, g.cx), Math.max(g.sy, g.cy));
        const L = layout();
        boxRef.current = {
          x1: Math.max(0, a.x), y1: Math.max(0, a.y),
          x2: Math.min(L.iw, b.x), y2: Math.min(L.ih, b.y),
        };
        syncPromptState();
        runDecode();
      }
    }
    scheduleDraw();
  }

  // Wheel zoom needs a non-passive native listener.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomTo(viewRef.current.zoom * f, e.offsetX, e.offsetY);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- actions -----------------------------------------------------------

  function clearAll() {
    pointsRef.current = [];
    boxRef.current = null;
    maskRef.current = null;
    previewRef.current = null;
    setHasMask(false);
    setHasPrompts(false);
    scheduleDraw();
  }

  function apply() {
    const mask = maskRef.current;
    if (!mask) return;
    onApply(applyMaskToOriginal(data.original, mask));
  }

  // ---- render ------------------------------------------------------------

  return (
    <div className="canvas-box" ref={containerRef}>
      <canvas
        ref={canvasRef}
        className="editor-canvas"
        style={{ cursor: 'crosshair', touchAction: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
      {(phase === 'loading' || phase === 'encoding') && (
        <div className="overlay">
          <div className="spinner" />
          <p>{phase === 'loading' ? 'Downloading selection AI…' : 'Reading image…'}</p>
          {phase === 'loading' && (
            <div className="bar"><i style={{ width: `${progress * 100}%` }} /></div>
          )}
        </div>
      )}
      {phase === 'error' && (
        <div className="overlay">
          <p className="overlay-err">Selection AI failed: {error}</p>
          <button className="btn primary" onClick={() => setRetryTick((t) => t + 1)}>Retry</button>
        </div>
      )}
      {phase === 'ready' && (
        <>
          <div className="toolbar">
            <button className={!boxTool ? 'tool active' : 'tool'} onClick={() => setBoxTool(false)}>
              <span className="tool-icon">◉</span>Tap
            </button>
            <button className={boxTool ? 'tool active' : 'tool'} onClick={() => setBoxTool(true)}>
              <span className="tool-icon">⬚</span>Box
            </button>
            {hasPrompts && (
              <button className="tool" onClick={clearAll}>Clear</button>
            )}
            <button className="tool cutout-go" disabled={!hasMask} onClick={apply}>
              ✂ Cut it out
            </button>
          </div>
          {!hasMask && (
            <div className="select-hint">
              Tap the product to select it. Tap a selected area to remove it.
              Pinch or scroll to zoom{boxTool ? ' — drag to draw a box.' : '.'}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Styles**

Append to `src/styles.css`:

```css
/* ---------- detail-shot select stage ---------- */

.select-hint {
  position: absolute;
  top: 18px;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(92vw, 520px);
  padding: 8px 14px;
  border-radius: 10px;
  background: rgba(13, 13, 17, 0.85);
  border: 1px solid var(--border);
  color: var(--muted);
  font-size: 12.5px;
  line-height: 1.5;
  text-align: center;
  pointer-events: none;
}

.tool.cutout-go {
  background: linear-gradient(135deg, var(--accent), var(--accent-2));
  color: #fff;
}
.tool.cutout-go:disabled { opacity: 0.4; }
```

- [ ] **Step 3: Mount it in App.tsx**

Import `SelectStage` and replace the Task 3 placeholder. The stage section becomes:

```tsx
<section className="stage">
  {selected && selData && selected.status === 'select' ? (
    <SelectStage
      meta={selected}
      data={selData}
      onApply={(cutout) => applyDetailCutout(selected.id, cutout)}
    />
  ) : (
    <>
      <EditorCanvas /* ...existing props unchanged... */ />
      {selected && selected.status !== 'ready' && (
        /* existing overlay, with the Task 3 'select' branch REMOVED —
           only error/spinner branches remain */
      )}
      {selected?.status === 'ready' && (
        /* existing toolbar unchanged */
      )}
    </>
  )}
</section>
```

Also delete the temporary `void applyDetailCutout;` from Task 3.

- [ ] **Step 4: Verify the full flow in the browser**

Dev server up, preview open. Ground shadow OFF first (Adjust → Shadow → None) per the pixel-probe protocol. Use a real product close-up photo (one where part of a product is cropped by the frame with visible floor/surface).

1. Upload via "⬚ Detail shot" → "Downloading selection AI…" bar (first run), then "Reading image…", then hint appears.
2. Tap the product → pins render, subject brightens, background dims (screenshot).
3. Tap the background inside the selection if it over-grabbed → red pin, selection shrinks.
4. Tap a pin → it disappears, mask updates.
5. Box tool → drag around the product part → selection scoped to the box.
6. Wheel-zoom in → tap precision preserved (pins land where clicked); drag pans while zoomed.
7. "Cut it out" → item flips to `ready`; the normal editor appears; backdrop white/color/transparent all work; erase/restore brushes work on the result; export produces the cutout.
8. Adjust → "Re-select subject" → back in the select stage, fresh prompts.
9. Console: no errors throughout.

Screenshot proof at steps 2, 6, and 7.

- [ ] **Step 5: Commit**

```
git -C C:\Users\HP\Desktop\Project-Host add src/components/SelectStage.tsx src/App.tsx src/styles.css
git -C C:\Users\HP\Desktop\Project-Host commit -m "feat: SelectStage — tap/box detail cutout UI with live preview and zoom"
```

---

### Task 5: Cleanup, build check, and end-to-end quality verification

**Files:**
- Delete: `spike.html`, `src/spikeMain.ts`
- No other source changes expected (fix regressions if verification finds them).

**Interfaces:** none — this task removes scaffolding and proves quality.

- [ ] **Step 1: Delete the spike**

```
git -C C:\Users\HP\Desktop\Project-Host rm spike.html src/spikeMain.ts
```

- [ ] **Step 2: Type-check + production build**

**Stop the dev server first** (global constraint — build clobbers the .vite cache).
Run: `npm --prefix C:\Users\HP\Desktop\Project-Host run build`
Expected: `tsc` clean, Vite build succeeds.
Run: `npm --prefix C:\Users\HP\Desktop\Project-Host run test`
Expected: PASS (5 tests).
Restart the dev server after.

- [ ] **Step 3: Edge-quality verification on real photos**

This is the gate the ghost-mannequin lesson demands — judge the render, not the code. Use the user's example shot if provided; otherwise at least two real close-up product photos (e.g. garment waistline on floor, shoe side on table).

For each photo, in the running app:
1. Detail-shot flow → select → "Cut it out" → white backdrop.
2. Take a screenshot, then **zoom the region tools on the cut edges** (magnified screenshot): interior edges must look smooth/feathered, with no background halo and no jagged staircase.
3. Where the product meets the photo frame: the cut must be razor-straight (hard edge), not feathered.
4. Pixel probes in ONE eval (shadow off, transparent backdrop): sample points that were background → alpha 0; points well inside the product → alpha 255; a point ON the frame-edge boundary row → alpha 255 (hard edge held).
5. Export a PNG and verify the downloaded file's transparency in the same way.

If edges fail the eyeball test, tune `feather` (1–2.5 range) in `applyMaskToOriginal` and re-verify — do not ship on pixel probes alone.

- [ ] **Step 4: Regression sweep**

1. Auto mode: upload a normal full-product photo → ISNet path unchanged (ready, brushes, export).
2. Mixed batch: two auto + one detail → autos process while detail waits; ZIP export contains the ready ones.
3. ≤980 px viewport (resize_window mobile preset): select stage usable — toolbar visible, taps land correctly, pinch zoom works.

- [ ] **Step 5: Final commit**

```
git -C C:\Users\HP\Desktop\Project-Host add -A
git -C C:\Users\HP\Desktop\Project-Host commit -m "chore: remove SAM spike; detail-shot cutout verified end-to-end"
```

---

## Self-Review Notes

- **Spec coverage:** upload-time mode choice (T3), tap add/subtract + pin removal (T4), box prompt (T1/T4), live preview (T4), "Cut it out"/"Re-select" (T3/T4), SlimSAM via transformers.js + lazy load + progress (T1/T4), mask refinement + frame-edge hard rule (T2), downstream untouched (T3 routing keeps queue effect intact; T4 produces standard cutout canvas), batch "needs selection" behavior (T3), error/retry (T1 loader retry + T4 error phase), memory release (T4 encode effect cleanup), verification protocol (T5). Mobile redesign correctly absent (out of scope).
- **Known risk consciously accepted:** exact transformers.js SAM API surface (`RawImage.fromCanvas`, `input_boxes` with cached embeddings) is verified by the Task 1 spike *before* any UI work; fixes stay inside `detailSelect.ts`.
