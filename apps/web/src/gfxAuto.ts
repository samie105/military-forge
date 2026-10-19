/**
 * Settings → Graphics → Quality: Auto, the default. The owner found the old default (Low: no
 * antialiasing, the picture at 1 pixel per CSS pixel) blurry on a Retina Mac, and then phones "not
 * that clear" (19 Oct: "use the absolutely highest version it can"). So the preset follows the
 * device, and starts as high as the device should hold:
 * - a desktop with a real GPU gets High, a weaker integrated one Medium, software WebGL Low;
 * - a phone or tablet by its GPU: Apple's, recent Adreno (640+, 730+), Mali G77+/Immortalis and
 *   Samsung's Xclipse High; the upper-mid ones Medium; older ones Low. Little memory or few cores
 *   cap it (deviceMemory, hardwareConcurrency, where the browser tells).
 * Renderer3D then adapts from the measured frames (TierGovernor): down when the frame budget can't
 * be held even at the lowest render scale, back up when there's room. Picking a preset in
 * Settings overrides all of it.
 */
import type { PresetName } from './render3d';

/** WebGL running on the CPU (the 3D view refuses it for players anyway: they get 2D). */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;
/** Integrated graphics that run High slowly: any Intel but Arc, AMD's APU graphics, phone GPUs. */
const MODEST = /intel(?!.*\barc\b)|radeon(\(tm\))? graphics|radeon vega|\bvega \d|mali|adreno|powervr|videocore/i;

export interface DeviceInfo {
  /** a phone or tablet (touch/isTouchDevice) */
  touch: boolean;
  /** the WebGL renderer's name (gpuRenderer) */
  gpu: string | null;
  /** navigator.deviceMemory, GB (Chrome on Android; absent on Safari) */
  memory?: number;
  /** navigator.hardwareConcurrency */
  cores?: number;
}

const RANK: Record<PresetName, number> = { low: 0, medium: 1, high: 2 };
const lower = (a: PresetName, b: PresetName): PresetName => (RANK[a] <= RANK[b] ? a : b);

/** A phone's or tablet's GPU, by name: what it should hold at a phone's resolution. */
export function mobileGpuTier(gpu: string | null): PresetName {
  const g = (gpu ?? '').toLowerCase();
  if (!g || /^(webkit webgl|mozilla|generic renderer)$/.test(g.trim())) return 'medium';
  // iPhones and iPads (A12 and up run WebGL 2 well; older ones step down on their frames)
  if (/apple/.test(g)) return 'high';
  if (/xclipse|immortalis/.test(g)) return 'high';
  const adreno = /adreno[^0-9]*(\d{3})/.exec(g);
  if (adreno) {
    const n = Number(adreno[1]);
    // 640–699: Snapdragon 855–888; 730+: 8 Gen 1 and later; 700–729 and 615–639: upper-mid
    if (n >= 730 || (n >= 640 && n < 700)) return 'high';
    if (n >= 615) return 'medium';
    return 'low';
  }
  const mali = /mali-?g(\d{2,3})/.exec(g);
  if (mali) {
    const n = Number(mali[1]);
    // G77/G78 and the G710 family: flagships; G57, G68, G76, G610/G615: upper-mid
    if (n === 77 || n === 78 || n >= 710) return 'high';
    if (n === 57 || n === 68 || n === 76 || (n >= 610 && n < 710)) return 'medium';
    return 'low';
  }
  if (/powervr|mali|videocore/.test(g)) return 'low';
  return 'medium';
}

/** The preset Auto starts on. */
export function autoPreset(device: DeviceInfo): PresetName {
  const gpu = device.gpu ?? '';
  if (SOFTWARE.test(gpu)) return 'low';
  if (device.touch) {
    let tier = mobileGpuTier(device.gpu);
    if (device.memory !== undefined && device.memory <= 2) tier = 'low';
    else if (device.memory !== undefined && device.memory <= 4) tier = lower(tier, 'medium');
    if (device.cores !== undefined && device.cores > 0 && device.cores <= 4) tier = lower(tier, 'medium');
    return tier;
  }
  // the browser hides the GPU (privacy settings): the middle way
  if (!gpu || /^(webkit webgl|mozilla|generic renderer)$/i.test(gpu.trim())) return 'medium';
  if (MODEST.test(gpu)) return 'medium';
  return 'high';
}

/** What the browser tells about this device's memory and cores. */
export function deviceHints(nav: Navigator = navigator): Pick<DeviceInfo, 'memory' | 'cores'> {
  const memory = (nav as Navigator & { deviceMemory?: number }).deviceMemory;
  return { memory: typeof memory === 'number' ? memory : undefined, cores: nav.hardwareConcurrency || undefined };
}

/** The GPU's name from a throwaway WebGL context (null when WebGL won't start). */
export function gpuRenderer(doc: Document = document): string | null {
  try {
    const canvas = doc.createElement('canvas');
    const gl = (canvas.getContext('webgl2') ?? canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) return null;
    let name: unknown = gl.getParameter(gl.RENDERER);
    // Chrome and Safari answer RENDERER with a placeholder; the debug extension has the real name
    // (Firefox answers RENDERER itself, and warns when the extension is asked for)
    if (typeof name !== 'string' || /^webkit webgl$/i.test(name)) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (info) name = gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    }
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return typeof name === 'string' ? name : null;
  } catch {
    return null;
  }
}
