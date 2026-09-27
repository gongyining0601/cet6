/* CET6 打卡应用 · 核心逻辑（纯函数，可在 Node 中测试）
   数据结构：
   state = {
     version: 1,
     history: { 'YYYY-MM-DD': { minutes: 0, done: false, floor: false, qCount: 0, right: 0 } },
     papers: { qid: { seen: n, wrong: n, right: n, lastAt: 'date', lastResult: 'right'|'wrong' } },
     wrongbook: { qid: { addedAt, box: n, due: 'YYYY-MM-DD', wrongCount: n } },
     plan: { date: 'YYYY-MM-DD', items: [ {key, type, qids, done, minutes} ] },
     essays: { 'writing': {lastAt, text}, 'translation': {...} }  // 最近一次作文/翻译草稿
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
  // 记录一题结果：更新 papers / wrongbook
  CORE.recordResult = function (state, qid, correct, dateStr) {
    var st = state.papers[qid] || (state.papers[qid] = { seen: 0, wrong: 0, right: 0 });
    st.seen++; st.lastAt = dateStr; st.lastResult = correct ? 'right' : 'wrong';
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
      if (CORE.dayDiff(state.wrongbook[qid].due, dateStr) >= 0) out.push(qid);
    });
    return out;
  };
  CORE.allWrongIds = function (state) { return Object.keys(state.wrongbook); };
  // 智能复习队列：到期错题按（逾期天数 > 错次 > ease 低）排序，越薄弱越靠前
  CORE.reviewQueue = function (state, banks, dateStr, limit) {
    var qids = [];
    Object.keys(state.wrongbook).forEach(function (qid) { qids.push(qid); });
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
    var ids = Object.keys(state.wrongbook), due = 0, overdue = 0, maxOver = 0, ivSum = 0;
    ids.forEach(function (qid) {
      var wb = state.wrongbook[qid];
      var od = CORE.dayDiff(wb.due, dateStr); // 逾期天数（正=已逾期）
      if (od >= 0) due++;
      if (od > 0) { overdue++; if (od > maxOver) maxOver = od; }
      ivSum += (wb.iv || 1);
    });
    return { total: ids.length, due: due, overdue: overdue, maxOverdue: maxOver, avgIv: ids.length ? Math.round(ivSum / ids.length) : 0 };
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
  CORE.genPlan = function (state, banks, dateStr) {
    var items = [];
    var planIds = {};
    // 1) 到期错题复习组（封顶 REVIEW_CAP 分钟；同卷同题型相邻打包保持语境完整）
    var reviewMin = 0;
    var groups = [];
    CORE.reviewQueue(state, banks, dateStr).forEach(function (qid) {
      var q = CORE.findQ(banks, qid);
      var paper = CORE.findPaper(banks, qid);
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
        return C_findQno(banks, a) - C_findQno(banks, b);
      });
      items.push({ key: 'review-' + g.type + '-' + g.paperId, type: g.type, qids: g.qids, paperId: g.paperId, label: '错题复习·' + CORE.TYPE_META[g.type].zh + ' ' + g.qids.length + '题', done: false, minutes: 0, review: true });
    });
    // 2) 周六写译一篇（占当日额度；选卷与新题推进同卷——最近考期优先的第一个未完成单元所在卷）
    var target = CORE.PLAN_TARGET, cap = CORE.PLAN_CAP;
    var dParts = dateStr.split('-').map(Number);
    var dow = new Date(dParts[0], dParts[1] - 1, dParts[2]).getDay();
    var units = CORE.unitList(banks);
    if (dow === 6) {
      var weekIdx = Math.floor(CORE.dayDiff('2020-01-04', dateStr) / 7); // 2020-01-04 为周六锚点
      var wtype = weekIdx % 2 === 0 ? 'writing' : 'translation';
      var wp = CORE.paperOrder(banks)[0];
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
    var units = CORE.unitList(banks);
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
  // 多账号：每个手机号一个独立存档，数据保存在各自设备本地
  CORE.stateKey = function (phone) { return CORE.STORAGE_KEY + '_' + phone; };
  CORE.loadState = function (storage, key) {
    try {
      var raw = storage.getItem(key || CORE.STORAGE_KEY);
      if (!raw) return CORE.newState();
      var s = JSON.parse(raw);
      if (!s.version) return CORE.newState();
      // 迁移：旧版错题条目补自适应字段（按原 box 阶梯推算 iv）
      if (s.wrongbook) {
        Object.keys(s.wrongbook).forEach(function (qid) {
          var wb = s.wrongbook[qid];
          if (wb.ease === undefined) wb.ease = 2.5;
          if (wb.streak === undefined) wb.streak = 0;
          if (wb.iv === undefined) wb.iv = CORE.INTERVALS[Math.min(wb.box || 0, CORE.INTERVALS.length - 1)];
        });
      }
      return s;
    } catch (e) { return CORE.newState(); }
  };
  CORE.newState = function () {
    return { version: 1, history: {}, papers: {}, wrongbook: {}, plan: null, essays: {} };
  };
  CORE.saveState = function (storage, state, key) {
    storage.setItem(key || CORE.STORAGE_KEY, JSON.stringify(state));
  };

  // 考点维度正确率：按每题 points 标签聚合（历史做题记录，不新增练习量）
  CORE.accuracyByPoint = function (state, banks) {
    var by = {};
    Object.keys(state.papers).forEach(function (qid) {
      var st = state.papers[qid];
      var q = CORE.findQ(banks, qid);
      if (!q || !q.points) return;
      q.points.forEach(function (pt) {
        by[pt] = by[pt] || { seen: 0, right: 0 };
        by[pt].seen += st.seen; by[pt].right += st.right;
      });
    });
    return by;
  };

  // ---------- 判题 ----------
  CORE.judge = function (q, answer) {
    if (q.type === 'match') return answer === q.answer;
    return answer === q.answer;
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = CORE; }
  else { root.CET6Core = CORE; }
})(typeof window !== 'undefined' ? window : globalThis);
