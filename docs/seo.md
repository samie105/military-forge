# Search (SEO): what makes a site rank, what we did, what's left

The owner's ask (23 Oct 2026): "good SEO support and what makes a website rank properly on searches". The game is a
JavaScript app drawn on a canvas, which a search engine can't read. This page explains how ranking works, what the
site now does about it, and what only the owner can do.

## 1. What makes a page rank

Search engines rank pages, not apps. For each page they ask four things.

1. **Can I fetch it and read it?**
   - The page must be crawlable (not blocked in robots.txt) and indexable (no `noindex`).
   - Its words must be in the HTML: a heading, paragraphs and links. Text inside a canvas or an image is invisible.
   - Google runs JavaScript, but later and not always. HTML that's there before any script runs is read at once,
     by every engine and by link previews (WhatsApp, Discord, X), which never run scripts.
2. **Is it about what was searched?**
   - The `<title>` and the meta description are the search result's headline and snippet.
   - One `<h1>`, headings in order, and plain words people actually type: "jetpack shooter", "browser game",
     "play with friends", "free", "no download".
   - Images with alt text, and a few questions answered in full sentences.
3. **Is it a good page to land on?** Google measures real visitors in Chrome (the Chrome UX Report), mostly on phones,
   because it indexes the mobile page first ("mobile-first indexing"). The Core Web Vitals, at the 75th percentile:
   - **LCP** (Largest Contentful Paint): the main picture or heading has painted. Good: ≤ 2.5 s.
   - **INP** (Interaction to Next Paint): the page answers a tap or a key. Good: ≤ 200 ms.
   - **CLS** (Cumulative Layout Shift): nothing jumps while the page loads. Good: ≤ 0.1.
   - Also: HTTPS, works on a phone, no intrusive pop-ups.
4. **Do other sites vouch for it?**
   - Links from other sites are still the strongest signal: game portals, press, YouTube descriptions, Reddit
     and Discord communities, the itch.io page, the GitHub README.
   - A name people search for helps too, as does a site that stays at one address for years.

Structured data (JSON-LD) doesn't raise rankings by itself. It tells the engine what the page is (a free video game, by
whom, with which screenshots), which can earn a richer result and a knowledge panel.

## 2. What the site does now

### Real HTML at `/`
`apps/web/index.html` is a real landing page, drawn as the title screen's first frame:
- the key art, with alt text, preloaded so it paints first;
- one `<h1>` (the name), the one-line pitch, **Play now** and **About the game**;
- an **About the game** sheet with:
  - a longer pitch;
  - eight features;
  - three screens with alt text, lazy-loaded AVIF/WebP;
  - six questions and answers (`<details>`);
  - the licence links.

The sheet opens without scripts (`:target`), and the title screen has an **About the game** link too (Title.tsx). It's a
real dialog: focus moves in, Tab stays inside, Escape and Close shut it, and focus returns to where it was.

When the app is up, the landing stays in the page under the game (`ui/landing.ts`). Search engines index the rendered
page, so removing it would remove the words. The game makes the landing inert, so it takes no focus and screen readers
skip it, and none of it animates. It uses the title's own classes, so the title takes over with no seam. Room links
(`/r/CODE`) show the loading screen instead.

### Head tags
- **On `/`:**
  - title, description, canonical, `robots` (`max-image-preview:large`), theme colour, `color-scheme`;
  - icons, apple-touch-icon and the web app manifest;
  - Open Graph (`og:url`, image 1200×630 from key art v2, alt text) and Twitter cards.
- **Other pages:**
  - The Armory, Locker and Controller check pages have their own titles and descriptions.
  - Admin, the ping probe, the sound board and the animation lab are `noindex`.

### Structured data
JSON-LD on `/`:
- `VideoGame`: free (`offers.price` 0), genre, platforms, play modes, 1–8 players and screenshots;
- `WebSite`;
- `Organization` with the logo.

### Crawl files (`apps/web/seo.ts`, made at build from the brand)
- `/robots.txt`:
  - allows everything except `/api/` and `/ws/`;
  - names the sitemap.
  - It doesn't block `/r/`: a crawler has to fetch a room page to see its `noindex`.
