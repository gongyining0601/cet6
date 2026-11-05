/* app/sync.js —— 私有同步层（local-first，宿主无关）
 *
 * CET4 / CET6 共用同一份内核：两个项目的 app/sync.js 必须保持字节一致。
 * 项目差异全部放在 app/sync-config.js 的 namespace / endpoint 里，不进本文件。
 * 校验：node scripts/check_divergence.js
 *
 * 约定：
 *  · localStorage 仍是唯一渲染源与工作副本；本模块只负责"外部权威副本"的读写。
 *  · 未配置 endpoint/token 时整层不激活，应用行为与接入前完全一致。
 *  · 按学习编号分片（GET/PUT /state/:id），合并而非整份覆盖；并发用 rev 乐观锁 +
 *    字段级合并解决，不做 last-write-wins。
 *  · 任何网络/解析异常都降级为纯本地并显示状态，绝不静默吞掉、绝不清空本机记录。
 *
 * 端点契约（见 scripts/sync-server.js）：
 *   GET  /state/:id        -> 200 {rev, updatedAt, deviceId, state} | 404 {rev:0, state:null}
 *   PUT  /state/:id        -> 200 {rev} | 409 {rev, state}（rev 冲突，带回服务端当前值）
 *   所有请求带 X-Sync-Token 头。endpoint 可带 /cet4 或 /cet6 前缀，由服务端分目录隔离。
 */
