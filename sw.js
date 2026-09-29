/* CET6 打卡应用 Service Worker
 * 策略：外壳（index/core/manifest/图标）网络优先、离线兜底缓存；
 * 题库 bank/*.js 缓存优先（内容极少变化，二次打开秒开）。
 * 按需加载（架构级，v17）：首屏页面只加载 meta.js；install 阶段把全部 76 卷预缓存进 SW，
 * 不阻塞首屏渲染，做题时的动态加载（fetch 优先命中缓存）与离线全库可用保持不变。
 * 更新应用时改下面的 VERSION 即可让所有客户端刷新缓存。
 */
var VERSION = 'cet6-v20';
var SHELL = ['./', './index.html', './core.js?v=7', './manifest.json', './icon-192.png', './icon-512.png', './bank/meta.js', './hls.min.js', './bank/listeningMeta.js'];
/* 卷清单来自 meta.js（顶层 IIFE 挂到 self.CET6_META）：install 时把全部卷预缓存。
   meta.js 缺失时退化为只缓存外壳（页面会由 index.html 的 meta 完整性检查给出错误提示）。 */
try { importScripts('./bank/meta.js'); } catch (e) { }
var M = self.CET6_META;
var BANK_URLS = (M && Array.isArray(M.order))
  ? M.order.map(function (id) { return './bank/cet6-' + id + '.js'; })
  : [];
var PRECACHE = SHELL.concat(BANK_URLS);

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(PRECACHE); }).then(function () { return self.skipWaiting(); }));
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
