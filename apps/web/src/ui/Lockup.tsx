/**
 * The Forged Force lockup (ui/lockupArt.ts, made by art/pipeline/lockup.py): the anvil-shield emblem beside the
 * stacked stencil wordmark, as vector paths in the kit's colours (lockup.css). The landing draws the same markup
 * from index.html (vite.config.ts), so the title takes over from it without a seam.
 *
 *   <Lockup label="Forged Force" />          an image with that name
 *   <Lockup label={null} />                  decoration (the name is in text beside it)
 *   <Lockup label="…" mono />                one colour (currentColor): small places, flat prints
 */
import { lockupMarkup } from './lockupArt';
import './lockup.css';

export function Lockup({ label, mono = false, className = '' }: { label: string | null; mono?: boolean; className?: string }) {
  // the markup is generated at build time from the font's outlines, never from input
  return <span className="mf-lockup-box" dangerouslySetInnerHTML={{ __html: lockupMarkup(label, className, mono) }} />;
}
