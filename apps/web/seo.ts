/**
 * The site's crawl and install files (docs/seo.md), made from the brand at build time so the game's
 * name stays in packages/shared/src/brand.ts only: /manifest.webmanifest, /robots.txt and /sitemap.xml.
 * `%ORIGIN%` (absolute URLs: the sitemap and robots need them) is filled in where the site is served,
 * like index.html's: the playtest proxy per request, scripts/net-trial/cloud-init.sh on deploy.
 */
import type { Plugin } from 'vite';

export interface SeoFiles {
  'manifest.webmanifest': string;
  'robots.txt': string;
  'sitemap.xml': string;
}

/** The three files' text for a game called `name`, built on `date` (YYYY-MM-DD). */
export function seoFiles(name: string, date: string): SeoFiles {
  const manifest = {
    id: '/',
    name,
    short_name: name,
    description: `${name}: a free 2.5D multiplayer jetpack shooter you play in your browser.`,
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
    `  <url><loc>%ORIGIN%/</loc><lastmod>${date}</lastmod></url>`,
    `  <url><loc>%ORIGIN%/armory.html</loc><lastmod>${date}</lastmod></url>`,
    `  <url><loc>%ORIGIN%/gamepad.html</loc><lastmod>${date}</lastmod></url>`,
    '</urlset>',
    '',
  ].join('\n');
  return { 'manifest.webmanifest': `${JSON.stringify(manifest, null, 2)}\n`, 'robots.txt': robots, 'sitemap.xml': sitemap };
}

const TYPES: Record<keyof SeoFiles, string> = {
  'manifest.webmanifest': 'application/manifest+json; charset=utf-8',
  'robots.txt': 'text/plain; charset=utf-8',
  'sitemap.xml': 'application/xml; charset=utf-8',
};

/** Emits the files into the build, and serves them in dev (with the origin left relative). */
export function seo(name: string): Plugin {
  const files = () => seoFiles(name, new Date().toISOString().slice(0, 10));
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
