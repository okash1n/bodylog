/* 体重ダッシュボード Service Worker。{{ASSET_VERSION}}と{{PRIVATE_READ}}はdashboard.tsが注入する */
'use strict';

var VERSION = '{{ASSET_VERSION}}';
var CACHE_NAME = 'weight-dash-' + VERSION;
/* READ_ACCESS=private のとき true。private では認証済みAPI応答をCache Storageへ保存しない
   （Cache.put は no-store を尊重しないため、SW側で API を一切横取りしない）。
   public のオフライン閲覧（network-first + cacheフォールバック）は従来どおり維持する */
var PRIVATE = '{{PRIVATE_READ}}' === 'true';
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

/* 旧バージョンのキャッシュを削除する。privateでは現行キャッシュ内のAPI応答も掃除する
   （READ_ACCESS だけが変わって VERSION が同じ場合、旧SWが保存したAPI応答が同名キャッシュに残るため） */
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
        if (!PRIVATE) return;
        return caches.open(CACHE_NAME).then(function (cache) {
          return cache.keys().then(function (reqs) {
            return Promise.all(
              reqs
                .filter(function (req) {
                  return req.url.indexOf('/api/') !== -1;
                })
                .map(function (req) {
                  return cache.delete(req);
                })
            );
          });
        });
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
  /* private: 認証必須のAPI応答はSWが横取り・保存しない（常にネットワーク直行） */
  if (isApi && PRIVATE) return;
  if (isNavigate || isApi) {
    event.respondWith(networkFirst(req, isNavigate));
    return;
  }
  event.respondWith(cacheFirst(req));
});