(function (root) {
  'use strict';

  var CFG = root.CET_SYNC_CONFIG || {};
  var BASE = String(CFG.endpoint || '').replace(/\/+$/, '');
  var TOKEN = String(CFG.token || '');
  var NS = String(CFG.namespace || 'cet4').replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'cet4';
  var DEBOUNCE = Math.max(500, Number(CFG.debounceMs) || 3000);
  var TIMEOUT = Math.max(1000, Number(CFG.timeoutMs) || 8000);
  var DEVICE_KEY = 'cet_sync_device';
  var TOKEN_KEY = 'cet_sync_token_' + NS; // 按项目隔离：两个项目的圈子口令可以不同

  var opt = null;
  var userId = '';
  var deviceId = '';
  var rev = 0;
  var timer = null;
  var inFlight = false;
  var dirty = false;
  var boundLifecycle = false;
  var status = { state: 'off', message: '未启用同步', lastAt: 0 };

  function isObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function num(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function str(v) { return String(v == null ? '' : v); }
  function later(a, b) { a = str(a); b = str(b); return a >= b ? a : b; }
  function maxNum(a, b) { return num(a) > num(b) ? num(a) : num(b); }

  // ---------- 字段级合并 ----------
  // history：同一天两台设备各自累计，逐数值字段取 max。取 max 而非 sum 是为了幂等——
  //         断线重试、并发、重复导入都不会把时长凭空放大；代价是极端并发下略保守，可接受。
  // papers / wrongbook / essays / hl：按 key 取"更进步"的一条 / 取并集。
  // plan：按 date 取较新，同日取完成条目更多者。
  function mergeByKey(a, b, better) {
    var out = {}, keys = {}, k;
    a = isObj(a) ? a : {}; b = isObj(b) ? b : {};
    for (k in a) if (Object.prototype.hasOwnProperty.call(a, k)) keys[k] = 1;
    for (k in b) if (Object.prototype.hasOwnProperty.call(b, k)) keys[k] = 1;
    for (k in keys) if (Object.prototype.hasOwnProperty.call(keys, k)) {
      var x = isObj(a[k]) ? a[k] : null, y = isObj(b[k]) ? b[k] : null;
      if (x && y) out[k] = better(x, y) >= 0 ? x : y;
      else out[k] = x || y;
    }
    return out;
  }

  function mergeStates(local, remote) {
    var L = isObj(local) ? local : {}, R = isObj(remote) ? remote : {};
    var out = { version: 1, history: {}, papers: {}, wrongbook: {}, essays: {}, hl: {}, plan: null, lastBackup: '' };

    var lh = isObj(L.history) ? L.history : {}, rh = isObj(R.history) ? R.history : {};
    var dates = {}, d;
    for (d in lh) if (Object.prototype.hasOwnProperty.call(lh, d)) dates[d] = 1;
    for (d in rh) if (Object.prototype.hasOwnProperty.call(rh, d)) dates[d] = 1;
    for (d in dates) if (Object.prototype.hasOwnProperty.call(dates, d)) {
      var x = isObj(lh[d]) ? lh[d] : null, y = isObj(rh[d]) ? rh[d] : null;
      if (!x) { out.history[d] = y; continue; }
      if (!y) { out.history[d] = x; continue; }
      // 字段顺序与 core.normalizeState 保持一致，避免同一份状态合并前后 JSON 形状漂移
      var h = {
        minutes: maxNum(x.minutes, y.minutes), done: !!(x.done || y.done), floor: !!(x.floor || y.floor),
        qCount: maxNum(x.qCount, y.qCount), right: maxNum(x.right, y.right),
        timed: maxNum(x.timed, y.timed), timedWithin: maxNum(x.timedWithin, y.timedWithin),
        timedSec: maxNum(x.timedSec, y.timedSec)
      };
      out.history[d] = h;
    }

    out.papers = mergeByKey(L.papers, R.papers, function (a, b) {
      var la = str(a.lastAt), lb = str(b.lastAt);
      if (la !== lb) return la > lb ? 1 : -1;
      return (num(a.seen) + num(a.right) + num(a.wrong)) - (num(b.seen) + num(b.right) + num(b.wrong));
    });

    out.wrongbook = mergeByKey(L.wrongbook, R.wrongbook, function (a, b) {
      // SM-2 状态是单条记录：优先取复习推进更远（due 更晚 / 错次更多 / 连对更长）的那条
      if (str(a.due) !== str(b.due)) return str(a.due) > str(b.due) ? 1 : -1;
      if (num(a.wrongCount) !== num(b.wrongCount)) return num(a.wrongCount) > num(b.wrongCount) ? 1 : -1;
      return num(a.streak) - num(b.streak);
    });

    out.essays = mergeByKey(L.essays, R.essays, function (a, b) {
      if (str(a.lastAt) !== str(b.lastAt)) return str(a.lastAt) > str(b.lastAt) ? 1 : -1;
      return str(a.text).length - str(b.text).length;
    });

    // 高亮：按卷取并集去重，上限与 core.normalizeState 的 50 处保持一致
    var lhl = isObj(L.hl) ? L.hl : {}, rhl = isObj(R.hl) ? R.hl : {};
    var pids = {}, p;
    for (p in lhl) if (Object.prototype.hasOwnProperty.call(lhl, p)) pids[p] = 1;
    for (p in rhl) if (Object.prototype.hasOwnProperty.call(rhl, p)) pids[p] = 1;
    for (p in pids) if (Object.prototype.hasOwnProperty.call(pids, p)) {
      var seen = {}, arr = [];
      (Array.isArray(lhl[p]) ? lhl[p] : []).concat(Array.isArray(rhl[p]) ? rhl[p] : []).forEach(function (s) {
        if (typeof s === 'string' && !seen[s]) { seen[s] = 1; arr.push(s); }
      });
      if (arr.length) out.hl[p] = arr.slice(0, 50);
    }

    var lp = isObj(L.plan) ? L.plan : null, rp = isObj(R.plan) ? R.plan : null;
    function doneCount(pl) { return pl && Array.isArray(pl.items) ? pl.items.filter(function (i) { return i && i.done; }).length : -1; }
    if (lp && rp) {
      if (str(lp.date) !== str(rp.date)) out.plan = str(lp.date) > str(rp.date) ? lp : rp;
      else out.plan = doneCount(lp) >= doneCount(rp) ? lp : rp;
    } else out.plan = lp || rp;

    out.lastBackup = later(L.lastBackup, R.lastBackup);
    return out;
  }

  // ---------- 传输 ----------
  function setStatus(state, message) {
    status = { state: state, message: message, lastAt: state === 'ok' ? Date.now() : status.lastAt };
    if (opt && typeof opt.onStatus === 'function') {
      try { opt.onStatus(status); } catch (e) { }
    }
  }

  function enabled() { return !!(BASE && TOKEN && userId); }

  function req(method, body) {
    var F = root.fetch || (typeof fetch !== 'undefined' ? fetch : null);
    if (!F) return Promise.reject(new Error('当前环境不支持 fetch'));
    var headers = { 'X-Sync-Token': TOKEN };
    var o = { method: method, headers: headers, cache: 'no-store' };
    if (body) { headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    if (ctrl) o.signal = ctrl.signal;
    var to = ctrl ? setTimeout(function () { ctrl.abort(); }, TIMEOUT) : null;
    var url = BASE + '/state/' + encodeURIComponent(userId);
    return F(url, o).then(function (r) {
      return r.text().then(function (t) {
        var j = {}; try { j = JSON.parse(t) || {}; } catch (e) { }
        return { status: r.status, data: j };
      });
    }).then(function (v) { if (to) clearTimeout(to); return v; }, function (e) {
      if (to) clearTimeout(to);
      throw new Error(e && e.name === 'AbortError' ? '请求超时' : ('网络不可用' + (e && e.message ? '：' + e.message : '')));
    });
  }

  function applyIfChanged(merged, local) {
    if (opt && typeof opt.applyState === 'function' && JSON.stringify(merged) !== JSON.stringify(local)) {
      opt.applyState(merged);
    }
  }

  // PUT 遇 409：把服务端当前 state 与本机合并后，用新 rev 重试（最多 3 次）
  function pushMerged(state, baseRev, attempt) {
    return req('PUT', { rev: baseRev, deviceId: deviceId, state: state }).then(function (r) {
      if (r.status === 409) {
        var d = r.data || {};
        var again = mergeStates(state, d.state || null);
        rev = num(d.rev) || baseRev;
        applyIfChanged(again, state);
        if (attempt >= 2) throw new Error('并发冲突重试多次仍失败');
        return pushMerged(again, rev, attempt + 1);
      }
      if (r.status >= 400) throw new Error('服务端返回 ' + r.status + (r.data && r.data.error ? '（' + r.data.error + '）' : ''));
      rev = num(r.data && r.data.rev) || (baseRev + 1);
      setStatus('ok', '已同步');
      return true;
    });
  }

  function flush() {
    if (!enabled()) return Promise.resolve(false);
    if (inFlight) { dirty = true; return Promise.resolve(false); }
    inFlight = true;
    var local = opt.getState ? opt.getState() : null;
    setStatus('syncing', '正在同步…');
    // 先拉后推：本机若持有旧 rev，也先把另一台设备刚写的内容并进来，避免整份覆盖
    return req('GET').then(function (r) {
      if (r.status >= 400) throw new Error('拉取失败（' + r.status + '）');
      rev = num(r.data && r.data.rev);
      var merged = mergeStates(local, r.data && r.data.state);
      applyIfChanged(merged, local);
      return pushMerged(merged, rev, 0);
    }).catch(function (e) {
      setStatus('error', '同步失败：' + (e && e.message ? e.message : e) + '（本机记录已保存，联网后会自动重试）');
      return false;
    }).then(function (v) {
      inFlight = false;
      if (dirty) { dirty = false; schedulePush(); }
      return v;
    });
  }

  function schedulePush() {
    if (!enabled()) return;
    dirty = true;
    if (timer) clearTimeout(timer);
    timer = setTimeout(function () { timer = null; if (dirty) { dirty = false; flush(); } }, DEBOUNCE);
  }

  function pushNow() {
    if (!enabled()) return Promise.resolve(false);
    if (timer) { clearTimeout(timer); timer = null; }
    dirty = false;
    return flush();
  }

  function getDeviceId() {
    try {
      var v = root.localStorage && root.localStorage.getItem(DEVICE_KEY);
      if (!v) {
        v = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
        root.localStorage.setItem(DEVICE_KEY, v);
      }
      return v;
    } catch (e) { return 'd-unknown'; }
  }

  function bindLifecycle() {
    if (!root.addEventListener || boundLifecycle) return;
    boundLifecycle = true;
    // 切到后台立即推一次；不做 pagehide sendBeacon —— state 可能大于 keepalive 的 64KB 上限
    root.addEventListener('pagehide', function () { pushNow(); });
    if (root.document) {
      root.document.addEventListener('visibilitychange', function () {
        if (root.document.visibilityState === 'hidden') pushNow();
      });
    }
  }

  function hasEndpoint() { return !!BASE; }
  function hasToken() { return !!TOKEN; }
  function setToken(t) {
    TOKEN = String(t || '');
    // 口令只落在本机 localStorage，绝不写进随页面发布的静态文件
    try { if (root.localStorage) root.localStorage.setItem(TOKEN_KEY, TOKEN); } catch (e) { }
    if (enabled()) { setStatus('syncing', '正在连接同步端点…'); flush(); }
    else setStatus('off', '未启用同步（记录仅存本机）');
    return enabled();
  }

  function init(o) {
    opt = o || {};
    if (!BASE) { setStatus('off', '未启用同步（记录仅存本机，请定期导出备份）'); return false; }
    userId = String(opt.userId || CFG.userId || '').replace(/[^0-9A-Za-z_-]/g, '');
    if (!userId) { setStatus('error', '缺少学习编号，同步未启用'); return false; }
    deviceId = getDeviceId();
    if (!TOKEN) {
      try { TOKEN = String((root.localStorage && root.localStorage.getItem(TOKEN_KEY)) || ''); } catch (e) { }
    }
    bindLifecycle();
    // 口令未设置时不打扰启动流程，只把状态挂成「待设置」；用户在备份页点一次即可激活
    if (!enabled()) { setStatus('off', '待设置同步口令（备份页点「立即同步」输入，只存这台设备）'); return true; }
    setStatus('syncing', '正在连接同步端点…');
    flush();
    return true;
  }

  var api = {
    init: init,
    enabled: enabled,
    hasEndpoint: hasEndpoint,
    hasToken: hasToken,
    setToken: setToken,
    schedulePush: schedulePush,
    pushNow: pushNow,
    mergeStates: mergeStates,
    status: function () { return status; },
    userId: function () { return userId; },
    namespace: function () { return NS; }
  };
  root.CET_SYNC = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : global));