- `/sitemap.xml`: `/`, `/armory.html` and `/gamepad.html`.
- `/manifest.webmanifest`: installs as a full-screen, landscape app with the emblem icons (any and maskable).

`%ORIGIN%` in these files and in the page is filled in where the site is served:
- the playtest proxy does it per request;
- `scripts/net-trial/cloud-init.sh` does it on deploy.

### Room pages are noindex
- Caddy and the playtest proxy send `X-Robots-Tag: noindex` on `/r/*`.
- `boot.js` also turns the page's robots meta to `noindex` there.

### Speed
- The landing's LCP is the key art. It's preloaded with `fetchpriority="high"`, phone or desktop art by media query,
  and AVIF first. It's the same file the title screen uses, so nothing downloads twice.
- The landing's CSS is inline. Its only motion is one transform loop (the loading bar), which stops when the app is up.
- The menus' 3D backdrop no longer renders 60 times a second behind opaque screens (`ui/backdrop.ts`). It was the
  largest source of long tasks while the title and menus showed.
- On the server:
  - Caddy compresses with zstd and gzip, and the playtest proxy with brotli and gzip.
  - Hashed `/assets/*` are cached: a week on the box, a year (immutable) through the playtest.
  - `/art/*` gets ETag revalidation. A day of caching would need about 40 more bytes in cloud-init.sh, which is
    at its size limit.

## 3. What's left

- **A real domain (the owner's decision; see §4).** Nothing above helps much while the site lives at
  `40-123-240-224.sslip.io`.
- **Search Console and Bing Webmaster Tools:**
  1. Verify the domain with a DNS TXT record.
  2. Submit `https://<domain>/sitemap.xml`.
  3. Watch Coverage and Core Web Vitals. Field data appears once enough Chrome users visit (a few hundred a month).
- **Links:**
  - an itch.io page that links to the site;
  - a short gameplay trailer on YouTube with the link;
  - posts in game communities (r/WebGames, r/IndieGaming, Discord servers);
  - the public GitHub repo's README.
- **The JavaScript bundle:**
  - The first visit downloads about 0.55 MB of compressed script (three.js, the game and the shell) before the
    title answers.
  - Splitting the 3D view and the creator out of the first chunk would help INP and TBT on slow phones the most.
- **More pages worth finding**, each with its own words:
  - a page per map ("Street Market, Lagos") with screenshots;
  - a "how to play" page with the controls;
  - a changelog.
- **`/art/*` caching**: a day of caching, if the owner frees room in cloud-init.sh.

## 4. The domain: why it matters, options and costs

`40-123-240-224.sslip.io` will never rank well:
- It's a wildcard DNS service's name built from the server's IP address. It says nothing about the game, and nobody
  will search for it or remember it.
- It changes whenever the server's IP changes, and every change throws away whatever the site had earned.
- Search Console can only verify it as a single URL prefix, not as a domain.

Search engines rank a name that stays put, gathers links and matches what people type.

**What a domain costs, per year:** these are typical registrar prices in late 2026. Check at purchase, and expect
renewals to cost more than the first year.

| Domain | Typical price / year | Notes |
|---|---|---|
| `militaryforge.com` or `playmilitaryforge.com` | about $10–15 | The default choice; check availability first |
| `.gg` | about $50–80 | Popular with games |
| `.io` | about $35–60 | |
| `.games` | about $20–35 | Describes the site |
| `.com.ng` / `.ng` | about $10–20 / $40–70 | Local to Nigeria, where the first players are |

- Cloudflare Registrar sells at cost with no markup on renewals. Namecheap and Porkbun are similar.
- WHOIS privacy is free at all three.
- A trademark search on the name comes first (`packages/shared/src/brand.ts` notes it's pending).

**Switching to a domain, once bought:**
1. Point an A record at the server's IP.
2. Re-run the box's setup with `MF_HOST=<domain>`. Caddy gets the Let's Encrypt certificate itself, and every
   `%ORIGIN%` (canonical, Open Graph, sitemap) follows.
3. Keep the old sslip.io address redirecting (301) for a while.

There are no other costs: hosting stays on the Azure box.
