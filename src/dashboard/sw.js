/* 体重ダッシュボード Service Worker。{{ASSET_VERSION}}はdashboard.tsが注入する */
'use strict';

var VERSION = '{{ASSET_VERSION}}';
var CACHE_NAME = 'weight-dash-' + VERSION;
var SCOPE = self.registration.scope;
var PRECACHE_URLS = [
  './',
  'styles.css?v=' + VERSION,
  'app.js?v=' + VERSION,
  'shared.js?v=' + VERSION,
  'meals.js?v=' + VERSION,
  'exercise.js?v=' + VERSION,
  'vendor/chart.umd.js?v=' + VERSION,
  'manifest.webmanifest',
].map(function (p) {
  return new URL(p, SCOPE).toString();
});

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        return cache.addAll(PRECACHE_URLS);
      })
      .then(function () {
        return self.skipWaiting();
      })
  );
});

/* 旧バージョンのキャッシュを削除する */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches
      .keys()
      .then(function (names) {
        return Promise.all(
          names
            .filter(function (n) {
              return n.indexOf('weight-dash-') === 0 && n !== CACHE_NAME;
            })
            .map(function (n) {
              return caches.delete(n);
            })
        );
      })
      .then(function () {
        return self.clients.claim();
      })
  );
});

/* HTML/API: network-first + cacheフォールバック */
function networkFirst(request, isNavigate) {
  return caches.open(CACHE_NAME).then(function (cache) {
    return fetch(request)
      .then(function (res) {
        if (res.ok) cache.put(request, res.clone());
        return res;
      })
      .catch(function (err) {
        return cache.match(request, { ignoreSearch: isNavigate }).then(function (hit) {
          if (hit) return hit;
          if (isNavigate) {
            return cache.match(new URL('./', SCOPE).toString()).then(function (home) {
              if (home) return home;
              throw err;
            });
          }
          throw err;
        });
      });
  });
}

/* 静的asset: cache-first */
function cacheFirst(request) {
  return caches.open(CACHE_NAME).then(function (cache) {
    return cache.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (res) {
        if (res.ok) cache.put(request, res.clone());
        return res;
      });
    });
  });
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.href.indexOf(SCOPE) !== 0) return;
  if (url.pathname.slice(-7) === '/og.png' || url.pathname.slice(-6) === '/sw.js') return;
  var isNavigate = req.mode === 'navigate';
  var isApi = url.pathname.indexOf('/api/') !== -1;
  if (isNavigate || isApi) {
    event.respondWith(networkFirst(req, isNavigate));
    return;
  }
  event.respondWith(cacheFirst(req));
});
