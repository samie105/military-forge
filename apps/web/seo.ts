/**
 * The site's crawl and install files (docs/seo.md), made from the brand at build time so the game's
 * name stays in packages/shared/src/brand.ts only: /manifest.webmanifest, /robots.txt, /sitemap.xml
 * and /llms.txt. `%ORIGIN%` (absolute URLs: the sitemap, robots and llms.txt need them) is filled in
 * where the site is served, like the pages': the playtest proxy per request,
 * scripts/net-trial/cloud-init.sh on deploy.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export interface SeoFiles {
  'manifest.webmanifest': string;
  'robots.txt': string;
  'sitemap.xml': string;
  'llms.txt': string;
}

/**
 * The pages worth finding, with the file each is built from. Only pages with words in their HTML:
 * the Armory and the controller check draw everything with script, so a crawler finds nothing there
 * (audit 28 Oct). official.html joins once the owner has filled in its accounts (it's noindex until then).
 */
export const SITEMAP_PAGES: readonly { path: string; file: string }[] = [
  { path: '/', file: 'index.html' },
  { path: '/privacy.html', file: 'privacy.html' },
  { path: '/terms.html', file: 'terms.html' },
];

/** On a phone's home screen the full name is cut short (audit 28 Oct): the short name under the icon. */
export const SHORT_NAME = 'Forge';

/**
 * The four files' text for a game called `name`. `lastmod`: each sitemap page's date (YYYY-MM-DD),
 * when its content last changed; a page without one is listed without a date (better none than a wrong one).
 */
export function seoFiles(name: string, lastmod: Readonly<Record<string, string>>): SeoFiles {
  const manifest = {
    id: '/',
    name,
    short_name: SHORT_NAME,
    description: `${name}: a free multiplayer jetpack shooter you play in your browser.`,
    lang: 'en',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    display_override: ['fullscreen', 'standalone'],
    // a game, not an app store listing: don't offer a native app instead
    prefer_related_applications: false,
    // phones always play sideways (the owner, 19 Oct)
    orientation: 'landscape',
    background_color: '#0e100b',
    theme_color: '#0e100b',
    categories: ['games', 'entertainment'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      { src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
    ],
  };
  // rooms (/r/CODE) stay crawlable so their noindex is seen; the API and sockets aren't pages
  const robots = ['User-agent: *', 'Allow: /', 'Disallow: /api/', 'Disallow: /ws/', '', 'Sitemap: %ORIGIN%/sitemap.xml', ''].join('\n');
  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...SITEMAP_PAGES.map(({ path }) => `  <url><loc>%ORIGIN%${path}</loc>${lastmod[path] ? `<lastmod>${lastmod[path]}</lastmod>` : ''}</url>`),
    '</urlset>',
    '',
  ].join('\n');
  // a short plain summary for AI assistants and answer engines (llmstxt.org), from the landing's About sheet
  const llms = [
    `# ${name}`,
    '',
    `> ${name} is a free multiplayer jetpack shooter you play in a web browser, on a computer or a phone. Nothing to download or install: open the link, pick a name and play.`,
    '',
    '- Fly on a jetpack whose fuel refills on the ground, chain dashes in any direction and drop through platforms.',
    '- Rifles, shotguns, SMGs, snipers and launchers, six kinds of grenade, a machete and a riot shield.',
    '- Rooms of up to eight players: make a room and send the link or its six-letter code; bots fill the empty seats.',
    '- Touch controls for phones (played sideways), keyboard and mouse, or a PlayStation or Xbox controller.',
    '- Local rooms on the same Wi-Fi or a phone hotspot, with no internet.',
    '- Hand-built maps, from a Lagos street market to a lunar outpost, with map events: gravity surges, low gravity, EMP storms, fog and wind gusts.',
    '- For players 18 and over. Free to play; optional cosmetic items that never change a gun\'s stats.',
    '',
    '## Pages',
    '',
    `- [Play ${name}](%ORIGIN%/): the game, with an About section and answers to common questions`,
    '- [Privacy](%ORIGIN%/privacy.html): what the game collects, why, how long it is kept, and how to delete it',
    '- [Terms](%ORIGIN%/terms.html): the rules for playing, the in-game currency (Brass) and refunds',
    '',
  ].join('\n');
  return { 'manifest.webmanifest': `${JSON.stringify(manifest, null, 2)}\n`, 'robots.txt': robots, 'sitemap.xml': sitemap, 'llms.txt': llms };
}

/**
 * Each sitemap page's last change, from git. No dates without the history: a build from an export,
 * or the server's shallow clone (cloud-init.sh: --depth 1), where every file's last commit is simply
 * the newest one and the date would say every page changed on every deploy.
 */
export function pageDates(dir: string = fileURLToPath(new URL('.', import.meta.url))): Record<string, string> {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  const out: Record<string, string> = {};
  try {
    if (git('rev-parse', '--is-shallow-repository') !== 'false') return out;
    for (const { path, file } of SITEMAP_PAGES) {
      const day = git('log', '-1', '--format=%cs', '--', file);
      if (/^\d{4}-\d{2}-\d{2}$/.test(day)) out[path] = day;
    }
  } catch {
    /* no git */
  }
  return out;
}

const TYPES: Record<keyof SeoFiles, string> = {
  'manifest.webmanifest': 'application/manifest+json; charset=utf-8',
  'robots.txt': 'text/plain; charset=utf-8',
  'sitemap.xml': 'application/xml; charset=utf-8',
  'llms.txt': 'text/plain; charset=utf-8',
};

/** Emits the files into the build, and serves them in dev (with the origin left relative). */
export function seo(name: string): Plugin {
  let dates: Record<string, string> | null = null;
  const files = () => seoFiles(name, (dates ??= pageDates()));
  return {
    name: 'seo-files',
    generateBundle() {
      for (const [fileName, source] of Object.entries(files())) this.emitFile({ type: 'asset', fileName, source });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0]!.slice(1) as keyof SeoFiles;
        const text = files()[path];
        if (text === undefined) return next();
        res.setHeader('Content-Type', TYPES[path]);
        res.end(text.replaceAll('%ORIGIN%', `http://${req.headers.host ?? 'localhost'}`));
      });
    },
  };
}
