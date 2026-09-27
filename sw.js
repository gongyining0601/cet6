/* CET6 打卡应用 Service Worker
 * 策略：外壳（index/core/manifest/图标）网络优先、离线兜底缓存；
 * 题库 bank/*.js 缓存优先（内容极少变化，二次打开秒开）。
 * 更新应用时改下面的 VERSION 即可让所有客户端刷新缓存。
 */
var VERSION = 'cet6-v16';
var SHELL = ['./', './index.html', './core.js', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  var isBank = url.pathname.indexOf('/bank/') >= 0;
  if (isBank) {
    // 题库：缓存优先，未命中再取网络并写入缓存
    e.respondWith(caches.open(VERSION).then(function (c) {
      return c.match(e.request).then(function (hit) {
        if (hit) return hit;
        return fetch(e.request).then(function (resp) {
          if (resp.ok) c.put(e.request, resp.clone());
          return resp;
        });
      });
    }));
  } else {
    // 外壳：网络优先（保证更新及时），离线回退缓存
    e.respondWith(fetch(e.request).then(function (resp) {
      if (resp.ok && e.request.method === 'GET') {
        var cp = resp.clone();
        caches.open(VERSION).then(function (c) { c.put(e.request, cp); });
      }
      return resp;
    }).catch(function () {
      return caches.match(e.request).then(function (hit) { return hit || caches.match('./index.html'); });
    }));
  }
});
