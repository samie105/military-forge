/*
 * The old address's service worker: replaces the game's, which would keep serving the old pages from
 * its cache, so the moving page never showed. It empties the caches, takes itself off and reloads
 * every open page, which then comes from the network: the moving page.
 */
/* global self, caches */
self.addEventListener('install', function () {
  self.skipWaiting();
});
self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(names.map(function (n) { return caches.delete(n); }));
      })
      .then(function () { return self.registration.unregister(); })
      .then(function () { return self.clients.matchAll({ type: 'window' }); })
      .then(function (pages) {
        pages.forEach(function (p) { p.navigate(p.url); });
      }),
  );
});
