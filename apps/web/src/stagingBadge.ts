/**
 * Staging builds wear a small "Staging" tag at the top of the screen, so nobody takes the staging
 * site for the real game (docs/release.md). The box's setup builds staging with VITE_ENV=staging
 * (scripts/net-trial/cloud-init.sh, MF_ENV=staging); production builds leave it unset and show nothing.
 */
export function showStagingBadge(env: unknown = import.meta.env.VITE_ENV, doc: Pick<Document, 'createElement' | 'body'> | undefined = globalThis.document): boolean {
  if (env !== 'staging' || !doc?.body) return false;
  const tag = doc.createElement('div');
  tag.textContent = 'Staging';
  tag.title = 'The staging site: test builds, test data. The real game is at the main address.';
  tag.dataset.staging = '';
  // above everything, never in the way of a touch or a click
  tag.style.cssText =
    'position:fixed;top:2px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;padding:1px 8px;border-radius:3px;background:#ffb020;color:#111;font:700 10px/1.5 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;opacity:.85';
  doc.body.append(tag);
  return true;
}
