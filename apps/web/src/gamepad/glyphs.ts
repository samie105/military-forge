/**
 * Button glyphs for prompts: PlayStation's shapes or Xbox's letters (and Nintendo's, which sit the
 * other way round), as text for the HUD's keycaps and as small drawings for the menus' (Kbd).
 * The drawings are this game's own: scalable outlines with each family's familiar face-button colours.
 *
 * A pad binding is shown as a code in the keyboard's namespace so every prompt (HUD, tips, the
 * controls card) can take it where it takes 'KeyE': `Pad<n>` is standard button n (standard.ts),
 * `PadLS` / `PadRS` the sticks, `PadLSUp` / `PadLSDown` the left stick pushed up or down.
 */
import { B, type PadFamily } from './standard';

export type GlyphFamily = Exclude<PadFamily, 'generic'>;

const PAD_CODE = /^Pad(\d{1,2}|LS|RS|LSUp|LSDown|RSUp|RSDown)$/;

export function isPadCode(code: string | undefined | null): code is string {
  return typeof code === 'string' && PAD_CODE.test(code);
}

export const padCode = (button: number): string => `Pad${button}`;

/** The button a `Pad<n>` code names, or −1 (a stick code). */
export function padButtonOf(code: string): number {
  const m = /^Pad(\d{1,2})$/.exec(code);
  return m ? Number(m[1]) : -1;
}

/** A generic pad shows Xbox's letters (most PC pads print them). */
export const glyphFamily = (f: PadFamily): GlyphFamily => (f === 'generic' ? 'xbox' : f);

const FACE: Record<GlyphFamily, readonly [string, string, string, string]> = {
  // bottom, right, left, top
  playstation: ['✕', '○', '□', '△'],
  xbox: ['A', 'B', 'X', 'Y'],
  nintendo: ['B', 'A', 'Y', 'X'],
};
const SHOULDERS: Record<GlyphFamily, readonly [string, string, string, string, string, string]> = {
  // L1 R1 L2 R2 L3 R3
  playstation: ['L1', 'R1', 'L2', 'R2', 'L3', 'R3'],
  xbox: ['LB', 'RB', 'LT', 'RT', 'LS', 'RS'],
  nintendo: ['L', 'R', 'ZL', 'ZR', 'LS', 'RS'],
};
const CENTRE: Record<GlyphFamily, readonly [select: string, start: string, home: string, extra: string]> = {
  playstation: ['Share', 'Options', 'Home', 'Touchpad'],
  xbox: ['View', 'Menu', 'Home', 'Share'],
  nintendo: ['−', '+', 'Home', 'Capture'],
};
const DPAD = ['D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →'] as const;
const DPAD_SHORT = ['D↑', 'D↓', 'D←', 'D→'] as const;

export interface LabelOptions {
  /** a DualSense calls its Share button "Create" */
  dualSense?: boolean;
  /** HUD keycaps: "D↑" rather than "D-pad ↑" */
  short?: boolean;
}

/** The words or symbol for a pad code ('Pad3' → "△" or "Y"), or '' for a code that isn't a pad's. */
export function padLabel(code: string, family: PadFamily, opts: LabelOptions = {}): string {
  const f = glyphFamily(family);
  switch (code) {
    case 'PadLS':
      return 'L stick';
    case 'PadRS':
      return 'R stick';
    case 'PadLSUp':
      return opts.short ? 'L↑' : 'L stick ↑';
    case 'PadLSDown':
      return opts.short ? 'L↓' : 'L stick ↓';
    case 'PadRSUp':
      return opts.short ? 'R↑' : 'R stick ↑';
    case 'PadRSDown':
      return opts.short ? 'R↓' : 'R stick ↓';
  }
  const b = padButtonOf(code);
  if (b < 0) return '';
  if (b <= B.North) return FACE[f][b]!;
  if (b <= B.R2) return SHOULDERS[f][b - B.L1]!;
  if (b === B.Select) return f === 'playstation' && opts.dualSense ? 'Create' : CENTRE[f][0];
  if (b === B.Start) return CENTRE[f][1];
  if (b === B.L3 || b === B.R3) return SHOULDERS[f][b - B.L3 + 4]!;
  if (b >= B.Up && b <= B.Right) return (opts.short ? DPAD_SHORT : DPAD)[b - B.Up]!;
  if (b === B.Home) return CENTRE[f][2];
  if (b === B.Extra) return CENTRE[f][3];
  return `Button ${b}`;
}

/** What a screen reader hears: "Triangle button", "Right trigger"… (the drawings are aria-hidden). */
export function padSpoken(code: string, family: PadFamily, opts: LabelOptions = {}): string {
  const f = glyphFamily(family);
  const b = padButtonOf(code);
  if (f === 'playstation' && b >= 0 && b <= B.North) return ['Cross', 'Circle', 'Square', 'Triangle'][b]! + ' button';
  if (b >= 0 && b <= B.North) return `${FACE[f][b]} button`;
  return padLabel(code, family, opts);
}

// ------------------------------------------------------------------ drawings

