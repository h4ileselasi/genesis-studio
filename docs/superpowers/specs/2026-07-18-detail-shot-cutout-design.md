# Detail Shot Cutout — Design

**Date:** 2026-07-18
**Status:** Approved by user (conversation), pending spec review
**Project:** Genesis Studio (browser-only Photoroom-style product-photo editor)

## Problem

Genesis Studio's cutout pipeline runs ISNet (`@imgly/background-removal`), a salient-whole-object model. It assumes the photo contains one main, mostly-complete subject. Close-up / partial product shots — the waistline of trousers, the side of a shoe, buttons, an edge — have no such subject: the product is cropped by the frame and off-center, and the floor/surface/wall shows. ISNet grabs the wrong region and leaves background remnants. No tuning of ISNet fixes this; it is the wrong model class for detail shots.

## Goal

A new **Detail shot** mode: the user indicates the product portion with a **tap** (and optionally a **rough box**), the system cuts out exactly that region cleanly, and everything downstream (backdrops white/color/transparent/scenes, shadows, brushes, export) works unchanged on the result.

## Scope decisions (from brainstorm)

- Prompt inputs: **tap points AND box** (user chose A + C). Both are native prompt types of the chosen model.
- **Mobile:** the new mode is designed tap-first so it works on phones, but the broader mobile redesign of the app is explicitly **out of scope** — it becomes its own project after this ships.
- Fully-automatic detail detection (no tap) was considered and rejected: same ambiguity failure as today, just better odds.

## Approaches considered

1. **On-device promptable segmentation (SAM family) — CHOSEN.** Second in-browser model purpose-built for point/box → mask.
2. Box-crop + existing ISNet — rejected: ISNet still guesses saliency inside the crop; same failure mode.
3. Cloud segmentation API — rejected: breaks the project's browser-only / no-backend / no-per-image-cost rule.

## Design

### 1. UI flow

- Upload screen gains a per-image mode choice: **Full product** (current automatic pipeline, remains the default) and **Detail shot**.
- Detail shot skips ISNet entirely and opens the editor in a new **Select stage**: original photo shown full-color with hint text ("Tap the product to select it").
  - **Tap** on unselected area → positive point (selection grows). **Tap on a selected area** → negative point (removes over-grab). Taps drop visible pins; tapping a pin removes it.
  - **Box tool** (toggle button in the Select-stage toolbar): one-finger/mouse drag draws a rectangle prompt. Pinch / scroll wheel still zooms. No panning gesture exists in the Select stage, so drag is unambiguous.
  - Live preview after every prompt: subject stays full-color, background dims.
  - **"Cut it out"** applies the selection → item becomes a normal cutout.
  - **"Re-select"** button in the editor returns to the Select stage without re-uploading.
- Batch queue: detail-shot items sit in state "needs selection" instead of auto-processing; mixed batches (auto + detail) flow normally.

### 2. AI engine

- Model: **SlimSAM** (compact Segment Anything variant), via **transformers.js** (`@huggingface/transformers`), fetched from the Hugging Face CDN on first use (~10–30 MB) and cached by the browser — the same pattern as ISNet from the imgly CDN.
- New module `src/lib/detailSelect.ts` exposing roughly:
  - `loadModel(onProgress)` — lazy, first detail-mode use only.
  - `encodeImage(bitmap, onProgress)` → per-image embedding (runs once, seconds; progress shown as "Reading image…").
  - `maskFromPrompts(embedding, points[], box?)` → mask (fraction of a second per prompt; SAM returns candidate masks, we take the top-scored one).
- Image is downscaled to the model's input size (1024 longest side) for encoding; the final mask is applied to the **full-resolution** original.
- ISNet path is untouched.

### 3. Edge refinement

Raw SAM masks are coarse (low-res, near-binary). Before becoming the cutout alpha:

1. Upscale mask to full resolution.
2. Morphological cleanup (remove speckle holes/islands).
3. Contour smoothing + ~1–2 px feather, reusing the feathering approach proven in `src/lib/select.ts` (`applyRemoval`).
4. **Frame-edge rule:** where the mask touches the photo frame (product cropped by the shot), the edge stays hard and straight — no feather — matching how a cropped detail shot should read.

### 4. Downstream integration

The Select stage outputs the same cutout-canvas shape ISNet produces today. Compositor, brushes (move/erase/restore/heal), magnifier loupe, Select & Remove, rotation/flip, backdrops, shadows, and export presets require **zero modification**. `ItemData` gains a `mode: 'auto' | 'detail'` field and a "needs selection" queue state. Prompt pins/embedding are session-only (dropped on apply; Re-select re-encodes if needed).

### 5. Error handling

- Model download failure → same retry treatment + message as the ISNet path.
- Wrong selection → negative taps, box, Re-select; existing erase/restore brushes remain the manual escape hatch after applying.
- Slow devices: only the once-per-image encode is slow (WASM; est. ~2–6 s desktop, longer on phones) and it gets an honest progress bar; per-tap decoding stays fast. WASM execution is the default for reliability; WebGPU can be explored later.
- Memory: embeddings are a few MB; released when leaving the Select stage.

### 6. Verification

- Real detail shots (including the user's example when provided) exercised in the running app: tap/box, apply, then inspect **magnified screenshots of actual output edges** — realism is judged on renders, not on code running (standing lesson from the removed ghost-mannequin feature).
- Pixel-probe checks: background fully transparent outside the mask, product region intact inside, hard edge at frame boundaries.
- Editor pixel-testing protocol per project notes: sample→act→verify within one eval, ground shadow off first, prefer fiber-probing ItemData over screen-scan heuristics.

## Out of scope

- General mobile redesign of the editor (next project).
- Automatic no-tap detail detection.
- Generative garment features (ghost mannequin, iron & freshen) — explicitly rejected previously; do not rebuild.
