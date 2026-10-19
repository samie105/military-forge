/**
 * Phones always play in landscape (ui/landscape.ts): an upright phone's page is turned 90° clockwise,
 * so the screen's numbers (clientX/Y, getBoundingClientRect, innerWidth/Height) are mapped into the
 * page's own before the touch controls, the editor, sliders and the HUD use them.
 */
import { Btn } from '@military-forge/sim';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOVE_STICK, moveButtons, shapeStick } from '../src/touch/stick';
import { LANDSCAPE_PHONE_QUERY, UPRIGHT_PHONE_QUERY, applyLandscape, enterLandscape, isPhoneShape, isRotated, rectToLogical, toLogical, toScreen, vecToLogical, viewport } from '../src/ui/landscape';

/** An iPhone-sized portrait screen: 375 wide, 812 high; the page lays out in 812×375. */
const W = 375;
const H = 812;

afterEach(() => vi.unstubAllGlobals());

const media = (portrait: boolean, width = W, coarse = true) =>
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: q === UPRIGHT_PHONE_QUERY ? portrait && width <= 500 && coarse : q === LANDSCAPE_PHONE_QUERY ? !portrait && coarse : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

describe('the turn: a page point and its place on the screen', () => {
  it('the page (812×375) fills the portrait screen (375×812): its corners land on the screen\'s', () => {
    expect(toScreen(0, 0, true, W)).toEqual({ x: W, y: 0 }); // the page's top left: the screen's top right
    expect(toScreen(H, 0, true, W)).toEqual({ x: W, y: H }); // its top right: the screen's bottom right
    expect(toScreen(0, W, true, W)).toEqual({ x: 0, y: 0 }); // its bottom left: the screen's top left
    expect(toScreen(H, W, true, W)).toEqual({ x: 0, y: H });
  });

  it('screen → page undoes page → screen, everywhere', () => {
    for (const [x, y] of [
      [0, 0],
      [128, 266],
      [684, 266],
      [406, 187.5],
      [811, 374],
    ] as const) {
      const s = toScreen(x, y, true, W);
      expect(toLogical(s.x, s.y, true, W)).toEqual({ x, y });
    }
  });

  it('untouched when the page isn\'t turned (landscape, tablets, desktops)', () => {
    expect(toLogical(100, 50, false, 812)).toEqual({ x: 100, y: 50 });
    expect(vecToLogical(3, -4, false)).toEqual({ x: 3, y: -4 });
    expect(rectToLogical({ left: 10, top: 20, width: 30, height: 40 }, false, 812)).toEqual({ left: 10, top: 20, right: 40, bottom: 60, width: 30, height: 40 });
  });

  it('a box on the screen is the page\'s box turned: corners map to corners, width and height swap', () => {
    // the move dial's 136 px base at the page's (128, 266): on the screen it's centred at (375 − 266, 128)
    const page = { left: 60, top: 198, width: 136, height: 136 };
    const c = toScreen(page.left + 68, page.top + 68, true, W);
    expect(c).toEqual({ x: W - 266, y: 128 });
    const screenBox = { left: c.x - 68, top: c.y - 68, width: 136, height: 136 };
    expect(rectToLogical(screenBox, true, W)).toEqual({ left: 60, top: 198, right: 196, bottom: 334, width: 136, height: 136 });
    // a wide pill (the swap pill, 180×48 in the page) stands tall on the screen
    const pill = { left: 560, top: 15, width: 180, height: 48 };
    const a = toScreen(pill.left, pill.top, true, W);
    const b = toScreen(pill.left + pill.width, pill.top + pill.height, true, W);
    const onScreen = { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
    expect(onScreen.width).toBe(48);
    expect(onScreen.height).toBe(180);
    expect(rectToLogical(onScreen, true, W)).toEqual({ left: 560, top: 15, right: 740, bottom: 63, width: 180, height: 48 });
  });
});

describe('the dials on a turned phone', () => {
  /** A thumb moving `dx`, `dy` on the page, as the screen reports it, back through the mapping. */
  const thumb = (dx: number, dy: number) => {
    const from = toScreen(128, 266, true, W);
    const to = toScreen(128 + dx, 266 + dy, true, W);
    return vecToLogical(to.x - from.x, to.y - from.y, true);
  };

  it('a push towards the page\'s right moves right (down the portrait screen)', () => {
    const v = thumb(60, 0);
    expect(v).toEqual({ x: 60, y: 0 });
    // the screen saw the finger go down the glass, not sideways
    const from = toScreen(128, 266, true, W);
    const to = toScreen(188, 266, true, W);
    expect([to.x - from.x, to.y - from.y]).toEqual([0, 60]);
    expect(moveButtons(shapeStick(v.x, v.y, 68, MOVE_STICK))).toBe(Btn.Right);
  });

  it('up the page (towards the screen\'s right edge) jets; down crouches; left walks left', () => {
    const up = thumb(0, -60);
    expect(up).toEqual({ x: 0, y: -60 });
    expect(moveButtons(shapeStick(up.x, up.y, 68, MOVE_STICK)) & Btn.Jet).toBeTruthy();
    const down = thumb(0, 60);
    expect(moveButtons(shapeStick(down.x, down.y, 68, MOVE_STICK)) & Btn.Down).toBeTruthy();
    const left = thumb(-60, 0);
    expect(moveButtons(shapeStick(left.x, left.y, 68, MOVE_STICK))).toBe(Btn.Left);
  });

  it('the editor: dragging a control 40 px left and 16 px down on the page moves its place by that much', () => {
    const box = rectToLogical({ left: 0, top: 0, width: W, height: H }, true, W); // the safe box, here the whole page
    expect([box.width, box.height]).toEqual([H, W]);
    const grab = toScreen(600, 140, true, W);
    const drop = toScreen(560, 156, true, W);
    const a = toLogical(grab.x, grab.y, true, W);
    const b = toLogical(drop.x, drop.y, true, W);
    expect({ x: b.x - a.x, y: b.y - a.y }).toEqual({ x: -40, y: 16 });
  });
});

describe('when the page turns', () => {
  it('only an upright phone turns; held sideways it lays out as is; tablets and desktops never', () => {
    media(true);
    expect(isRotated()).toBe(true);
    expect(isPhoneShape()).toBe(true);
    media(false);
    expect(isRotated()).toBe(false);
    expect(isPhoneShape()).toBe(true);
    media(true, 768); // an upright tablet
    expect(isRotated()).toBe(false);
    expect(isPhoneShape()).toBe(false);
    media(false, 1280, false); // a desktop
    expect(isPhoneShape()).toBe(false);
  });

  it('the window\'s size is the turned box\'s', () => {
    expect(viewport(true, W, H)).toEqual({ w: H, h: W });
    expect(viewport(false, 812, 375)).toEqual({ w: 812, h: 375 });
  });

  it('<html> gets mf-rotated and mf-phone, and the box its landscape size', () => {
    media(true);
    vi.stubGlobal('innerWidth', W);
    vi.stubGlobal('innerHeight', H);
    const classes = new Set<string>();
    const vars = new Map<string, string>();
    const root = {
      classList: { toggle: (c: string, on: boolean) => (on ? classes.add(c) : classes.delete(c)) },
      style: { setProperty: (k: string, v: string) => vars.set(k, v) },
    } as unknown as HTMLElement;
    applyLandscape(root);
    expect([...classes].sort()).toEqual(['mf-phone', 'mf-rotated']);
    expect(vars.get('--app-w')).toBe('812px');
    expect(vars.get('--app-h')).toBe('375px');
    media(false);
    applyLandscape(root);
    expect([...classes]).toEqual(['mf-phone']);
  });
});

describe('the first tap: full screen, then the landscape lock', () => {
  const doc = (requestFullscreen?: () => Promise<void>) => ({ fullscreenElement: null, documentElement: { requestFullscreen } }) as unknown as Document;

  it('asks for full screen first, then locks to landscape', async () => {
    const order: string[] = [];
    const lock = vi.fn(async (o: string) => void order.push(`lock ${o}`));
    vi.stubGlobal('screen', { orientation: { lock } });
    await enterLandscape(doc(async () => void order.push('fullscreen')));
    expect(order).toEqual(['fullscreen', 'lock landscape']);
  });

  it('every refusal is caught: no full screen (iPhone), a refused lock, no lock at all', async () => {
    const lock = vi.fn(() => Promise.reject(new Error('NotSupportedError')));
    vi.stubGlobal('screen', { orientation: { lock } });
    await expect(enterLandscape(doc(() => Promise.reject(new Error('denied'))))).resolves.toBeUndefined();
    expect(lock).toHaveBeenCalledWith('landscape'); // the lock is still tried
    await expect(enterLandscape(doc(undefined))).resolves.toBeUndefined();
    vi.stubGlobal('screen', { orientation: {} });
    await expect(enterLandscape(doc(undefined))).resolves.toBeUndefined();
    vi.stubGlobal('screen', {});
    await expect(enterLandscape(doc(async () => {}))).resolves.toBeUndefined();
  });
});
