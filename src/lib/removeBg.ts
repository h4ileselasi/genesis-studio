import { removeBackground } from '@imgly/background-removal';

/**
 * Runs the ISNet segmentation model fully in-browser (WASM via onnxruntime).
 * First call downloads the model (~40 MB) from the imgly CDN; it is cached
 * by the browser afterwards.
 */
export async function removeBg(
  input: Blob,
  onProgress: (p: number, label: string) => void,
): Promise<Blob> {
  return removeBackground(input, {
    model: 'isnet_fp16',
    progress: (key, current, total) => {
      const p = total > 0 ? current / total : 0;
      onProgress(
        Math.max(0, Math.min(1, p)),
        key.startsWith('fetch') ? 'Downloading AI model' : 'Cutting out subject',
      );
    },
  });
}
