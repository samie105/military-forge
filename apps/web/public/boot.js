/*
 * The page's first script (index.html, before the app's bundle). It:
 *   - turns the page onto its side on an upright phone and fits the kit's 1920×1080 screens to the
 *     window the way the app's ui/fit.ts does (menuFit), so the landing and the title line up;
 *   - picks what shows while the app loads: the loading screen for a room link (/r/CODE, ?lan), else
 *     the landing (docs/seo.md), with the phone's key art and type on a phone;
 *   - marks room pages noindex (the server also sends X-Robots-Tag);
 *   - runs the landing's two links before the app is up: Play now (remembered: the title continues
 *     as soon as it's ready, Title.tsx) and About the game (a dialog: focus moves in, Tab stays in,
 *     Escape and Close shut it, focus goes back);
 *   - turns the loading screen's tips every 4 s and shows "Still loading" after 20 s.
 */
(function () {
  var root = document.documentElement;
  root.classList.add('mf-js');
  function matches(q) {
    return !!(window.matchMedia && window.matchMedia(q).matches);
  }
  // a phone held upright turns the page onto its side (the app's ui/landscape.ts keeps this up after)
  function turned() {
    return matches('(orientation: portrait) and (max-width: 500px) and (pointer: coarse)');
  }
  function phone() {
    return turned() || matches('(orientation: landscape) and (max-height: 500px) and (pointer: coarse)');
  }
  function fit() {
    var rotated = turned();
    root.classList.toggle('mf-rotated', rotated);
    root.style.setProperty('--app-w', window.innerHeight + 'px');
    root.style.setProperty('--app-h', window.innerWidth + 'px');
    var w = rotated ? window.innerHeight : window.innerWidth;
    var h = rotated ? window.innerWidth : window.innerHeight;
    // ui/fit.ts menuFit: min(w/1920, h/1080), but no lower than 0.8 while that leaves 1600×900
    var f = Math.max(Math.min(w / 1920, h / 1080), Math.min(0.8, w / 1600, h / 900)) || 1;
    root.style.setProperty('--fit', f.toFixed(4));
    root.style.setProperty('--fit-w', (w / f).toFixed(1) + 'px');
    root.style.setProperty('--fit-h', (h / f).toFixed(1) + 'px');
    var hero = document.getElementById('land-hero');
    if (hero) hero.classList.toggle('is-phone', phone());
  }
  fit();
  window.addEventListener('resize', fit);

  var room = /^\/r\/([A-Za-z]{6})\/?$/.exec(location.pathname);
  var roomish = !!room || /[?&]lan(=|&|$)/.test(location.search);
  root.classList.add(roomish ? 'mf-boot-room' : 'mf-boot-landing');
  if (room) {
    document.getElementById('boot-code').textContent = room[1].toUpperCase();
    document.getElementById('boot-room').hidden = false;
  }
  if (roomish) {
    var robots = document.querySelector('meta[name="robots"]');
    if (robots) robots.setAttribute('content', 'noindex');
  }

  // ---- the landing's links
  var line = document.getElementById('land-line');
  function play() {
    root.setAttribute('data-play', '1');
    if (line) line.textContent = 'Getting ready…';
    window.dispatchEvent(new Event('mf:play'));
  }
  var about = document.getElementById('about');
  var opener = null;
  function focusables() {
    return about ? Array.prototype.filter.call(about.querySelectorAll('a[href], button, summary, [tabindex]:not([tabindex="-1"])'), function (el) {
      return el.getClientRects().length > 0;
    }) : [];
  }
  function clearHash() {
    if (history.replaceState) history.replaceState(null, '', location.pathname + location.search);
  }
  function route() {
    var h = location.hash;
    if (h === '#play') {
      clearHash();
      setOpen(false);
      play();
    } else setOpen(h === '#about');
  }
  function setOpen(open) {
    if (!about || root.classList.contains('mf-about-open') === open) return;
    if (open) {
      if (!opener) opener = document.activeElement;
      root.classList.add('mf-about-open');
      about.focus({ preventScroll: true });
    } else {
      root.classList.remove('mf-about-open');
      if (location.hash === '#about') clearHash();
      if (opener && opener !== document.body && opener.focus && document.contains(opener)) opener.focus({ preventScroll: true });
      else if (about.contains(document.activeElement)) document.activeElement.blur();
      opener = null;
    }
  }
  // the link that opens it gets focus back (a fragment jump has already moved focus by hashchange)
  document.addEventListener(
    'click',
    function (e) {
      var a = e.target.closest && e.target.closest('a[href="#about"]');
      if (a && !root.classList.contains('mf-about-open')) opener = a;
    },
    true,
  );
  window.addEventListener('hashchange', route);
  if (location.hash === '#about' || location.hash === '#play') route();
  if (about) {
    about.addEventListener('click', function (e) {
      var a = e.target.closest && e.target.closest('a[href="#"]');
      if (a || e.target === about) {
        e.preventDefault();
        setOpen(false);
      }
    });
  }
  // while the sheet is open it owns the keyboard and the pointer: the title, menus and game don't hear
  // them (Escape closes it, Tab stays in it); the links' and details' own behaviour still runs
  window.addEventListener(
    'keydown',
    function (e) {
      if (!root.classList.contains('mf-about-open')) return;
      e.stopImmediatePropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      } else if (e.key === 'Tab') {
        var f = focusables();
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && (document.activeElement === first || document.activeElement === about)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    },
    true,
  );
  window.addEventListener(
    'pointerdown',
    function (e) {
      if (root.classList.contains('mf-about-open')) e.stopImmediatePropagation();
    },
    true,
  );

  // ---- the game's code didn't load (src/boot.ts sends mf:boot-failed): no connection, or this page is
  // from before a new version of the game and asks for files that are gone. One quiet reload first (it
  // fetches the new page); if that fails too, say so and offer Try again, never "Loading" forever.
  function bootFailed() {
    if (root.classList.contains('mf-app')) return; // the app is up: its own screens handle the rest
    try {
      var last = Number(sessionStorage.getItem('mf-boot-retry')) || 0;
      if (Date.now() - last > 60000 && navigator.onLine !== false) {
        sessionStorage.setItem('mf-boot-retry', String(Date.now()));
        location.reload();
        return;
      }
    } catch {
      /* no storage: no quiet reload (it could repeat), the button below */
    }
    root.classList.add('mf-boot-failed');
    var text = "The game didn't load. Check your connection, then try again.";
    if (line) line.textContent = text;
    var failLine = document.getElementById('boot-fail-line');
    if (failLine) failLine.textContent = text;
    var buttons = document.querySelectorAll('.mf-land__retry');
    for (var i = 0; i < buttons.length; i++) buttons[i].hidden = false;
    var fail = document.getElementById('boot-fail');
    if (fail) fail.hidden = false;
  }
  window.addEventListener('mf:boot-failed', bootFailed);
  document.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('.mf-land__retry')) location.reload();
  });

  // ---- the loading screen (room links)
  var slow = document.getElementById('boot-slow');
  if (slow) setTimeout(function () { slow.classList.add('is-on'); }, 20000);

  var splash = document.getElementById('boot-splash');
  var screen = splash && splash.querySelector('.screen');
  if (!screen || !roomish) return;
  var tips = screen.querySelectorAll('[data-state^="tip-"]');
  var n = 1;
  var timer = setInterval(function () {
    if (!document.body.contains(splash)) return clearInterval(timer);
    n = (n % 3) + 1;
    screen.setAttribute('data-active-state', 'tip-' + n);
    for (var i = 0; i < tips.length; i++) tips[i].hidden = tips[i].getAttribute('data-state') !== 'tip-' + n;
    var count = document.getElementById('boot-tip');
    if (count) count.textContent = String(n);
  }, 4000);
})();
