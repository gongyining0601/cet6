/* CET6 打卡应用 Service Worker
 * 策略：外壳（index/core/manifest/图标）网络优先、离线兜底缓存；
 * 题库 bank/*.js 缓存优先（内容极少变化，二次打开秒开）。
 * 版本号单点化：VERSION 来自 version.js（importScripts），与 index.html 的 core.js?v= 同源，
 * 改 version.js 一处即全端刷新缓存。
 * 缓存节奏（修复弱网 install 全败）：install 只原子预缓存小体积外壳（≈1MB），
 * 76 卷题库（≈8.6MB）在 activate 后分批后台预热，单卷失败不拖累安装；
 * 预热完成前做题路径本来就有"缓存未命中→网络→写缓存"的兜底。
 */
try { importScripts('./version.js'); } catch (e) { }
var VERSION = self.CET6_VERSION || 'cet6-v21';
var SHELL = ['./', './index.html', './version.js', './core.js?v=' + encodeURIComponent(VERSION), './manifest.json', './icon-192.png', './icon-512.png', './bank/meta.js', './hls.min.js', './bank/listeningMeta.js',
  './bank/img/2015-12-1.jpg', './bank/img/2015-12-2.jpg', './bank/img/2015-12-3.jpg',
  './bank/img/2021-06-1.jpg', './bank/img/2021-06-2.jpg', './bank/img/2021-06-3.jpg'];
/* 卷清单来自 meta.js（顶层 IIFE 挂到 self.CET6_META）：activate 后分批后台预热。
   meta.js 缺失时退化为只缓存外壳（页面会由 index.html 的 meta 完整性检查给出错误提示）。 */
try { importScripts('./bank/meta.js'); } catch (e) { }
var M = self.CET6_META;
var BANK_URLS = (M && Array.isArray(M.order))
  ? M.order.map(function (id) { return './bank/cet6-' + id + '.js'; })
  : [];

self.addEventListener('install', function (e) {
  // 只原子缓存外壳：体积小、弱网也能一次成功；失败才整体重试
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }).then(function () { warmBankCache(); }));
});

// 后台分批预热题库（每批 8 个并发）：弱网下个别失败只影响该卷，做题时仍会现取现缓存
function warmBankCache() {
  if (!BANK_URLS.length) return;
  caches.open(VERSION).then(function (c) {
    var i = 0;
    function nextBatch() {
      var batch = [];
      for (var j = 0; j < 8 && i < BANK_URLS.length; j++, i++) {
        (function (u) {
          batch.push(c.match(u).then(function (hit) {
            return hit ? null : c.add(u).catch(function () { });
          }));
        })(BANK_URLS[i]);
      }
      if (!batch.length) return Promise.resolve();
      return Promise.all(batch).then(nextBatch);
    }
    return nextBatch();
  });
}

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
