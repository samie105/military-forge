/**
 * The pause menu's quick Button fade (the owner, 23 Oct: "a way to fade the buttons", where players
 * look): the same setting as Settings → Touch → Button fade (touch settings.opacity), live and saved.
 * Shown only while the touch controls are up.
 */
import { useEffect, useState } from 'react';
import { getTouchSettings, onTouchChange, setTouchSettings, touchActive } from '../../touch';
import { Slider } from '../../ui/Slider';
import './buttonFade.css';

export function ButtonFadeQuick({ className }: { className?: string }) {
  const [s, setS] = useState(() => ({ opacity: getTouchSettings().opacity, on: touchActive() }));
  useEffect(() => onTouchChange(() => setS({ opacity: getTouchSettings().opacity, on: touchActive() })), []);
  if (!s.on) return null;
  const pct = `${Math.round(s.opacity * 100)}%`;
  return (
    <div className={['mf-fadequick', className].filter(Boolean).join(' ')}>
      <span className="label">Button fade</span>
      <Slider value={(s.opacity - 0.15) / 0.85} onChange={(v) => setTouchSettings({ opacity: Math.round((0.15 + v * 0.85) * 100) / 100 })} label="Button fade" valueText={pct} min={15} max={100} />
      <output className="num">{pct}</output>
    </div>
  );
}
