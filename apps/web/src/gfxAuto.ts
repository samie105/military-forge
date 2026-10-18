/**
 * Settings → Graphics → Quality: Auto, the default. The owner found the old default (Low: no
 * antialiasing, the picture at 1 pixel per CSS pixel) blurry on a Retina Mac, so the preset now
 * follows the device: a desktop with a real GPU gets High, a weaker integrated one Medium, phones and
 * tablets Low (their pixel-ratio cap stays the touch module's), and software WebGL Low. Picking a
 * preset in Settings overrides it.
 */
import type { PresetName } from './render3d';

/** WebGL running on the CPU (the 3D view refuses it for players anyway: they get 2D). */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|basic render/i;
/** Integrated graphics that run High slowly: any Intel but Arc, AMD's APU graphics, phone GPUs. */
const MODEST = /intel(?!.*\barc\b)|radeon(\(tm\))? graphics|radeon vega|\bvega \d|mali|adreno|powervr|videocore/i;

/** The preset Auto picks: `touch` = a phone or tablet (touch/isTouchDevice), `gpu` = the WebGL renderer's name. */
export function autoPreset(device: { touch: boolean; gpu: string | null }): PresetName {
  if (device.touch) return 'low';
  const gpu = device.gpu ?? '';
  if (SOFTWARE.test(gpu)) return 'low';
  // the browser hides the GPU (privacy settings): the middle way
  if (!gpu || /^(webkit webgl|mozilla|generic renderer)$/i.test(gpu.trim())) return 'medium';
  if (MODEST.test(gpu)) return 'medium';
  return 'high';
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
