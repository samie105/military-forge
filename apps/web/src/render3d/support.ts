/**
 * Whether play draws in 3D, decided before the 3D view's code arrives: no three import here. main.ts
 * reads it at boot and fetches the 3D view (three.js and render3d, a chunk of their own) later, so the
 * landing and the title don't wait on it (audit 28 Oct). index.ts re-exports these for existing callers.
 */

/** Whether WebGL 2 starts here; a software rasteriser only when `allowSoftware` (Renderer3D.supported). */
export function supports3d(allowSoftware = false): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: !allowSoftware });
  } catch {
    return false;
  }
}

/**
 * Software WebGL is accepted for automated browsers (headless tests and screenshot scripts, which
 * run on SwiftShader) and with `?softgl`; a player on a software rasteriser gets the 2D view.
 */
export function softwareGl(params: URLSearchParams): boolean {
  return params.has('softgl') || (typeof navigator !== 'undefined' && navigator.webdriver === true);
}

/**
 * Whether play renders in 3D, online included (the owner's default, 18 Oct): yes, unless
 * `?render=2d`, or WebGL 2 can't start on a real GPU (softwareGl).
 */
export function online3d(params: URLSearchParams): boolean {
  return params.get('render') !== '2d' && supports3d(softwareGl(params));
}
