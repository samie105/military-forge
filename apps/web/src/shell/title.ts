/**
 * The title screen's rules (Title.tsx; the owner, 23 Oct: "when it's opened, it has an opened screen
 * with a tap anywhere to continue"): when it shows, which keys continue, and the corner's server
 * label. Pure, so tests drive it.
 */

/**
 * The title opens the app, but not for an invite link (/r/CODE, a local-room join: straight to the
 * room), the debug client, `?notitle`, or a browser driven by automation (navigator.webdriver: the
 * end-to-end scripts expect the name screen first) unless it asks for the title with `?title`.
 */
export function titleWanted(o: { appMode: boolean; path: string; params: URLSearchParams; webdriver: boolean }): boolean {
  if (!o.appMode || o.params.has('notitle')) return false;
  if (/^\/r\/[A-Za-z]{6}\/?$/.test(o.path) || o.params.has('lan')) return false;
  return !o.webdriver || o.params.has('title');
}

/** Keys that continue: anything but a lone modifier, and never a browser shortcut (Ctrl/⌘ + a key). */
export function continuesTitle(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat'>): boolean {
  if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return false;
  return !['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn', 'OS', 'Tab'].includes(e.key);
}

/** The net trial's /probe-config.json on the box (scripts/net-trial/cloud-init.sh): its region's name. */
interface ProbeConfig {
  regions?: { name?: string }[];
}

/** Where the server is, for the corner: the box's region, "This computer" in dev, else the host. */
export function regionLabel(hostname: string, probe: ProbeConfig | null): string {
  const named = probe?.regions?.[0]?.name;
  if (named) return named;
  if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(hostname) || hostname.endsWith('.local')) return 'This computer';
  return hostname;
}

/** How long the push into the next screen takes (reduce motion: a short cross-fade). */
export const TITLE_LEAVE_MS = 760;
export const TITLE_LEAVE_REDUCED_MS = 220;
