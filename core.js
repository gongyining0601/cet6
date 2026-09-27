/* CET6 打卡应用 · 核心逻辑（纯函数，可在 Node 中测试）
   数据结构：
   state = {
     version: 1,
     history: { 'YYYY-MM-DD': { minutes: 0, done: false, floor: false, qCount: 0, right: 0 } },
     papers: { qid: { seen: n, wrong: n, right: n, lastAt: 'date', lastResult: 'right'|'wrong' } },
     wrongbook: { qid: { addedAt, box: n, due: 'YYYY-MM-DD', wrongCount: n } },
     plan: { date: 'YYYY-MM-DD', items: [ {key, type, qids, done, minutes} ] },
     essays: { 'writing': {lastAt, text, rate?}, 'translation': {...} }  // 最近一次作文/翻译草稿；rate=自评分(0~1，可选)
   } */
(function (root) {
  'use strict';

  var CORE = {};

  // ---------- 日期 ----------
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  CORE.todayStr = function (d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  };
  CORE.addDays = function (dateStr, n) {
    var p = dateStr.split('-').map(Number);
    var d = new Date(p[0], p[1] - 1, p[2] + n);
    return CORE.todayStr(d);
  };
  CORE.dayDiff = function (a, b) { // b - a 天数
    var pa = a.split('-').map(Number), pb = b.split('-').map(Number);
    var da = new Date(pa[0], pa[1] - 1, pa[2]), db = new Date(pb[0], pb[1] - 1, pb[2]);
    return Math.round((db - da) / 86400000);
  };

  // ---------- 题型 ----------
  CORE.TYPE_META = {
    listening: { zh: '听力', minPerQ: 1.4, group: '听力·同卷连续4题' },
    cloze:     { zh: '选词填空', minPerQ: 0.6, group: '选词填空·整篇' },
    match:     { zh: '信息匹配', minPerQ: 1.3, group: '信息匹配·整篇' },
    reading:   { zh: '仔细阅读', minPerQ: 1.6, group: '仔细阅读·整篇' },
    writing:   { zh: '写作', minPerQ: 15, group: '写作·每周一练' },
    translation: { zh: '翻译', minPerQ: 12, group: '翻译·每周一练' }
  };
  CORE.INTERVALS = [1, 2, 4, 7, 15];
  // 预算制调度参数（分钟）：目标~上限浮动，错题复习封顶
  CORE.PLAN_TARGET = 25;
  CORE.PLAN_CAP = 40;
  CORE.REVIEW_CAP = 10;
  CORE.PLAN_VERSION = 3; // 清单结构版本：低于此版本的旧版 plan 会被 ensurePlan 丢弃重算（v3=每日保底一组听力）

  // ---------- 题库索引 ----------
  CORE.allQuestions = function (banks) {
    var out = [];
    banks.forEach(function (b) {
      (b.questions || []).forEach(function (q) {
        out.push({ q: q, paper: b });
      });
    });
    return out;
  };
  CORE.findQ = function (banks, qid) {
    for (var i = 0; i < banks.length; i++) {
      for (var j = 0; j < banks[i].questions.length; j++) {
        if (banks[i].questions[j].id === qid) return banks[i].questions[j];
      }
    }
    return null;
  };
  CORE.findPaper = function (banks, qid) {
    for (var i = 0; i < banks.length; i++) {
      for (var j = 0; j < banks[i].questions.length; j++) {
        if (banks[i].questions[j].id === qid) return banks[i];
      }
    }
    return null;
  };

  // ---------- 遗忘曲线（自适应 SM-2：间隔随答题表现动态伸缩）----------
  CORE.nextDue = function (box, dateStr) {
    var iv = CORE.INTERVALS[Math.min(box, CORE.INTERVALS.length - 1)];
    return CORE.addDays(dateStr, iv);
  };
  // 自适应间隔：ease 反映该题掌握稳固度（1.3~2.8），间隔 = 上次间隔 × ease
  CORE.nextIv = function (wb) {
    if (wb.iv <= 1) return 2;
    return Math.min(60, Math.max(1, Math.round(wb.iv * wb.ease)));
  };
  // 记录一题结果：更新 papers / wrongbook；points 为可选的考点快照（按需加载：统计页与加载状态无关）
  CORE.recordResult = function (state, qid, correct, dateStr, points) {
    var st = state.papers[qid] || (state.papers[qid] = { seen: 0, wrong: 0, right: 0 });
    st.seen++; st.lastAt = dateStr; st.lastResult = correct ? 'right' : 'wrong';
    if (Array.isArray(points) && points.length) st.points = points.slice(0, 8);
    if (correct) { st.right++; } else { st.wrong++; }
    if (correct) {
      var wb = state.wrongbook[qid];
      if (wb) {
        wb.ease = Math.min(2.8, (wb.ease || 2.5) + 0.1);
        wb.streak = (wb.streak || 0) + 1;
        wb.iv = CORE.nextIv(wb);
        wb.box = Math.min(wb.box + 1, CORE.INTERVALS.length - 1);
        wb.due = CORE.addDays(dateStr, wb.iv);
        if (wb.streak >= 5) { delete state.wrongbook[qid]; } // 连续答对 5 次毕业出库
      }
    } else {
      var wb2 = state.wrongbook[qid] || (state.wrongbook[qid] = { addedAt: dateStr, box: 0, wrongCount: 0 });
      wb2.ease = Math.max(1.3, (wb2.ease || 2.5) - 0.2);
      wb2.streak = 0;
      wb2.box = 0;
      wb2.iv = 1;
      wb2.wrongCount++;
      wb2.due = CORE.addDays(dateStr, 1);
    }
    return state;
  };
  // 今日到期错题（可重练）
  CORE.dueWrongIds = function (state, dateStr) {
    var out = [];
    Object.keys(state.wrongbook).forEach(function (qid) {
      var wb = state.wrongbook[qid];
      if (!wb) return; // 脏存档兜底：值为空则视为不在库
      if (CORE.dayDiff(wb.due, dateStr) >= 0) out.push(qid);
    });
    return out;
  };
  CORE.allWrongIds = function (state) { return Object.keys(state.wrongbook); };
  // 智能复习队列：到期错题按（逾期天数 > 错次 > ease 低）排序，越薄弱越靠前
  CORE.reviewQueue = function (state, banks, dateStr, limit) {
    var qids = [];
    Object.keys(state.wrongbook).forEach(function (qid) { if (state.wrongbook[qid]) qids.push(qid); });
    qids.sort(function (a, b) {
      var wa = state.wrongbook[a], wbb = state.wrongbook[b];
      var oa = CORE.dayDiff(wa.due, dateStr), ob = CORE.dayDiff(wbb.due, dateStr); // 逾期天数（正=已逾期）
      if (oa !== ob) return ob - oa;
      if (wa.wrongCount !== wbb.wrongCount) return wbb.wrongCount - wa.wrongCount;
      return (wa.ease || 2.5) - (wbb.ease || 2.5);
    });
    var out = [];
    for (var i = 0; i < qids.length; i++) {
      if (CORE.dayDiff(state.wrongbook[qids[i]].due, dateStr) >= 0) out.push(qids[i]);
      if (limit && out.length >= limit) break;
    }
    return out;
  };
  // 错题本总览统计
  CORE.wrongSummary = function (state, dateStr) {
    var ids = Object.keys(state.wrongbook), due = 0, overdue = 0, maxOver = 0, ivSum = 0, n = 0;
    ids.forEach(function (qid) {
      var wb = state.wrongbook[qid];
      if (!wb) return;
      n++;
      var od = CORE.dayDiff(wb.due, dateStr); // 逾期天数（正=已逾期）
      if (od >= 0) due++;
      if (od > 0) { overdue++; if (od > maxOver) maxOver = od; }
      ivSum += (wb.iv || 1);
    });
    return { total: n, due: due, overdue: overdue, maxOverdue: maxOver, avgIv: n ? Math.round(ivSum / n) : 0 };
  };

  // ---------- 随机（按日期种子可复现）----------
  CORE.seedRand = function (seed) {
    var s = 0;
    for (var i = 0; i < seed.length; i++) { s = (s * 31 + seed.charCodeAt(i)) % 1000003; }
    return function () { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  };
  CORE.shuffledBy = function (arr, rand) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(rand() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };

  // ---------- 今日清单生成（P7 预算制 · 完整优先 · 块间轮换）----------
  /* 规则：
     1. 到期错题最优先：按薄弱程度（逾期>错次>稳固度）排序，同卷同题型相邻打包成组，封顶 REVIEW_CAP 分钟
     2. 周六安排写译一篇（写作/翻译隔周轮换，占当日额度不加量）
     3. 新题按完整单元装包：听力=同卷同Section连续4题 / 选词=整篇 / 匹配=整篇 / 阅读=整篇5题
        单元推进按最近考期优先（2026→2015），整单元做完的自动跳过；装满目标分钟数即收，
        最后一个单元允许溢出到上限（每日 25~40 分钟浮动） */
  CORE.paperOrder = function (banks) { // 最近考期优先
    return banks.slice().sort(function (a, b) { return a.id < b.id ? 1 : (a.id > b.id ? -1 : 0); });
  };
  var LISTEN_SECTIONS = [[1, 8, '长对话'], [9, 15, '篇章'], [16, 25, '讲座']];
  function mkUnit(paper, type, qs, label) {
    return {
      paperId: paper.id, type: type, label: label,
      qids: qs.map(function (q) { return q.id; }),
      qnos: qs.map(function (q) { return q.qno; }),
      min: Math.round(CORE.TYPE_META[type].minPerQ * qs.length * 10) / 10
    };
  }
  // 全量单元清单（确定性顺序：卷从最近到最早，卷内听力→选词→匹配→阅读）
  CORE.unitList = function (banks) {
    var units = [];
    CORE.paperOrder(banks).forEach(function (p) {
      var qs = (p.questions || []).slice().sort(function (a, b) { return a.qno - b.qno; });
      LISTEN_SECTIONS.forEach(function (sec) {
        var lst = qs.filter(function (q) { return q.type === 'listening' && q.qno >= sec[0] && q.qno <= sec[1]; });
        for (var i = 0; i < lst.length; i += 4) {
          var chunk = lst.slice(i, i + 4);
          units.push(mkUnit(p, 'listening', chunk, '听力·' + sec[2] + ' ' + chunk[0].qno + '-' + chunk[chunk.length - 1].qno));
        }
      });
      var cl = qs.filter(function (q) { return q.type === 'cloze'; });
      if (cl.length) units.push(mkUnit(p, 'cloze', cl, '选词填空·整篇 26-35'));
      var mt = qs.filter(function (q) { return q.type === 'match'; });
      if (mt.length) units.push(mkUnit(p, 'match', mt, '信息匹配·整篇 36-45'));
      var rd = qs.filter(function (q) { return q.type === 'reading'; });
      for (var r = 0; r + 5 <= rd.length; r += 5) {
        units.push(mkUnit(p, 'reading', rd.slice(r, r + 5), '仔细阅读·整篇 ' + rd[r].qno + '-' + (rd[r].qno + 4)));
      }
    });
    return units;
  };
  /* 按需加载（架构级）：题库可处于两种形态——
     ① 全量（banks 的 questions 有内容，测试/完整加载）：单元由 unitList 现算；
     ② meta 骨架（app/bank/meta.js，首屏只带元数据）：每卷的 units 已固化在 meta.papers[id].units 里，
        genPlan/extraGroup 直接展开，无需题目正文。
     unitsOf(src) 自动识别两种形态，保证清单生成逻辑单一实现。 */
  CORE.isFullBank = function (src) {
    return !!(Array.isArray(src) && src.length && src[0] && Array.isArray(src[0].questions) && src[0].questions.length);
  };
  CORE.unitsOf = function (src) {
    if (CORE.isFullBank(src)) return CORE.unitList(src);
    var units = [];
    var papers = (src && src.papers) || {};
    Object.keys(papers).forEach(function (id) {
      var p = papers[id];
      if (p && Array.isArray(p.units)) units = units.concat(p.units);
    });
    return units;
  };
  // 由 qid（如 2026-06-1-l-3）解析卷 id：题型字母固定为 l/c/m/r + 数字
  CORE.paperIdOf = function (qid) {
    var m = /^(.*)-(l|c|m|r)-\d+$/.exec(String(qid));
    return m ? m[1] : String(qid);
  };
  // 从 meta 骨架查单题元数据（type/qno/points），供未加载卷的统计与清单使用
  CORE.qMeta = function (meta, qid) {
    if (!meta || !meta.papers) return null;
    var p = meta.papers[CORE.paperIdOf(qid)];
    if (!p || !Array.isArray(p.qLite)) return null;
    for (var i = 0; i < p.qLite.length; i++) if (p.qLite[i].id === qid) return p.qLite[i];
    return null;
  };
  CORE.genPlan = function (state, banks, dateStr) {
    var isFull = CORE.isFullBank(banks);
    var meta = !isFull ? banks : null;
    var items = [];
    var planIds = {};
    // 1) 到期错题复习组（封顶 REVIEW_CAP 分钟；同卷同题型相邻打包保持语境完整）
    var reviewMin = 0;
    var groups = [];
    CORE.reviewQueue(state, banks, dateStr).forEach(function (qid) {
      var q = isFull ? CORE.findQ(banks, qid) : CORE.qMeta(meta, qid);
      var paper = isFull ? CORE.findPaper(banks, qid) : { id: CORE.paperIdOf(qid) };
      if (!q || !paper) return;
      var per = CORE.TYPE_META[q.type] ? CORE.TYPE_META[q.type].minPerQ : 1;
      if (reviewMin + per > CORE.REVIEW_CAP) return; // 放不下的留到明天，队列不丢
      reviewMin += per; planIds[qid] = 1;
      var last = groups[groups.length - 1];
      if (last && last.paperId === paper.id && last.type === q.type) last.qids.push(qid);
      else groups.push({ paperId: paper.id, type: q.type, qids: [qid] });
    });
    groups.forEach(function (g) {
      g.qids.sort(function (a, b) {
        return (isFull ? C_findQno(banks, a) : (CORE.qMeta(meta, a) || {}).qno || 0) - (isFull ? C_findQno(banks, b) : (CORE.qMeta(meta, b) || {}).qno || 0);
      });
      items.push({ key: 'review-' + g.type + '-' + g.paperId, type: g.type, qids: g.qids, paperId: g.paperId, label: '错题复习·' + CORE.TYPE_META[g.type].zh + ' ' + g.qids.length + '题', done: false, minutes: 0, review: true });
    });
    // 2) 周六写译一篇（占当日额度；选卷与新题推进同卷——最近考期优先的第一个未完成单元所在卷）
    var target = CORE.PLAN_TARGET, cap = CORE.PLAN_CAP;
    var dParts = dateStr.split('-').map(Number);
    var dow = new Date(dParts[0], dParts[1] - 1, dParts[2]).getDay();
    var units = CORE.unitsOf(banks);
    if (dow === 6) {
      var weekIdx = Math.floor(CORE.dayDiff('2020-01-04', dateStr) / 7); // 2020-01-04 为周六锚点
      var wtype = weekIdx % 2 === 0 ? 'writing' : 'translation';
      var wp = isFull ? CORE.paperOrder(banks)[0] : { id: (meta && meta.order && meta.order[0]) || '' };
      for (var wi = 0; wi < units.length; wi++) {
        if (!units[wi].qids.every(function (id) { return state.papers[id]; })) { wp = { id: units[wi].paperId }; break; }
      }
      items.push({ key: 'essay-' + dateStr, type: wtype, qids: [], paperId: wp.id, done: false, minutes: 0 });
      var wmin = wtype === 'writing' ? 15 : 12;
      target -= wmin; cap -= wmin;
    }
    // 3) 新题完整单元装包（最近考期优先，已做完的整单元跳过）
    var acc = 0, i = 0;
    // 3a) 每日保底一组听力：听力是持续性技能，一天不练就生疏。
    //     部分卷（27 套第3套等）无听力题，纯贪心会连续多日排不进听力，这里显式保证。
    var hasListening = items.some(function (it) { return it.type === 'listening'; });
    if (!hasListening) {
      for (var li = 0; li < units.length; li++) {
        var lu = units[li];
        if (lu.type !== 'listening') continue;
        if (lu.qids.every(function (id) { return state.papers[id]; })) continue;
        if (lu.qids.some(function (id) { return planIds[id]; })) continue;
        if (lu.min > cap) continue;
        items.push({ key: 'new-' + lu.type + '-' + lu.paperId + '-' + lu.qnos[0], type: lu.type, qids: lu.qids.slice(), paperId: lu.paperId, label: lu.label, done: false, minutes: 0 });
        lu.qids.forEach(function (id) { planIds[id] = 1; });
        acc += lu.min;
        break;
      }
    }
    while (acc < target && i < units.length) {
      var u = units[i++];
      var allSeen = u.qids.every(function (id) { return state.papers[id]; });
      if (allSeen) continue;
      if (u.qids.some(function (id) { return planIds[id]; })) continue; // 今日复习已含
      if (u.min > cap - acc) break; // 超上限，今天到此为止
      items.push({ key: 'new-' + u.type + '-' + u.paperId + '-' + u.qnos[0], type: u.type, qids: u.qids.slice(), paperId: u.paperId, label: u.label, done: false, minutes: 0 });
      u.qids.forEach(function (id) { planIds[id] = 1; });
      acc += u.min;
    }
    // N-SEC-3：兜底——没有任何题可练的组不进清单（写译组 qids 本来就为空，保留）
    items = items.filter(function (it) {
      return (it.qids && it.qids.length) || it.type === 'writing' || it.type === 'translation';
    });
    return { date: dateStr, v: CORE.PLAN_VERSION, items: items };
  };
  function C_findQno(banks, qid) {
    var q = CORE.findQ(banks, qid);
    return q ? q.qno : 0;
  }

  // 加练：抽出该题型下一个未做完的完整单元
  CORE.extraGroup = function (state, banks, dateStr, type) {
    var planIds = {};
    (state.plan && state.plan.items || []).forEach(function (it) { (it.qids || []).forEach(function (id) { planIds[id] = 1; }); });
    var units = CORE.unitsOf(banks);
    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.type !== type) continue;
      if (u.qids.every(function (id) { return state.papers[id]; })) continue;
      if (u.qids.some(function (id) { return planIds[id]; })) continue;
      return { key: 'extra-' + type + '-' + Date.now(), type: type, qids: u.qids.slice(), paperId: u.paperId, label: u.label, done: false, minutes: 0, extra: true };
    }
    return null;
  };

  // ---------- 统计 ----------
  CORE.streak = function (history, todayStr) {
    var s = 0, d = todayStr;
    var th = history[todayStr];
    if (!th || !(th.done || th.floor)) d = CORE.addDays(todayStr, -1); // 今天还没打卡，从昨天数
    while (true) {
      var h = history[d];
      if (h && (h.done || h.floor)) { s++; d = CORE.addDays(d, -1); }
      else break;
    }
    return s;
  };
  CORE.heatmap = function (history, todayStr, days) {
    days = days || 84;
    var out = [];
    for (var i = days - 1; i >= 0; i--) {
      var d = CORE.addDays(todayStr, -i);
      var h = history[d];
      out.push({ date: d, minutes: h ? h.minutes : 0, done: !!(h && (h.done || h.floor)), floor: !!(h && h.floor) });
    }
    return out;
  };
  CORE.accuracyByType = function (state) {
    var by = {};
    Object.keys(state.papers).forEach(function (qid) {
      var st = state.papers[qid];
      if (!st) return; // 脏存档兜底：papers 里值为空则不计入
      var type = qid.split('-')[1] === 'l' ? 'listening' : (qid.split('-')[1] === 'c' ? 'cloze' : (qid.split('-')[1] === 'm' ? 'match' : 'reading'));
      // id 形如 2026-06-1-l-3
      var parts = qid.split('-');
      var t = parts[3] === 'l' ? 'listening' : (parts[3] === 'c' ? 'cloze' : (parts[3] === 'm' ? 'match' : 'reading'));
      by[t] = by[t] || { seen: 0, right: 0 };
      by[t].seen += st.seen; by[t].right += st.right;
    });
    return by;
  };

  // ---------- 存取 ----------
  CORE.STORAGE_KEY = 'cet6_p1_state_v1';
  // P2-b：最近一次 normalizeState 在高亮恢复上截断掉的处数 { total, pids }（非持久化，仅本次载入有效）
  CORE.hlTruncatedOnLoad = { total: 0, pids: {} };
  // 多账号：每个手机号一个独立存档，数据保存在各自设备本地
  CORE.stateKey = function (phone) { return CORE.STORAGE_KEY + '_' + phone; };
  CORE.loadState = function (storage, key, banks) {
    try {
      var raw = storage.getItem(key || CORE.STORAGE_KEY);
      if (!raw) return CORE.newState();
      var s = JSON.parse(raw);
      if (!s.version) return CORE.newState();
      // 迁移：旧版错题条目补自适应字段（按原 box 阶梯推算 iv）
      if (s.wrongbook && typeof s.wrongbook === 'object' && !Array.isArray(s.wrongbook)) {
        Object.keys(s.wrongbook).forEach(function (qid) {
          var wb = s.wrongbook[qid];
          if (!wb || typeof wb !== 'object') return; // 脏存档：值为 null / 标量时跳过，不再抛错后整份状态被静默重置
          if (wb.ease === undefined) wb.ease = 2.5;
          if (wb.streak === undefined) wb.streak = 0;
          if (wb.iv === undefined) wb.iv = CORE.INTERVALS[Math.min(wb.box || 0, CORE.INTERVALS.length - 1)];
        });
      }
      return CORE.normalizeState(s, banks);
    } catch (e) { return CORE.newState(); }
  };
  CORE.newState = function () {
    return { version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {} };
  };
  CORE.saveState = function (storage, state, key) {
    storage.setItem(key || CORE.STORAGE_KEY, JSON.stringify(state));
  };

  // 考点维度正确率：按每题 points 标签聚合（历史做题记录，不新增练习量）
  // 按需加载：points 优先取 papers 里的快照（做题时写入，与加载状态无关），
  // 旧存档无快照时回退 findQ（已加载卷）或 qMeta（meta 骨架也能查）。
  CORE.accuracyByPoint = function (state, banks, meta) {
    var by = {};
    Object.keys(state.papers).forEach(function (qid) {
      var st = state.papers[qid];
      if (!st) return; // 脏存档兜底
      var points = null;
      if (Array.isArray(st.points) && st.points.length) points = st.points;
      else {
        var q = CORE.findQ(banks, qid);
        if (q && Array.isArray(q.points)) points = q.points;
        else if (meta) { var qm = CORE.qMeta(meta, qid); if (qm && Array.isArray(qm.points)) points = qm.points; }
      }
      if (!points) return;
      points.forEach(function (pt) {
        by[pt] = by[pt] || { seen: 0, right: 0 };
        by[pt].seen += st.seen; by[pt].right += st.right;
      });
    });
    return by;
  };

  // ---------- P3 估分与薄弱点专项 ----------
  // CET6 满分 710：听力 248.5（35%）、阅读 248.5（35%，= 选词 35.5 + 匹配 71 + 阅读 142）、写作 106.5、翻译 106.5
  CORE.SCORE_WEIGHT = { listening: 248.5, cloze: 35.5, match: 71, reading: 142, writing: 106.5, translation: 106.5 };
  // P0-b（第三轮）：客观题满分（听力+选词+匹配+阅读 = 248.5+35.5+71+142）与写译满分（106.5+106.5）
  CORE.SCORE_OBJ_MAX = 497;
  CORE.SCORE_WT_MAX = 213;
  /* P0-b（第三轮）：写译的保守档次映射。
     真实 CET6 的写作与翻译是"常模参照"的档次评分——阅卷先定档次再给分，另有字数/跑题/书写等扣分项，
     实测普遍低于同一名考生的客观题正确率。旧实现让写译也吃客观题正确率，总分因此被系统性高估 20~40 分。
     没有写译评分记录时按下面四档保守折算。 */
  CORE.WT_TIERS = [
    { min: 0.80, rate: 0.70, label: '客观题正确率 ≥80% → 写译按 70% 档' },
    { min: 0.60, rate: 0.60, label: '客观题正确率 60–80% → 写译按 60% 档' },
    { min: 0.40, rate: 0.50, label: '客观题正确率 40–60% → 写译按 50% 档' },
    { min: -1, rate: 0.40, label: '客观题正确率 <40% → 写译按 40% 档' }
  ];
  CORE.wtTier = function (objRate) {
    for (var i = 0; i < CORE.WT_TIERS.length; i++) {
      if (objRate >= CORE.WT_TIERS[i].min) return CORE.WT_TIERS[i];
    }
    return CORE.WT_TIERS[CORE.WT_TIERS.length - 1];
  };
  /* 写译估分：优先用 state.essays 里的评分记录（rate，0~1，写作/翻译各一条，有则取平均），
     没有评分记录时退回上面的保守档。返回值带 conservative 标志与 label，供 UI 如实标注"保守估算"。 */
  CORE.writeTransEstimate = function (state, objRate) {
    var es = (state && state.essays) || {};
    var rs = [], names = [];
    ['writing', 'translation'].forEach(function (k) {
      var e = es[k];
      if (e && typeof e.rate === 'number' && isFinite(e.rate)) {
        rs.push(Math.min(1, Math.max(0, e.rate)));
        names.push(k === 'writing' ? '写作' : '翻译');
      }
    });
    var rate, conservative, source, label;
    if (rs.length) {
      rate = rs.reduce(function (a, b) { return a + b; }, 0) / rs.length;
      conservative = false; source = 'recorded';
      label = '写译按你的评分记录估算（' + names.join('+') + ' 平均）';
    } else {
      var tier = CORE.wtTier(objRate);
      rate = tier.rate; conservative = true; source = 'tier';
      label = '写译按保守档估算（' + tier.label + '）';
    }
    return { rate: rate, score: Math.round(rate * CORE.SCORE_WT_MAX * 10) / 10, max: CORE.SCORE_WT_MAX,
      conservative: conservative, source: source, label: label };
  };
  /* 估分（P0-b 修正）：总分 = 客观题得分 + 写译估分，不再把整体归一化到 710。
     客观题得分 = 加权正确率 × 497（未练的客观题型按同水平外推，这部分口径与旧实现一致）；
     写译估分   = 213 × 写译得分率（无实测记录则走保守档）。
     旧式子 (客观加权得分 / 已练权重) × 710 等价于把写译也按客观题正确率外推 —— 高估就是这么来的。 */
  CORE.estimateScore = function (state, banks) {
    var acc = CORE.accuracyByType(state);
    var got = 0, full = 0, parts = [];
    ['listening', 'cloze', 'match', 'reading'].forEach(function (t) {
      var w = CORE.SCORE_WEIGHT[t], a = acc[t];
      if (a && a.seen) {
        full += w; // 分母只累计练过的部分，未练部分视为同水平外推
        var rate = a.right / a.seen;
        got += rate * w;
        parts.push({ type: t, zh: CORE.TYPE_META[t].zh, w: w, seen: a.seen, rate: rate });
      }
    });
    var covered = full > 0;
    var objRate = covered ? got / full : 0;                              // 客观题加权得分率
    var objScore = Math.round(objRate * CORE.SCORE_OBJ_MAX * 10) / 10;   // 客观题得分
    var wt = CORE.writeTransEstimate(state, objRate);                    // 写译估分（保守档或实测）
    var score = covered ? Math.round(objScore + wt.score) : 0;
    return { score: score, covered: covered, parts: parts,
      objScore: objScore, objRate: objRate, objMax: CORE.SCORE_OBJ_MAX,
      writeTransEstimate: wt };
  };
  // 最薄弱考点：练过 ≥ minSeen 题且正确率最低（并列时取做题多者，更可信）
  // 按需加载：meta 参数透传给 accuracyByPoint，未加载卷的考点也能聚合
  CORE.weakestPoint = function (state, banks, minSeen, meta) {
    minSeen = minSeen || 3;
    var by = CORE.accuracyByPoint(state, banks, meta);
    var best = null;
    Object.keys(by).forEach(function (pt) {
      var a = by[pt];
      if (a.seen < minSeen) return;
      var rate = a.right / a.seen;
      if (!best || rate < best.rate || (rate === best.rate && a.seen > best.seen)) {
        best = { pt: pt, seen: a.seen, right: a.right, rate: rate };
      }
    });
    return best;
  };
  // 含指定考点的全部题 ID（供专项练选题）；按需加载下支持 meta 骨架（qLite）
  CORE.pointIds = function (banks, pt) {
    var out = [];
    if (CORE.isFullBank(banks)) {
      banks.forEach(function (b) {
        (b.questions || []).forEach(function (q) {
          if ((q.points || []).indexOf(pt) >= 0) out.push(q.id);
        });
      });
      return out;
    }
    var papers = (banks && banks.papers) || {};
    Object.keys(papers).forEach(function (pid) {
      var p = papers[pid];
      (p && Array.isArray(p.qLite) ? p.qLite : []).forEach(function (q) {
        if ((q.points || []).indexOf(pt) >= 0) out.push(q.id);
      });
    });
    return out;
  };

  // ---------- 状态归一化（H-1：loadState / 导入 的唯一清洗入口）----------
  /* 为什么需要：state 里几乎每个字段最终都会进 innerHTML（统计卡、错题行、热力图 title…）。
     只要存档里混进一个字符串型数字，注入面就打开了。任何来源的 state（被篡改的
     localStorage、旧备份、手改的 JSON）都先过一遍这里：只保留已知字段、已知类型，
     数字一律 Number()+clamp、字符串一律限长、日期一律校验格式与真实日历，从根上掐掉脏数据。
     注意 plan：这里是"结构校验后保留"，不是无条件丢弃——plan 里带着今日清单的
     done 状态、断点续做的 draft 与计时器剩余秒数，每次载入都清空会让刷新即丢进度。
     结构不合法（items 不是数组等）或日期/版本不符时置 null，交给 ensurePlan 重算。
     N-SEC-3：第二个参数 banks 可选传入题库时，会同时过滤 plan.items[].qids 里题库已不存在的
     幽灵 qid，并删掉过滤后无题可做的组（否则 0 题组会让今日清单永远无法完成）；
     不传 banks（题库未加载全）时不删，与 index.html 侧 pruneGhosts 的口径一致。
     N-UI-3：judged/rightCount/answers/timeSpentSec 一并保留，使"已判分"能跨刷新存活。 */
  CORE.normalizeState = function (s, banks) {
    var st = CORE.newState();
    st.version = 1;
    var num = function (v) { v = Number(v); return isFinite(v) ? v : 0; };
    // N-SEC-7：数字一并 clamp 到合理区间（脏存档里的 -100 / 1e9 会扭曲统计、进度条与排序）
    var clamp = function (v, lo, hi) { var x = num(v); if (x < lo) x = lo; if (x > hi) x = hi; return x; };
    var isObj = function (o) { return !!o && typeof o === 'object' && !Array.isArray(o); };
    var str = function (v, n) { return String(v == null ? '' : v).slice(0, n); };
    // N-SEC-7：日期不只校验格式，还回读日历——2026-13-45 / 2026-02-30 这类"格式合法"的假日期会被拒
    var isDate = function (v) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
      var p = String(v).split('-').map(Number);
      var d = new Date(p[0], p[1] - 1, p[2]);
      return d.getFullYear() === p[0] && d.getMonth() === p[1] - 1 && d.getDate() === p[2];
    };
    var dateOr = function (v, fb) { return isDate(v) ? v : fb; };
    if (!isObj(s)) return st; // null / 数组 / 字符串存档：直接给一份全新状态，不抛异常
    // N-SEC-3：题库 id 集合（只有调用方传入完整题库时才用于过滤幽灵 qid——
    // 题库没加载全时宁可不删，与 index.html 侧 pruneGhosts 的 banksComplete 口径一致）
    var known = null;
    if (Array.isArray(banks) && banks.length) {
      known = {};
      banks.forEach(function (b) {
        ((b && b.questions) || []).forEach(function (q) { if (q && q.id) known[q.id] = 1; });
      });
    }
    // history: 只保留对象值，所有数字字段强制 Number()
    if (isObj(s.history)) {
      Object.keys(s.history).forEach(function (d) {
        var h = s.history[d]; if (!isObj(h)) return;
        if (!isDate(d)) return; // 日期键校验
        st.history[d] = { minutes: clamp(h.minutes, 0, 1e5), done: !!h.done, floor: !!h.floor,
          qCount: clamp(h.qCount, 0, 1e7), right: clamp(h.right, 0, 1e7), timed: clamp(h.timed, 0, 1e7),
          timedWithin: clamp(h.timedWithin, 0, 1e7), timedSec: clamp(h.timedSec, 0, 1e7) };
      });
    }
    // papers: 数字字段强制 Number，lastAnswer 限长；points 考点快照（按需加载统计用）保留并清洗
    if (isObj(s.papers)) {
      Object.keys(s.papers).forEach(function (q) {
        var p = s.papers[q]; if (!isObj(p)) return;
        st.papers[q] = { seen: clamp(p.seen, 0, 1e7), right: clamp(p.right, 0, 1e7), wrong: clamp(p.wrong, 0, 1e7),
          lastAt: dateOr(p.lastAt, ''), lastResult: p.lastResult === 'right' ? 'right' : 'wrong',
          lastAnswer: p.lastAnswer == null ? null : String(p.lastAnswer).slice(0, 40) };
        if (Array.isArray(p.points)) {
          var pts = p.points.filter(function (x) { return typeof x === 'string' && x.length <= 40; }).slice(0, 8);
          if (pts.length) st.papers[q].points = pts;
        }
      });
    }
    // wrongbook: 数字字段归一化，due 格式校验（题库里不存在的 qid 由 index.html 侧清理，core 不依赖题库）
    if (isObj(s.wrongbook)) {
      Object.keys(s.wrongbook).forEach(function (q) {
        var w = s.wrongbook[q]; if (!isObj(w)) return;
        st.wrongbook[q] = { addedAt: dateOr(w.addedAt, CORE.todayStr()), box: clamp(w.box, 0, 100),
          wrongCount: clamp(w.wrongCount, 0, 1e6),
          due: dateOr(w.due, CORE.todayStr()),
          ease: Math.min(2.8, Math.max(1.3, num(w.ease) || 2.5)), iv: clamp(num(w.iv) || 1, 1, 3650),
          streak: clamp(w.streak, 0, 1e6) };
      });
    }
    // essays: 只保留字符串，限长 20000
    // P0-b：rate = 写译自评分（0~1，可选）。旧存档没有这个字段；一旦有（自评/导入备份），
    // 估分就走实测而不是保守档，所以这里必须保留，否则它会被清洗掉、永远用不上。
    st.essays = {};
    ['writing', 'translation'].forEach(function (k) {
      var e = s.essays && s.essays[k];
      if (e && typeof e === 'object' && typeof e.text === 'string') {
        st.essays[k] = { lastAt: dateOr(e.lastAt, ''), text: e.text.slice(0, 20000) };
        if (typeof e.rate === 'number' && isFinite(e.rate)) st.essays[k].rate = Math.min(1, Math.max(0, e.rate));
      }
    });
    // hl: 只保留 pid->字符串数组
    // P2-b（第三轮）：这里的 slice(0,50) 是"加载路径"的静默截断——交互路径（index.html 的 saveHl）
    // 有 toast 提示，恢复路径以前没有，用户会觉得高亮"刷新后自己少了"。截断量记在
    // CORE.hlTruncatedOnLoad 上，由 index.html 在启动/渲染该段时给出非阻塞提示。
    st.hl = {};
    var hlCut = 0, hlCutPids = {};
    if (isObj(s.hl)) {
      Object.keys(s.hl).forEach(function (pid) {
        var a = s.hl[pid];
        if (Array.isArray(a)) {
          var ok = a.filter(function (x) { return typeof x === 'string'; });
          var b = ok.slice(0, 50).map(function (x) { return x.slice(0, 200); });
          if (b.length) st.hl[pid] = b;
          if (ok.length > 50) { hlCut += ok.length - 50; hlCutPids[pid] = ok.length - 50; }
        }
      });
    }
    CORE.hlTruncatedOnLoad = { total: hlCut, pids: hlCutPids };
    // plan: 结构合法才保留（日期/版本在 ensurePlan 里还会再校验一次），否则置 null 强制重算
    st.plan = null;
    if (isObj(s.plan) && Array.isArray(s.plan.items)) {
      var items = [];
      s.plan.items.forEach(function (it) {
        if (!isObj(it)) return;
        var qids = Array.isArray(it.qids) ? it.qids.filter(function (x) { return typeof x === 'string' && x.length <= 64; }).slice(0, 60) : [];
        // N-SEC-3：与 wrongbook 同口径过滤幽灵 qid（旧备份/跨版本题库残留的题号）
        if (known) qids = qids.filter(function (id) { return known[id]; });
        var type = str(it.type, 24);
        var isEssay = type === 'writing' || type === 'translation';
        // N-SEC-3：过滤后无题可做的组直接删除——否则渲染出"0 题组"、提交按钮永远禁用，今日清单死锁。
        // 写译组本来就没有 qids（整组就一个题面），不能当空组丢掉。
        if (known && !qids.length && !isEssay) return;
        var o = { key: str(it.key, 120), type: type, qids: qids,
          paperId: str(it.paperId, 24), label: str(it.label, 120),
          done: !!it.done, minutes: clamp(it.minutes, 0, 1e5) };
        if (it.review) o.review = true;
        if (it.extra) o.extra = true;
        if (it.isWrong) o.isWrong = true;
        if (it.isPoint) o.isPoint = true;
        if (it.timerLeft != null) o.timerLeft = clamp(it.timerLeft, 0, 1e6);
        // 考场用时（判分/写译完成时记在条目上）：保留才能让刷新后的结果卡显示"用时/是否达标"
        if (it.timeSpentSec != null) o.timeSpentSec = clamp(it.timeSpentSec, 0, 1e6);
        if (it.withinTime != null) o.withinTime = !!it.withinTime;
        if (isObj(it.draft)) { // 断点续做草稿：{qid: 'A'} 形状，逐项限长
          var dr = {};
          Object.keys(it.draft).slice(0, 60).forEach(function (k) {
            var v = it.draft[k];
            if (typeof v === 'string' && k.length <= 64) dr[k.slice(0, 64)] = v.slice(0, 8);
          });
          if (Object.keys(dr).length) o.draft = dr;
        }
        // N-UI-3：已判分状态与判分结果（你选了哪项、答对几题）随 plan 持久化，
        // 刷新后恢复判分结果视图，而不是退回"可再次提交"状态导致重复判分。
        if (it.judged) {
          o.judged = true;
          o.rightCount = clamp(it.rightCount, 0, 1e3);
          var ans = {};
          if (isObj(it.answers)) {
            Object.keys(it.answers).slice(0, 60).forEach(function (k) {
              var av = it.answers[k];
              if (typeof av === 'string' && k.length <= 64) ans[k.slice(0, 64)] = av.slice(0, 8);
            });
          }
          o.answers = ans;
        }
        items.push(o);
      });
      st.plan = { date: dateOr(s.plan.date, ''), v: clamp(s.plan.v, 0, 1e6), items: items };
    }
    st.lastBackup = dateOr(s.lastBackup, '');
    return st;
  };

  // ---------- 判题 ----------
  CORE.judge = function (q, answer) {
    if (q.type === 'match') return answer === q.answer;
    return answer === q.answer;
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = CORE; }
  else { root.CET6Core = CORE; }
})(typeof window !== 'undefined' ? window : globalThis);
