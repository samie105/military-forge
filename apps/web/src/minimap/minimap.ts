/**
 * The minimap (maps-vertical; the owner, 23 Oct: "what of mini maps so people don't get lost").
 * A compact side view of the whole level in a HUD corner: every tier, you and the way you aim,
 * what's on your screen, pickups, the updrafts and slabs between tiers, allies in team modes, and
 * enemies only as the player has legitimately seen or heard them (intel.ts: no wallhacks).
 *
 * - **Tiers:** a rail down its left edge, a tick per tier and yours lit, and the tier's name in the
 *   header ("ROOFTOPS 2/4"). A map without tiers shows its name.
 * - **The big map:** M on a keyboard (Settings → Controls), a tap on the minimap on a phone, a
 *   double-tap of View / Share on a pad. It pans (drag) and zooms (wheel, pinch, + and −), with a key.
 * - **Phones:** it sits in the top-left of the safe box and moves (or shrinks) clear of any touch
 *   control there, a player's own placements and the left FIRE included; idle, it dims like the
 *   controls' Auto-fade, and lights up when something changes. Reduce motion stops its pulses;
 *   the colour-blind modes recolour enemies and allies (shapes carry the meaning too).
 * - **Cheap:** the level is drawn once per map and size into one canvas; each frame (at most 30 a
 *   second) clears a second canvas and draws the dots.
 */
import { mapTiers, tierIndexAt, type MapDef } from '@military-forge/content';
import type { SimEvent } from '@military-forge/sim';
import type { Frame } from '../view';
import { DEFAULT_PALETTE, drawDots, drawSilhouette, fitMap, paletteFor, toBoxY, toWorldX, toWorldY, type Fit, type Palette } from './draw';
import { EnemyIntel, type IntelMark, type ViewBox } from './intel';
import { BIG_PHONE, HEAD, PHONE, bigPhonePlace, isTapAway, phonePlace, widthFor, type TouchMark } from './place';
import './minimap.css';

/** desktop: the kit's 1920 × 1080 design px; phone: 812 × 375 */
const DESK = { w: 1920, h: 1080, width: 300, minH: 96, maxH: 168, x: 32, y: 28 } as const;
/** the big map, design px: centred; on a phone, between the thumb dials */
const BIG_DESK = { w: 1180, h: 660 } as const;
/** the phone feed moves only when the minimap is at the top; its new left clears the scoreboard button (design px) */
const FEED_CLEAR_Y = 60;
const FEED_MIN_LEFT = 100;
/** frames drawn per second at most */
const MAX_FPS = 30;
/** a phone's minimap dims after this long with nothing new (ms), as the controls' Auto-fade */
const IDLE_MS = 2500;
/** how often a phone re-checks the controls' places (ms) */
const PLACE_MS = 600;
/** the big map's zoom range */
const BIG_ZOOM = { min: 1, max: 6 } as const;

export type ColorBlindMode = 'standard' | 'deutan' | 'tritan';

interface Layer {
  root: HTMLElement;
  head: HTMLElement;
  title: HTMLElement;
  count: HTMLElement;
  body: HTMLElement;
  sil: HTMLCanvasElement;
  dots: HTMLCanvasElement;
  /** CSS px of the canvas box */
  w: number;
  h: number;
  fit: Fit | null;
  /** what the silhouette was drawn for */
  drawnKey: string;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  parent?.appendChild(e);
  return e;
}

function layer(cls: string, parent: HTMLElement): Layer {
  const root = el('div', `mf mf-mm ${cls}`, parent);
  const head = el('div', 'mf-mm__head', root);
  const title = el('b', 'mf-mm__tier', head);
  const count = el('span', 'mf-mm__n', head);
  const body = el('div', 'mf-mm__body', root);
  const sil = el('canvas', 'mf-mm__cv', body);
  const dots = el('canvas', 'mf-mm__cv', body);
  return { root, head, title, count, body, sil, dots, w: 0, h: 0, fit: null, drawnKey: '' };
}

