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

export interface ItemData {
  original: HTMLCanvasElement;
  cutout: HTMLCanvasElement | null;
  transform: Transform;
  backup: HTMLCanvasElement | null; // pre-refresh snapshot for revert
}

export interface ExportPreset {
  id: string;
  label: string;
  w: number | null; // null = original size
  h: number | null;
}
