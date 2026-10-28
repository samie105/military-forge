/**
 * The kit's slider (.slider: track, fill, thumb, all from one --v 0..1) as a working control:
 * drag anywhere on it, or use the arrow keys, Page Up/Down, Home and End.
 */
import { useRef, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { logicalPoint, logicalRect } from './landscape';

export interface SliderProps {
  /** 0..1 */
  value: number;
  onChange(value: number): void;
  label: string;
  /** what a screen reader hears ("80%") */
  valueText: string;
  /** the step for arrow keys, as a fraction of the range (default 0.05) */
  step?: number;
  /** labels under the track (the kit's text-size ticks) */
  ticks?: readonly string[];
  /** aria-valuemin/max for the value as shown (default 0–100) */
  min?: number;
  max?: number;
  disabled?: boolean;
  /** where the default sits, 0..1 (the kit's .slider__def mark: Tune the game) */
  def?: number;
  /** the value as shown, for aria-valuenow (default: the 0..1 value mapped onto min..max, rounded) */
  now?: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export function Slider({ value, onChange, label, valueText, step = 0.05, ticks, min = 0, max = 100, disabled = false, def, now }: SliderProps) {
  const el = useRef<HTMLDivElement>(null);
  const v = clamp01(value);
  const set = (next: number) => {
    const snapped = Math.round(clamp01(next) / step) * step;
    if (Math.abs(snapped - v) > 1e-9) onChange(clamp01(snapped));
  };
  const fromPointer = (e: PointerEvent<HTMLDivElement>) => {
    // the page's own axes: an upright phone plays turned onto its side (landscape.ts)
    const r = logicalRect(el.current!);
    if (r.width > 0) set((logicalPoint(e).x - r.left) / r.width);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number> = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step, PageDown: -step * 4, PageUp: step * 4 };
    if (e.key in moves) set(v + moves[e.key]!);
    else if (e.key === 'Home') set(0);
    else if (e.key === 'End') set(1);
    else return;
    e.preventDefault();
  };
  return (
    <div
      ref={el}
      className={ticks ? 'slider slider--ticks' : 'slider'}
      style={{ '--v': v } as CSSProperties}
      role="slider"
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={now ?? Math.round(min + v * (max - min))}
      aria-valuetext={valueText}
      aria-disabled={disabled || undefined}
      onKeyDown={disabled ? undefined : onKey}
      onPointerDown={
        disabled
          ? undefined
          : (e) => {
              el.current!.setPointerCapture(e.pointerId);
              fromPointer(e);
            }
      }
      onPointerMove={disabled ? undefined : (e) => el.current!.hasPointerCapture(e.pointerId) && fromPointer(e)}
    >
      <div className="slider__track">
        <div className="slider__fill"></div>
      </div>
      {def !== undefined && <div className="slider__def" style={{ '--d': clamp01(def) } as CSSProperties} aria-hidden="true"></div>}
      <div className="slider__thumb"></div>
      {ticks && (
        <div className="slider__ticks" aria-hidden="true">
          {ticks.map((t, i) => {
            const at = ticks.length > 1 ? i / (ticks.length - 1) : 0;
            return (
              <span key={t} className={Math.abs(at - v) < 1e-6 ? 'is-on' : undefined} style={{ '--t': at } as CSSProperties}>
                {t}
              </span>
            );
          })}
        </div>
      )}
    </div>
  );
}
