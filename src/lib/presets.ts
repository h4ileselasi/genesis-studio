import { ExportPreset, SceneId } from '../types';

export const BG_COLORS = [
  '#ffffff', '#000000', '#f4f4f5', '#e7e0d4',
  '#fde2e4', '#dbeafe', '#dcfce7', '#fef9c3',
];

export const BG_GRADIENTS: { label: string; from: string; to: string; angle: number }[] = [
  { label: 'Sunset', from: '#ff9d6c', to: '#bb4e75', angle: 135 },
  { label: 'Ocean', from: '#38bdf8', to: '#1e3a8a', angle: 160 },
  { label: 'Aurora', from: '#34d399', to: '#0ea5e9', angle: 120 },
  { label: 'Gold', from: '#f7d488', to: '#b8860b', angle: 150 },
  { label: 'Berry', from: '#f472b6', to: '#7c3aed', angle: 135 },
  { label: 'Slate', from: '#64748b', to: '#0f172a', angle: 160 },
];

export const BG_SCENES: { id: SceneId; label: string; css: string }[] = [
  { id: 'studio-light', label: 'Studio Light', css: 'radial-gradient(120% 90% at 50% 20%, #ffffff 0%, #d9d9e0 100%)' },
  { id: 'studio-dark', label: 'Studio Dark', css: 'radial-gradient(120% 90% at 50% 25%, #3a3a44 0%, #0c0c10 100%)' },
  { id: 'sand', label: 'Sand', css: 'linear-gradient(180deg, #eeddc0, #c9a87c)' },
  { id: 'sage', label: 'Sage', css: 'linear-gradient(180deg, #dfe8dc, #9db39a)' },
  { id: 'sky', label: 'Sky', css: 'linear-gradient(180deg, #dff1ff, #9cc8ee)' },
  { id: 'blush', label: 'Blush', css: 'linear-gradient(180deg, #fbe3e8, #e3a5b8)' },
];

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: 'original', label: 'Original size', w: null, h: null },
  { id: 'square', label: 'Square — 1080×1080', w: 1080, h: 1080 },
  { id: 'amazon', label: 'Amazon — 2000×2000', w: 2000, h: 2000 },
  { id: 'portrait', label: 'Portrait — 1080×1350', w: 1080, h: 1350 },
  { id: 'story', label: 'Story — 1080×1920', w: 1080, h: 1920 },
  { id: 'landscape', label: 'Banner — 1200×628', w: 1200, h: 628 },
];
