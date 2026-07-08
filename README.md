# Genesis Studio

Browser-based AI product-photo studio (an on-device Photoroom alternative). Background
removal, retouch brushes (erase / restore / magic-heal), garment "iron & freshen", studio
backdrops, orientation controls, and batch export — all running client-side. Nothing is
uploaded to a server; the AI segmentation model runs in the browser via WebAssembly.

## Run locally

```bash
npm install
npm run dev
```

Open http://localhost:5174

## Build for hosting

```bash
npm run build
```

This produces a static site in `dist/`. Everything is static — no backend required.

## Deploy

The contents of `dist/` can be served by any static host:

- **Netlify / Vercel** — set the build command to `npm run build` and the publish
  directory to `dist`.
- **GitHub Pages** — push `dist/` to a `gh-pages` branch (or use an action). If the site
  is served from a sub-path, set Vite's `base` in `vite.config.ts` accordingly.
- **Any web server (nginx, Apache, S3, etc.)** — upload the `dist/` folder and serve it
  as static files.

> Note: the ~24 MB ONNX/WASM segmentation model is fetched from the imgly CDN the first
> time a user removes a background, then cached by the browser. No API keys are needed.

## Tech

Vite + React + TypeScript. Key modules:

- `src/lib/removeBg.ts` — on-device background removal (`@imgly/background-removal`)
- `src/lib/compositor.ts` — canvas compositing, transforms, shadows
- `src/lib/inpaint.ts` — magic-heal content-aware fill
- `src/lib/ghost.ts` — ghost mannequin: body-profile warp (male/female, shirt/trousers,
  front/back), carved neck/waist opening with rendered interior back panel
