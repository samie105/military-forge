/*
 * The loading screen's only script (index.html, before the app's bundle): turns the page onto its
 * side on an upright phone and fits the kit's 1920×1080 screen to the window (the app's
 * ui/landscape.ts and fit.ts take over later), names the room of a room
 * link, and turns the tips every 4 s the kit's way (data-active-state="tip-N").
 */
(function () {
  var root = document.documentElement;
  // a phone held upright turns the page onto its side (the app's ui/landscape.ts keeps this up after)
  function turned() {
    return !!(window.matchMedia && window.matchMedia('(orientation: portrait) and (max-width: 500px) and (pointer: coarse)').matches);
  }
  function fit() {
    var rotated = turned();
    root.classList.toggle('mf-rotated', rotated);
    root.style.setProperty('--app-w', window.innerHeight + 'px');
    root.style.setProperty('--app-h', window.innerWidth + 'px');
    var w = rotated ? window.innerHeight : window.innerWidth;
    var h = rotated ? window.innerWidth : window.innerHeight;
    var f = Math.min(w / 1920, h / 1080) || 1;
    root.style.setProperty('--fit', f.toFixed(4));
    root.style.setProperty('--fit-w', (w / f).toFixed(1) + 'px');
    root.style.setProperty('--fit-h', (h / f).toFixed(1) + 'px');
  }
  fit();
  window.addEventListener('resize', fit);

  var room = /^\/r\/([A-Za-z]{6})\/?$/.exec(location.pathname);
  if (room) {
    document.getElementById('boot-code').textContent = room[1].toUpperCase();
    document.getElementById('boot-room').hidden = false;
  }

  var slow = document.getElementById('boot-slow');
  if (slow) setTimeout(function () { slow.classList.add('is-on'); }, 20000);

  var splash = document.getElementById('boot-splash');
  var screen = splash && splash.querySelector('.screen');
  if (!screen) return;
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
