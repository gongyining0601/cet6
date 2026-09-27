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
  // 多账号：每个手机号一个独立存档，数据保存在各自设备本地
  CORE.stateKey = function (phone) { return CORE.STORAGE_KEY + '_' + phone; };
  CORE.loadState = function (storage, key) {
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
      return CORE.normalizeState(s);
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
      if (!st) return; // 脏存档兜底
      var q = CORE.findQ(banks, qid);
      if (!q || !q.points) return;
      q.points.forEach(function (pt) {
        by[pt] = by[pt] || { seen: 0, right: 0 };
        by[pt].seen += st.seen; by[pt].right += st.right;
      });
    });
    return by;
  };

  // ---------- P3 估分与薄弱点专项 ----------
  // CET6 满分 710：听力 248.5（35%）、阅读 248.5（35%，= 选词 35.5 + 匹配 71 + 阅读 142）、写作 106.5、翻译 106.5
  CORE.SCORE_WEIGHT = { listening: 248.5, cloze: 35.5, match: 71, reading: 142, writing: 106.5, translation: 106.5 };
  // 估算分：按已练客观题型的得分率×权重折算，未练部分按同水平外推到 710（写译为主观题无客观判分，不参与）
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
    var score = full > 0 ? Math.round(got / full * 710) : 0;
    return { score: score, covered: full > 0, parts: parts };
  };
  // 最薄弱考点：练过 ≥ minSeen 题且正确率最低（并列时取做题多者，更可信）
  CORE.weakestPoint = function (state, banks, minSeen) {
    minSeen = minSeen || 3;
    var by = CORE.accuracyByPoint(state, banks);
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
  // 含指定考点的全部题 ID（供专项练选题）
  CORE.pointIds = function (banks, pt) {
    var out = [];
    banks.forEach(function (b) {
      (b.questions || []).forEach(function (q) {
        if ((q.points || []).indexOf(pt) >= 0) out.push(q.id);
      });
    });
    return out;
  };

  // ---------- 状态归一化（H-1：loadState / 导入 的唯一清洗入口）----------
  /* 为什么需要：state 里几乎每个字段最终都会进 innerHTML（统计卡、错题行、热力图 title…）。
     只要存档里混进一个字符串型数字，注入面就打开了。任何来源的 state（被篡改的
     localStorage、旧备份、手改的 JSON）都先过一遍这里：只保留已知字段、已知类型，
     数字一律 Number()、字符串一律限长、日期一律校验格式，从根上掐掉脏数据。
     注意 plan：这里是"结构校验后保留"，不是无条件丢弃——plan 里带着今日清单的
     done 状态、断点续做的 draft 与计时器剩余秒数，每次载入都清空会让刷新即丢进度。
     结构不合法（items 不是数组等）或日期/版本不符时置 null，交给 ensurePlan 重算。 */
  CORE.normalizeState = function (s) {
    var st = CORE.newState();
    st.version = 1;
    var num = function (v) { v = Number(v); return isFinite(v) ? v : 0; };
    var isObj = function (o) { return !!o && typeof o === 'object' && !Array.isArray(o); };
    var str = function (v, n) { return String(v == null ? '' : v).slice(0, n); };
    if (!isObj(s)) return st; // null / 数组 / 字符串存档：直接给一份全新状态，不抛异常
    // history: 只保留对象值，所有数字字段强制 Number()
    if (isObj(s.history)) {
      Object.keys(s.history).forEach(function (d) {
        var h = s.history[d]; if (!isObj(h)) return;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return; // 日期键校验
        st.history[d] = { minutes: num(h.minutes), done: !!h.done, floor: !!h.floor,
          qCount: num(h.qCount), right: num(h.right), timed: num(h.timed),
          timedWithin: num(h.timedWithin), timedSec: num(h.timedSec) };
      });
    }
    // papers: 数字字段强制 Number，lastAnswer 限长
    if (isObj(s.papers)) {
      Object.keys(s.papers).forEach(function (q) {
        var p = s.papers[q]; if (!isObj(p)) return;
        st.papers[q] = { seen: num(p.seen), right: num(p.right), wrong: num(p.wrong),
          lastAt: str(p.lastAt, 10), lastResult: p.lastResult === 'right' ? 'right' : 'wrong',
          lastAnswer: p.lastAnswer == null ? null : String(p.lastAnswer).slice(0, 40) };
      });
    }
    // wrongbook: 数字字段归一化，due 格式校验（题库里不存在的 qid 由 index.html 侧清理，core 不依赖题库）
    if (isObj(s.wrongbook)) {
      Object.keys(s.wrongbook).forEach(function (q) {
        var w = s.wrongbook[q]; if (!isObj(w)) return;
        st.wrongbook[q] = { addedAt: str(w.addedAt, 10), box: num(w.box), wrongCount: num(w.wrongCount),
          due: /^\d{4}-\d{2}-\d{2}$/.test(w.due) ? w.due : CORE.todayStr(),
          ease: Math.min(2.8, Math.max(1.3, num(w.ease) || 2.5)), iv: Math.max(1, num(w.iv) || 1),
          streak: num(w.streak) };
      });
    }
    // essays: 只保留字符串，限长 20000
    st.essays = {};
    ['writing', 'translation'].forEach(function (k) {
      var e = s.essays && s.essays[k];
      if (e && typeof e === 'object' && typeof e.text === 'string')
        st.essays[k] = { lastAt: str(e.lastAt, 10), text: e.text.slice(0, 20000) };
    });
    // hl: 只保留 pid->字符串数组
    st.hl = {};
    if (isObj(s.hl)) {
      Object.keys(s.hl).forEach(function (pid) {
        var a = s.hl[pid];
        if (Array.isArray(a)) { var b = a.filter(function(x){return typeof x==='string';}).slice(0,50).map(function(x){return x.slice(0,200);}); if (b.length) st.hl[pid] = b; }
      });
    }
    // plan: 结构合法才保留（日期/版本在 ensurePlan 里还会再校验一次），否则置 null 强制重算
    st.plan = null;
    if (isObj(s.plan) && Array.isArray(s.plan.items)) {
      var items = [];
      s.plan.items.forEach(function (it) {
        if (!isObj(it)) return;
        var qids = Array.isArray(it.qids) ? it.qids.filter(function (x) { return typeof x === 'string' && x.length <= 64; }).slice(0, 60) : [];
        var o = { key: str(it.key, 120), type: str(it.type, 24), qids: qids,
          paperId: str(it.paperId, 24), label: str(it.label, 120),
          done: !!it.done, minutes: num(it.minutes) };
        if (it.review) o.review = true;
        if (it.extra) o.extra = true;
        if (it.isWrong) o.isWrong = true;
        if (it.isPoint) o.isPoint = true;
        if (it.timerLeft != null) o.timerLeft = num(it.timerLeft);
        if (isObj(it.draft)) { // 断点续做草稿：{qid: 'A'} 形状，逐项限长
          var dr = {};
          Object.keys(it.draft).slice(0, 60).forEach(function (k) {
            var v = it.draft[k];
            if (typeof v === 'string' && k.length <= 64) dr[k.slice(0, 64)] = v.slice(0, 8);
          });
          if (Object.keys(dr).length) o.draft = dr;
        }
        items.push(o);
      });
      st.plan = { date: /^\d{4}-\d{2}-\d{2}$/.test(s.plan.date) ? s.plan.date : '', v: num(s.plan.v), items: items };
    }
    st.lastBackup = typeof s.lastBackup === 'string' ? s.lastBackup.slice(0, 10) : '';
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
