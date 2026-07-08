import { ChangeEvent, ReactNode } from 'react';
import { BackgroundSpec, ShadowSpec } from '../types';
import { BG_COLORS, BG_GRADIENTS, BG_SCENES, EXPORT_PRESETS } from '../lib/presets';

export type PanelTab = 'background' | 'adjust' | 'export';
export type ExportFormat = 'png' | 'jpeg' | 'webp';

interface Props {
  tab: PanelTab;
  setTab: (t: PanelTab) => void;
  background: BackgroundSpec;
  setBackground: (b: BackgroundSpec) => void;
  shadow: ShadowSpec;
  setShadow: (s: ShadowSpec) => void;
  subjectScale: number;
  onSubjectScale: (v: number) => void;
  onResetTransform: () => void;
  rotation: number;
  onRotate: (deg: number) => void;
  flipX: boolean;
  flipY: boolean;
  onFlipX: () => void;
  onFlipY: () => void;
  onRecut: () => void;
  onBgImageUpload: (f: File) => void;
  exportPresetId: string;
  setExportPresetId: (id: string) => void;
  format: ExportFormat;
  setFormat: (f: ExportFormat) => void;
  quality: number;
  setQuality: (q: number) => void;
  onExportCurrent: () => void;
  onExportAll: () => void;
  exporting: boolean;
  canExport: boolean;
  readyCount: number;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="section">
      <div className="section-title">{title}</div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value, options, onChange,
}: {
  value: T;
  options: { v: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="segmented">
      {options.map((o) => (
        <button
          key={o.v}
          className={o.v === value ? 'seg active' : 'seg'}
          onClick={() => onChange(o.v)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Slider({
  label, value, min, max, step = 1, onChange, format,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
}) {
  return (
    <label className="slider-row">
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <em>{format ? format(value) : value}</em>
    </label>
  );
}

export default function Panels(p: Props) {
  const bg = p.background;

  const pickFile = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) p.onBgImageUpload(f);
    e.target.value = '';
  };

  return (
    <aside className="panels">
      <div className="tabs">
        {(['background', 'adjust', 'export'] as PanelTab[]).map((t) => (
          <button
            key={t}
            className={t === p.tab ? 'tab active' : 'tab'}
            onClick={() => p.setTab(t)}
          >
            {t === 'background' ? 'Backdrop' : t === 'adjust' ? 'Adjust' : 'Export'}
          </button>
        ))}
      </div>

      {p.tab === 'background' && (
        <div className="panel-body">
          <Section title="Colors">
            <div className="swatches">
              <button
                title="Transparent"
                className={bg.kind === 'transparent' ? 'swatch checker active' : 'swatch checker'}
                onClick={() => p.setBackground({ kind: 'transparent' })}
              />
              {BG_COLORS.map((c) => (
                <button
                  key={c}
                  title={c}
                  className={bg.kind === 'color' && bg.color === c ? 'swatch active' : 'swatch'}
                  style={{ background: c }}
                  onClick={() => p.setBackground({ kind: 'color', color: c })}
                />
              ))}
              <label
                className="swatch custom"
                title="Custom color"
                style={bg.kind === 'color' && !BG_COLORS.includes(bg.color) ? { background: bg.color } : undefined}
              >
                <input
                  type="color"
                  value={bg.kind === 'color' ? bg.color : '#8b5cf6'}
                  onChange={(e) => p.setBackground({ kind: 'color', color: e.target.value })}
                />
                +
              </label>
            </div>
          </Section>

          <Section title="Gradients">
            <div className="swatches">
              {BG_GRADIENTS.map((g) => (
                <button
                  key={g.label}
                  title={g.label}
                  className={
                    bg.kind === 'gradient' && bg.from === g.from && bg.to === g.to
                      ? 'swatch active'
                      : 'swatch'
                  }
                  style={{ background: `linear-gradient(${g.angle}deg, ${g.from}, ${g.to})` }}
                  onClick={() => p.setBackground({ kind: 'gradient', from: g.from, to: g.to, angle: g.angle })}
                />
              ))}
            </div>
          </Section>

          <Section title="Studio scenes">
            <div className="scene-grid">
              {BG_SCENES.map((s) => (
                <button
                  key={s.id}
                  className={bg.kind === 'scene' && bg.id === s.id ? 'scene active' : 'scene'}
                  onClick={() => p.setBackground({ kind: 'scene', id: s.id })}
                >
                  <span className="scene-preview" style={{ background: s.css }} />
                  <span className="scene-label">{s.label}</span>
                </button>
              ))}
            </div>
          </Section>

          <Section title="Custom image">
            <label className="btn ghost full">
              Upload backdrop…
              <input type="file" accept="image/*" hidden onChange={pickFile} />
            </label>
            {bg.kind === 'image' && <div className="hint">Custom backdrop active.</div>}
          </Section>
        </div>
      )}

      {p.tab === 'adjust' && (
        <div className="panel-body">
          <Section title="Subject">
            <Slider
              label="Size"
              value={Math.round(p.subjectScale * 100)}
              min={20}
              max={300}
              onChange={(v) => p.onSubjectScale(v / 100)}
              format={(v) => `${v}%`}
            />
            <button className="btn ghost full" onClick={p.onResetTransform}>
              Center &amp; reset all
            </button>
            <div className="hint">Drag the subject to move it. Scroll to resize.</div>
          </Section>

          <Section title="Orientation">
            <Slider
              label="Rotate"
              value={p.rotation}
              min={-180}
              max={180}
              onChange={p.onRotate}
              format={(v) => `${v}°`}
            />
            <div className="btn-row">
              <button
                className="btn ghost"
                onClick={() => p.onRotate(((p.rotation - 90 + 540) % 360) - 180)}
              >
                ⟲ 90°
              </button>
              <button
                className="btn ghost"
                onClick={() => p.onRotate(((p.rotation + 90 + 540) % 360) - 180)}
              >
                ⟳ 90°
              </button>
            </div>
            <div className="btn-row">
              <button className={p.flipX ? 'btn ghost on' : 'btn ghost'} onClick={p.onFlipX}>
                ⇋ Flip H
              </button>
              <button className={p.flipY ? 'btn ghost on' : 'btn ghost'} onClick={p.onFlipY}>
                ⇵ Flip V
              </button>
            </div>
          </Section>

          <Section title="Shadow">
            <Segmented
              value={p.shadow.kind}
              options={[
                { v: 'none', label: 'None' },
                { v: 'ground', label: 'Ground' },
                { v: 'drop', label: 'Drop' },
              ]}
              onChange={(kind) => p.setShadow({ ...p.shadow, kind })}
            />
            {p.shadow.kind !== 'none' && (
              <Slider
                label="Opacity"
                value={Math.round(p.shadow.opacity * 100)}
                min={5}
                max={80}
                onChange={(v) => p.setShadow({ ...p.shadow, opacity: v / 100 })}
                format={(v) => `${v}%`}
              />
            )}
            {p.shadow.kind !== 'none' && (
              <Slider
                label="Softness"
                value={p.shadow.blur}
                min={0}
                max={80}
                onChange={(v) => p.setShadow({ ...p.shadow, blur: v })}
              />
            )}
            {p.shadow.kind === 'drop' && (
              <Slider
                label="Distance"
                value={p.shadow.offsetY}
                min={0}
                max={60}
                onChange={(v) => p.setShadow({ ...p.shadow, offsetY: v })}
              />
            )}
          </Section>

          <Section title="AI cutout">
            <button className="btn ghost full" onClick={p.onRecut}>
              ↺ Re-run background removal
            </button>
            <div className="hint">
              Discards manual erase/restore edits on this image and cuts it out again.
            </div>
          </Section>
        </div>
      )}

      {p.tab === 'export' && (
        <div className="panel-body">
          <Section title="Size">
            <select
              className="select"
              value={p.exportPresetId}
              onChange={(e) => p.setExportPresetId(e.target.value)}
            >
              {EXPORT_PRESETS.map((pr) => (
                <option key={pr.id} value={pr.id}>{pr.label}</option>
              ))}
            </select>
          </Section>

          <Section title="Format">
            <Segmented
              value={p.format}
              options={[
                { v: 'png', label: 'PNG' },
                { v: 'jpeg', label: 'JPG' },
                { v: 'webp', label: 'WebP' },
              ]}
              onChange={p.setFormat}
            />
            {p.format !== 'png' && (
              <Slider
                label="Quality"
                value={Math.round(p.quality * 100)}
                min={40}
                max={100}
                onChange={(v) => p.setQuality(v / 100)}
                format={(v) => `${v}%`}
              />
            )}
            <div className="hint">
              {p.format === 'png'
                ? 'PNG keeps transparency.'
                : 'Transparent backdrops are exported on white.'}
            </div>
          </Section>

          <Section title="Download">
            <button
              className="btn primary full"
              disabled={!p.canExport || p.exporting}
              onClick={p.onExportCurrent}
            >
              {p.exporting ? 'Exporting…' : 'Export this image'}
            </button>
            <button
              className="btn ghost full"
              disabled={p.readyCount === 0 || p.exporting}
              onClick={p.onExportAll}
            >
              {p.exporting ? 'Exporting…' : `Export all ${p.readyCount} as ZIP`}
            </button>
          </Section>
        </div>
      )}
    </aside>
  );
}