export class Minimap {
  private readonly small: Layer;
  private readonly big: Layer;
  private readonly bigShade: HTMLElement;
  private readonly key: HTMLElement;
  private map: MapDef | null = null;
  private readonly intel = new EnemyIntel();
  private marks: IntelMark[] = [];
  private pal: Palette = DEFAULT_PALETTE;
  private visible = false;
  private bigOpen = false;
  private phone = false;
  private lastDraw = -Infinity;
  private lastPlace = -Infinity;
  private place = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private bigPlace: { x: number; y: number; w: number; h: number } = { ...BIG_PHONE };
  /** the big map's zoom and the world point at its centre */
  private zoom = 1;
  private centre: { x: number; y: number } | null = null;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; zoom: number } | null = null;
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  /** for the phone's idle dim: when something last changed, and what */
  private litAt = 0;
  private lastTier = -2;
  private lastMarkCount = 0;
  private reducedMotion = false;
  private frame: Frame | null = null;
  private view: ViewBox | null = null;
  private allies: { x: number; y: number }[] = [];
  /** the key that opens the big map, shown in the header ('' on touch) */
  private keyCap = 'M';

  constructor(parent: HTMLElement = document.body) {
    this.small = layer('mf-mm--small', parent);
    this.small.root.setAttribute('role', 'button');
    this.small.root.setAttribute('aria-label', 'Map: open the big map');
    this.small.root.tabIndex = -1;
    this.key = el('kbd', 'mf-mm__key', this.small.head);
    this.key.textContent = this.keyCap;
    this.bigShade = el('div', 'mf-mmbig-shade', parent);
    this.big = layer('mf-mm--big', parent);
    this.big.root.setAttribute('role', 'dialog');
    this.big.root.setAttribute('aria-label', 'Map');
    const tools = el('div', 'mf-mm__tools', this.big.head);
    for (const [label, act] of [
      ['−', () => this.zoomBy(1 / 1.5)],
      ['+', () => this.zoomBy(1.5)],
      ['Fit', () => this.resetView()],
      ['Close', () => this.setBig(false)],
    ] as const) {
      const b = el('button', 'mf-mm__btn', tools);
      b.type = 'button';
      b.textContent = label;
      // pointerup, not click: a phone sends no click for a tap made while a thumb rests on a dial
      b.addEventListener('pointerup', (e) => {
        e.stopPropagation();
        act();
      });
    }
    const legend = el('div', 'mf-mm__legend', this.big.root);
    legend.innerHTML = [
      ['you', 'You'],
      ['seen', 'Enemy in sight'],
      ['last', 'Last seen'],
      ['heard', 'Heard'],
      ['ally', 'Ally'],
      ['power', 'Power weapon'],
      ['gun', 'Gun'],
      ['item', 'Item'],
      ['slab', 'Platform: fly up, drop through'],
      ['updraft', 'Updraft'],
      ['thin', 'Thin air: jetpacks cut out'],
    ]
      .map(([k, t]) => `<span class="mf-mm__lg mf-mm__lg--${k}"><i aria-hidden="true"></i>${t}</span>`)
      .join('');
    this.small.root.addEventListener('pointerup', (e) => {
      if (!this.visible) return;
      e.stopPropagation();
      this.setBig(!this.bigOpen);
    });
    this.small.root.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.bigShade.addEventListener('pointerup', () => this.setBig(false));
    const body = this.big.body;
    body.addEventListener('pointerdown', this.onBigDown);
    body.addEventListener('pointermove', this.onBigMove);
    body.addEventListener('pointerup', this.onBigUp);
    body.addEventListener('pointercancel', this.onBigUp);
    body.addEventListener('wheel', this.onWheel, { passive: false });
    body.addEventListener('dblclick', () => this.resetView());
    // a tap anywhere else closes the big map; on a phone the shade lets touches through to the dials,
    // so this listens on the window, before the touch controls see the press
    window.addEventListener('pointerdown', this.onAwayDown, true);
    window.addEventListener('pointerup', this.onAwayUp, true);
    window.addEventListener('pointercancel', this.onAwayCancel, true);
    this.applyVisibility();
  }

  // ---------- settings ----------

  setMap(map: MapDef): void {
    if (map === this.map) return;
    this.map = map;
    this.intel.clear();
    this.resetView();
    this.small.drawnKey = this.big.drawnKey = '';
    this.lastTier = -2;
    this.lastPlace = -Infinity;
  }

  setColorBlind(mode: ColorBlindMode): void {
    this.pal = paletteFor(mode);
    for (const m of ['deutan', 'tritan'] as const) document.documentElement.classList.toggle(`mf-cb-${m}`, m === mode);
    this.small.drawnKey = this.big.drawnKey = '';
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
  }

  /** The keycap in the header (the 'map' binding); null hides it (touch). */
  setKey(cap: string | null): void {
    this.keyCap = cap ?? '';
    this.key.textContent = this.keyCap;
    this.key.hidden = !cap;
  }

  /** Who isn't an enemy (team modes: teammates; the party). Their dots always show. */
  setAllies(ids: ReadonlySet<number>): void {
    this.intel.allies = ids;
  }

  setVisible(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    if (!on) this.bigOpen = false;
    if (!on) this.moveFeed(null);
    else this.lastPlace = -Infinity;
    this.applyVisibility();
  }

  get isBigOpen(): boolean {
    return this.bigOpen;
  }

  setBig(open: boolean): void {
    if (open === this.bigOpen || (open && !this.visible)) return;
    this.bigOpen = open;
    if (open) this.resetView();
    this.applyVisibility();
    this.lastDraw = -Infinity;
  }

  toggleBig(): void {
    this.setBig(!this.bigOpen);
  }

  // ---------- what happens ----------

  /** Sim events: shots fired off screen are heard (coarsely), never seen. */
  onEvents(events: readonly SimEvent[], localId: number, now = performance.now()): void {
    for (const e of events) {
      if (e.type === 'shot') this.intel.shot(e.shooter, localId, e.ox, e.oy, now);
      // a blast off screen is heard where it went off (online, an off-screen one arrives as a SOUND instead)
      else if (e.type === 'explosion' && e.owner !== localId) this.intel.shot(e.owner, localId, e.x, e.y, now);
    }
  }

  /** Online: gunfire and blasts off screen (SOUND events, on their 4 m grid). */
  onSounds(sounds: readonly { x: number; y: number }[], now = performance.now()): void {
    for (const s of sounds) this.intel.hear(s.x, s.y, now);
  }

  /**
   * Every frame: the frame and what's on screen (world rect). Updates what the player knows, and
   * draws at most MAX_FPS times a second.
   */
  update(f: Frame, view: ViewBox, now = performance.now()): void {
    this.frame = f;
    this.view = view;
    this.intel.update(f.players, f.localId, view, now);
    if (!this.visible || !this.map) return;
    if (now - this.lastDraw < 1000 / MAX_FPS - 1) return;
    this.lastDraw = now;
    this.phone = document.documentElement.hasAttribute('data-touch-controls');
    this.key.hidden = this.phone || !this.keyCap; // a phone opens it with a tap
    this.layout(now);
    this.marks = this.intel.marks(now, this.marks);
    this.allies = [];
    for (const p of f.players) if (p.alive && p.id !== f.localId && this.intel.allies.has(p.id)) this.allies.push({ x: p.x, y: p.y });
    const me = f.players.find((p) => p.id === f.localId) ?? null;
    // the header: your tier
    const tiers = mapTiers(this.map);
    const tier = me && tiers ? tierIndexAt(this.map, me.y) : -1;
    for (const L of [this.small, this.big]) {
      L.title.textContent = tiers && tier >= 0 ? tiers[tier]!.name : this.map.name;
      L.count.textContent = tiers && tier >= 0 ? `${tier + 1}/${tiers.length}` : '';
    }
    // phones: lit on a change (a new tier, a new mark), dim when idle
    const seenOrHeard = this.marks.filter((m) => m.kind !== 'last').length;
    if (tier !== this.lastTier || seenOrHeard > this.lastMarkCount) this.litAt = now;
    this.lastTier = tier;
    this.lastMarkCount = seenOrHeard;
    this.small.root.classList.toggle('mf-mm--idle', this.phone && !this.bigOpen && now - this.litAt > IDLE_MS);
    this.draw(this.small, me, tier, now, 1);
    if (this.bigOpen) this.draw(this.big, me, tier, now, this.phone ? 1.2 : 1.6);
  }

  dispose(): void {
    window.removeEventListener('pointerdown', this.onAwayDown, true);
    window.removeEventListener('pointerup', this.onAwayUp, true);
    window.removeEventListener('pointercancel', this.onAwayCancel, true);
    this.small.root.remove();
    this.big.root.remove();
    this.bigShade.remove();
  }

  // ---------- layout and drawing ----------

  private applyVisibility(): void {
    this.small.root.hidden = !this.visible;
    this.big.root.hidden = !this.visible || !this.bigOpen;
    this.bigShade.hidden = this.big.root.hidden;
    this.small.root.classList.toggle('mf-mm--open', this.bigOpen);
  }

  /** Sizes and places both views for the window (and, on a phone, the controls). */
  private layout(now: number): void {
    const map = this.map!;
    const b = map.bounds;
    const aspect = (b.maxX - b.minX) / (b.maxY - b.minY);
    const W = window.innerWidth;
    const H = window.innerHeight;
    let x: number;
    let y: number;
    let w: number;
    let h: number;
    let scale: number;
    if (this.phone) {
      scale = Math.min(W / PHONE.w, H / PHONE.h);
      if (now - this.lastPlace > PLACE_MS) {
        this.lastPlace = now;
        const controls: { left: number; top: number; right: number; bottom: number }[] = [];
        for (const c of document.querySelectorAll<HTMLElement>('.mf-touch .mf-ctl:not(.mf-off)')) {
          const r = c.getBoundingClientRect();
          if (r.width > 0) controls.push({ left: r.left / scale, top: r.top / scale, right: r.right / scale, bottom: r.bottom / scale });
        }
        const p = phonePlace(controls, aspect);
        this.place = { ...p, scale };
        this.bigPlace = bigPhonePlace(controls);
        this.moveFeed(p);
      }
      ({ x, y, w, h } = this.place);
    } else {
      scale = Math.min(W / DESK.w, H / DESK.h);
      h = Math.round(Math.max(DESK.minH, Math.min(DESK.maxH, DESK.width / aspect + HEAD.desk)));
      w = widthFor(h, HEAD.desk, aspect, 200, DESK.width);
      x = DESK.x;
      y = DESK.y;
    }
    const head = this.phone ? HEAD.phone : HEAD.desk;
    this.size(this.small, x * scale, y * scale, w * scale, h * scale, head * scale);
    if (this.bigOpen) {
      const big = this.phone ? this.bigPlace : BIG_DESK;
      const bw = big.w * scale;
      const bh = big.h * scale;
      const bx = this.phone ? this.bigPlace.x * scale : (W - bw) / 2;
      const by = this.phone ? this.bigPlace.y * scale : (H - bh) / 2;
      this.size(this.big, bx, by, bw, bh, (this.phone ? 22 : 36) * scale, this.phone ? 18 * scale : 30 * scale);
    }
  }

  private size(L: Layer, x: number, y: number, w: number, h: number, head: number, foot = 0): void {
    const s = L.root.style;
    s.left = `${Math.round(x)}px`;
    s.top = `${Math.round(y)}px`;
    s.width = `${Math.round(w)}px`;
    s.height = `${Math.round(h)}px`;
    s.setProperty('--mm-head', `${Math.round(head)}px`);
    s.setProperty('--mm-foot', `${Math.round(foot)}px`);
    const cw = Math.max(1, Math.round(w) - 2);
    const ch = Math.max(1, Math.round(h) - Math.round(head) - Math.round(foot) - 2);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cw !== L.w || ch !== L.h || L.sil.width !== Math.round(cw * dpr)) {
      L.w = cw;
      L.h = ch;
      for (const c of [L.sil, L.dots]) {
        c.width = Math.round(cw * dpr);
        c.height = Math.round(ch * dpr);
        c.style.width = `${cw}px`;
        c.style.height = `${ch}px`;
      }
      L.drawnKey = '';
    }
  }

  private draw(L: Layer, me: Frame['players'][number] | null, tier: number, now: number, unit: number): void {
    const map = this.map!;
    const isBig = L === this.big;
    const fit = isBig && this.zoom > 1 ? fitMap(map, L.w, L.h, 6, this.zoom, this.centre?.x, this.centre?.y) : fitMap(map, L.w, L.h, isBig ? 6 : 3);
    const dpr = L.sil.width / L.w;
    const key = `${map.id}|${L.w}x${L.h}|${dpr}|${fit.scale.toFixed(4)}|${fit.ox.toFixed(1)}|${fit.oy.toFixed(1)}|${this.pal.enemy}`;
    L.fit = fit;
    if (key !== L.drawnKey) {
      const sc = L.sil.getContext('2d');
      if (!sc) return;
      sc.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawSilhouette(sc, map, fit, L.w, L.h, this.pal);
      L.drawnKey = key;
    }
    const ctx = L.dots.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, L.w, L.h);
    const f = this.frame!;
    const pulse = this.reducedMotion ? 0 : 0.6 * (0.5 + 0.5 * Math.sin(now / 160));
    drawDots(
      ctx,
      fit,
      {
        me: me ? { x: me.x, y: me.y, aim: me.aim, alive: me.alive } : null,
        view: this.view,
        allies: this.allies,
        items: f.pickups ?? [],
        marks: this.marks,
        pulse,
      },
      this.pal,
      unit,
    );
    // the tier rail: a tick per tier down the left edge, yours lit
    const tiers = mapTiers(map);
    if (tiers) {
      const b = map.bounds;
      for (let i = 0; i < tiers.length; i++) {
        const y0 = toBoxY(fit, i + 1 < tiers.length ? tiers[i + 1]!.y : b.maxY);
        const y1 = toBoxY(fit, i === 0 ? b.minY : tiers[i]!.y);
        ctx.fillStyle = i === tier ? this.pal.you : this.pal.line;
        ctx.fillRect(0, Math.max(0, y0) + 1, i === tier ? 3 : 2, Math.max(1, Math.min(L.h, y1) - Math.max(0, y0) - 2));
        if (isBig) {
          const label = tiers[i]!.name.toUpperCase();
          const ly = Math.min(L.h - 2, y1 - 3);
          ctx.font = `700 ${this.phone ? 9 : 13}px system-ui, sans-serif`;
          ctx.textBaseline = 'bottom';
          ctx.lineWidth = 3;
          ctx.strokeStyle = this.pal.ink;
          ctx.strokeText(label, 7, ly);
          ctx.fillStyle = i === tier ? this.pal.you : this.pal.view;
          ctx.fillText(label, 7, ly);
        }
      }
    }
  }

  /**
   * A phone's one-line kill feed sits in the safe box's top-left corner (hud/phone.css .pt-feed),
   * where the minimap goes: while the minimap is there, the feed steps down under it, right of the
   * scoreboard button's column (minimap.css reads these, design px).
   */
  private moveFeed(p: { x: number; y: number; w: number; h: number } | null): void {
    const html = document.documentElement;
    const on = p !== null && this.visible && p.y < FEED_CLEAR_Y;
    html.classList.toggle('mf-mm-feed', on);
    if (!on) return;
    html.style.setProperty('--mm-feed-top', `${p.y + p.h + 6}px`);
    html.style.setProperty('--mm-feed-left', `${Math.max(p.x, FEED_MIN_LEFT)}px`);
  }

  // ---------- the big map's pan and zoom ----------

  private resetView(): void {
    this.zoom = 1;
    this.centre = null;
    this.big.drawnKey = '';
  }

  private zoomBy(k: number, at?: { x: number; y: number }): void {
    const map = this.map;
    const fit = this.big.fit;
    if (!map || !fit) return;
    const next = Math.max(BIG_ZOOM.min, Math.min(BIG_ZOOM.max, this.zoom * k));
    const b = map.bounds;
    const c = this.centre ?? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    if (at) {
      // keep the world point under the pointer where it is
      const wx = toWorldX(fit, at.x);
      const wy = toWorldY(fit, at.y);
      const r = this.zoom / next;
      c.x = wx + (c.x - wx) * r;
      c.y = wy + (c.y - wy) * r;
    }
    this.zoom = next;
    this.centre = next > 1 ? c : null;
    this.lastDraw = -Infinity;
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.big.dots.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** presses that started away from the big map, the minimap and the touch controls, by pointer */
  private readonly away = new Map<number, TouchMark>();

  private readonly onAwayDown = (e: PointerEvent): void => {
    if (!this.bigOpen) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target && (this.big.root.contains(target) || this.small.root.contains(target) || target.closest('[data-mf-control]'))) return;
    this.away.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
  };

  private readonly onAwayUp = (e: PointerEvent): void => {
    const down = this.away.get(e.pointerId);
    this.away.delete(e.pointerId);
    if (down && this.bigOpen && isTapAway(down, { x: e.clientX, y: e.clientY, t: e.timeStamp })) this.setBig(false);
  };

  private readonly onAwayCancel = (e: PointerEvent): void => {
    this.away.delete(e.pointerId);
  };

  private readonly onBigDown = (e: PointerEvent): void => {
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1, zoom: this.zoom };
      this.drag = null;
    } else if (this.pointers.size === 1) {
      const fit = this.big.fit;
      const map = this.map;
      if (!fit || !map) return;
      const b = map.bounds;
      const c = this.centre ?? { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
      const at = this.local(e);
      this.drag = { x: at.x, y: at.y, cx: c.x, cy: c.y, moved: false };
    }
  };

  private readonly onBigMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    e.stopPropagation();
    const at = this.local(e);
    this.pointers.set(e.pointerId, at);
    const fit = this.big.fit;
    if (!fit) return;
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1;
      const mid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      this.zoomBy((this.pinch.zoom * (d / this.pinch.dist)) / this.zoom, mid);
    } else if (this.drag && this.zoom > 1) {
      const dx = at.x - this.drag.x;
      const dy = at.y - this.drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) this.drag.moved = true;
      this.centre = { x: this.drag.cx - dx / fit.scale, y: this.drag.cy + dy / fit.scale };
      this.lastDraw = -Infinity;
    }
  };

  private readonly onBigUp = (e: PointerEvent): void => {
    e.stopPropagation();
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) this.drag = null;
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    this.zoomBy(e.deltaY < 0 ? 1.25 : 1 / 1.25, this.local(e));
  };
}
