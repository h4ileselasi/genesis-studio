export type SceneId = 'studio-light' | 'studio-dark' | 'sand' | 'sage' | 'sky' | 'blush';

export type BackgroundSpec =
  | { kind: 'transparent' }
  | { kind: 'color'; color: string }
  | { kind: 'gradient'; from: string; to: string; angle: number }
  | { kind: 'scene'; id: SceneId }
  | { kind: 'image'; url: string };

export type ShadowKind = 'none' | 'ground' | 'drop';

export interface ShadowSpec {
  kind: ShadowKind;
  opacity: number; // 0..1
  blur: number; // px at 1000px reference canvas
  offsetY: number; // px at 1000px reference canvas (drop only)
}

export interface Transform {
  x: number; // offset as fraction of canvas width
  y: number; // offset as fraction of canvas height
  scale: number;
  rotation: number; // degrees, -180..180
  flipX: boolean;
  flipY: boolean;
}

export type Tool = 'move' | 'erase' | 'restore' | 'heal';

export type Status = 'queued' | 'removing' | 'ready' | 'error';

export interface ItemMeta {
  id: string;
  name: string;
  status: Status;
  progress: number;
  progressLabel: string;
  thumb: string;
  error?: string;
}

export type GarmentKind = 'shirt' | 'trousers';
export type GhostView = 'front' | 'back';
export type GhostFit = 'male' | 'female';

export interface GhostOpts {
  garment: GarmentKind;
  view: GhostView;
  fit: GhostFit;
  volume: number; // 0..1 body shaping strength
  neckWidth: number; // 0..1 opening width
  neckDepth: number; // 0..1 opening depth
  neckY: number; // -1..1 vertical nudge of the opening
}

export interface GhostCache {
  key: string;
  canvas: HTMLCanvasElement;
  scaleByRow: Float32Array;
  cx: number;
}

export interface ItemData {
  original: HTMLCanvasElement;
  cutout: HTMLCanvasElement | null;
  transform: Transform;
  ghost: GhostOpts | null; // null = ghost mannequin off
  ghostCache: GhostCache | null;
  cutoutRev: number; // bumped on any cutout mutation to invalidate ghostCache
}

export interface ExportPreset {
  id: string;
  label: string;
  w: number | null; // null = original size
  h: number | null;
}