const svg = (body: string, w = 24) => `<svg class="mf-padglyph__svg" viewBox="0 0 ${w} 24" width="${w}" height="24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const text = (t: string, x = 12, size = 9) => `<text x="${x}" y="15.4" text-anchor="middle" font-size="${size}" font-weight="700" fill="currentColor" stroke="none" font-family="inherit">${t}</text>`;

/** The four PlayStation shapes, drawn inside a 24 × 24 ring. */
const SHAPES = [
  '<path d="M8.6 8.6 15.4 15.4M15.4 8.6 8.6 15.4"/>', // cross
  '<circle cx="12" cy="12" r="4.2"/>', // circle
  '<rect x="8.2" y="8.2" width="7.6" height="7.6" rx="0.6"/>', // square
  '<path d="M12 7.6 16.6 15.4H7.4Z"/>', // triangle
];

/** The face button `b` (0..3): a ring with the family's shape or letter. */
function faceGlyph(b: number, f: GlyphFamily): string {
  const ring = '<circle cx="12" cy="12" r="10"/>';
  const drawing = svg(ring + (f === 'playstation' ? SHAPES[b]! : text(FACE[f][b]!, 12, 11)));
  return f === 'nintendo' ? drawing : drawing.replace('class="mf-padglyph__svg"', `class="mf-padglyph__svg mf-padglyph__${f === 'playstation' ? 'ps' : 'xbox'}${b}"`);
}

/** A shoulder (a flat bumper) or a trigger (a taller, rounded-top shape) with its name. */
function shoulderGlyph(label: string, trigger: boolean): string {
  const w = 30;
  const shape = trigger ? '<path d="M3 21V9.5C3 5.5 7 3 15 3S27 5.5 27 9.5V21Z"/>' : '<rect x="2" y="6" width="26" height="13" rx="5"/>';
  return svg(shape + text(label, 15, label.length > 2 ? 7.5 : 9), w);
}

/** A stick seen from above: a ring, its cap, and an arrow when it's pushed one way. */
function stickGlyph(side: 'L' | 'R', push: 'up' | 'down' | null, label?: string): string {
  const arrow = push === 'up' ? '<path d="M12 1.2 9.6 4M12 1.2 14.4 4"/>' : push === 'down' ? '<path d="M12 22.8 9.6 20M12 22.8 14.4 20"/>' : '';
  return svg(`<circle cx="12" cy="12" r="9.2"/><circle cx="12" cy="12" r="5.4" stroke-width="1.2"/>${arrow}${text(label ?? side, 12, 7.5)}`);
}

/** A D-pad cross with the pressed arm filled. */
function dpadGlyph(dir: number): string {
  const arms = [
    'M9.5 2.5h5v6.5l-2.5 2.5-2.5-2.5z', // up
    'M9.5 21.5h5V15l-2.5-2.5L9.5 15z', // down
    'M2.5 9.5v5H9l2.5-2.5L9 9.5z', // left
    'M21.5 9.5v5H15l-2.5-2.5L15 9.5z', // right
  ];
  return svg(arms.map((d, i) => `<path d="${d}"${i === dir ? ' fill="currentColor"' : ''}/>`).join(''));
}

/** The small centre buttons: a pill with an outline sign (lines for a menu, squares for a view, an arrow to share). */
function centreGlyph(kind: 'menu' | 'view' | 'share' | 'pad' | 'home' | 'plus' | 'minus'): string {
  const signs: Record<typeof kind, string> = {
    menu: '<path d="M8.5 9h7M8.5 12h7M8.5 15h7"/>',
    view: '<rect x="7.5" y="8" width="6" height="5" rx="1"/><rect x="10.5" y="11" width="6" height="5" rx="1"/>',
    share: '<path d="M12 15.5V8.5M9.5 11 12 8.5l2.5 2.5"/>',
    pad: '<rect x="6.5" y="9" width="11" height="6" rx="1.4"/>',
    home: '<circle cx="12" cy="12" r="3.4"/>',
    plus: '<path d="M12 8.6v6.8M8.6 12h6.8"/>',
    minus: '<path d="M8.6 12h6.8"/>',
  };
  return svg(`<rect x="2.5" y="5" width="19" height="14" rx="7"/>${signs[kind]}`);
}

/** The drawing for a pad code (an inline SVG string), or '' for a code that isn't a pad's. */
export function padGlyphSvg(code: string, family: PadFamily): string {
  const f = glyphFamily(family);
  switch (code) {
    case 'PadLS':
      return stickGlyph('L', null);
    case 'PadRS':
      return stickGlyph('R', null);
    case 'PadLSUp':
      return stickGlyph('L', 'up');
    case 'PadLSDown':
      return stickGlyph('L', 'down');
    case 'PadRSUp':
      return stickGlyph('R', 'up');
    case 'PadRSDown':
      return stickGlyph('R', 'down');
  }
  const b = padButtonOf(code);
  if (b < 0) return '';
  if (b <= B.North) return faceGlyph(b, f);
  if (b === B.L1 || b === B.R1) return shoulderGlyph(SHOULDERS[f][b - B.L1]!, false);
  if (b === B.L2 || b === B.R2) return shoulderGlyph(SHOULDERS[f][b - B.L1]!, true);
  if (b === B.L3 || b === B.R3) return stickGlyph(b === B.L3 ? 'L' : 'R', null, SHOULDERS[f][b - B.L3 + 4]!);
  if (b >= B.Up && b <= B.Right) return dpadGlyph(b - B.Up);
  if (b === B.Select) return centreGlyph(f === 'xbox' ? 'view' : f === 'nintendo' ? 'minus' : 'share');
  if (b === B.Start) return centreGlyph(f === 'nintendo' ? 'plus' : 'menu');
  if (b === B.Extra) return centreGlyph(f === 'playstation' ? 'pad' : 'share');
  return centreGlyph('home');
}
