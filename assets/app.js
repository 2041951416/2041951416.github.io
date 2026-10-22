/* ============================================================
   共享逻辑：取数、状态、进度、日历、Gist 同步
   无依赖、无构建。全局暴露 window.Blog。
   ============================================================ */
(function () {
  "use strict";

  var LS = {
    theme: "blog.theme",
    pat: "blog.pat",
    gistId: "blog.gistId",
    state: "blog.state",
    // 编辑凭证独立存放：blog.pat 是 classic + gist scope，只用于进度同步。
    // 混用会让编辑器静默失败，也会扩大 gist token 的权限。
    editPat: "blog.editPat",
  };
  var STATE_FILE = "blog-plan-state.json";
  var SCHEMA = 1;

  /* ---------- 基础工具 ---------- */

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /** 转义，用于拼进 innerHTML 的少量场景 */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var args = arguments,
        self = this;
      clearTimeout(t);
      t = setTimeout(function () {
        fn.apply(self, args);
      }, ms);
    };
  }

  /* ---------- 日期（全部本地时区，避免 UTC 跨日偏移） ---------- */

  function ymd(d) {
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function today() {
    return ymd(new Date());
  }

  function parseYmd(s) {
    var p = String(s).split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }

  function addDays(s, n) {
    var d = parseYmd(s);
    d.setDate(d.getDate() + n);
    return ymd(d);
  }

  function daysBetween(a, b) {
    return Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
  }

  function fmtDate(s) {
    if (!s) return "";
    var p = String(s).split("-");
    return p[1].replace(/^0/, "") + " 月 " + p[2].replace(/^0/, "") + " 日";
  }

  function fmtDateFull(s) {
    if (!s) return "";
    var p = String(s).split("-");
    return p[0] + " 年 " + p[1].replace(/^0/, "") + " 月 " + p[2].replace(/^0/, "") + " 日";
  }

  /* ---------- 取数 ---------- */

  function getJson(path) {
    return fetch(path, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(path + " 加载失败（HTTP " + r.status + "）");
      return r.json();
    });
  }

  function getText(path) {
    return fetch(path, { cache: "no-cache" }).then(function (r) {
      if (!r.ok) throw new Error(path + " 加载失败（HTTP " + r.status + "）");
      return r.text();
    });
  }

  /** 去掉 front matter，返回 { meta, body } */
  function splitFrontMatter(raw) {
    var text = String(raw).replace(/^﻿/, "");
    var m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (!m) return { meta: {}, body: text };
    var meta = {};
    m[1].split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(":");
      if (i < 0) return;
      var k = line.slice(0, i).trim();
      var v = line.slice(i + 1).trim();
      if (!k) return;
      if (k === "tags") {
        meta.tags = v
          .split(",")
          .map(function (t) {
            return t.trim();
          })
          .filter(Boolean);
      } else {
        meta[k] = v;
      }
    });
    return { meta: meta, body: text.slice(m[0].length) };
  }

  /* ---------- 学习路线 ---------- */

  var planCache = null;
  function loadPlan() {
    if (planCache) return Promise.resolve(planCache);
    return getJson("content/plan.json").then(function (p) {
      planCache = p;
      return p;
    });
  }

  function allTasks(plan) {
    var out = [];
    (plan.phases || []).forEach(function (ph) {
      (ph.tasks || []).forEach(function (t) {
        out.push({ phase: ph, task: t });
      });
    });
    return out;
  }

  /* ---------- 状态 ---------- */

  function emptyState() {
    return {
      schema: SCHEMA,
      updatedAt: null,
      done: {},
      checkins: {},
      profile: { startDate: today() },
    };
  }

  function normalizeState(raw) {
    var s = emptyState();
    if (!raw || typeof raw !== "object") return s;

    if (raw.done && typeof raw.done === "object") {
      Object.keys(raw.done).forEach(function (k) {
        var v = raw.done[k];
        // 兼容 old 格式（true）与 new 格式（日期字符串）
        if (v === true) s.done[k] = "";
        else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) s.done[k] = v;
      });
    }
    if (raw.checkins && typeof raw.checkins === "object") {
      Object.keys(raw.checkins).forEach(function (k) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(k) && raw.checkins[k]) s.checkins[k] = true;
      });
    }
    if (raw.profile && typeof raw.profile === "object" && raw.profile.startDate) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw.profile.startDate)) {
        s.profile.startDate = raw.profile.startDate;
      }
    }
    if (raw.updatedAt) s.updatedAt = raw.updatedAt;
    s.updatedAt = raw.updatedAt || null;
    return s;
  }

  function readLocal() {
    try {
      return normalizeState(JSON.parse(localStorage.getItem(LS.state) || "null"));
    } catch (e) {
      return emptyState();
    }
  }

  function writeLocal(state) {
    try {
      localStorage.setItem(LS.state, JSON.stringify(state));
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 并集合并。绝不 last-write-wins —— 那会丢打卡记录。
   * done: key 并集，重复时保留更早的完成日期
   * checkins: 日期并集
   * startDate: 取更早的
   */
  function mergeState(a, b) {
    var A = normalizeState(a);
    var B = normalizeState(b);
    var out = emptyState();

    var keys = Object.keys(A.done).concat(Object.keys(B.done));
    keys.forEach(function (k) {
      var da = A.done[k];
      var db = B.done[k];
      if (da === undefined) out.done[k] = db;
      else if (db === undefined) out.done[k] = da;
      else if (!da) out.done[k] = db;
      else if (!db) out.done[k] = da;
      else out.done[k] = da < db ? da : db;
    });

    Object.keys(A.checkins).forEach(function (d) {
      out.checkins[d] = true;
    });
    Object.keys(B.checkins).forEach(function (d) {
      out.checkins[d] = true;
    });

    out.profile.startDate =
      A.profile.startDate < B.profile.startDate ? A.profile.startDate : B.profile.startDate;

    out.updatedAt = new Date().toISOString();
    return out;
  }

  /* ---------- 进度 ---------- */

  function phaseProgress(phase, done) {
    var tasks = phase.tasks || [];
    var n = 0;
    tasks.forEach(function (t) {
      if (done && done[t.id] !== undefined) n++;
    });
    return { done: n, total: tasks.length, pct: tasks.length ? (n / tasks.length) * 100 : 0 };
  }

  function overallProgress(plan, done) {
    var all = allTasks(plan);
    var n = 0;
    all.forEach(function (x) {
      if (done && done[x.task.id] !== undefined) n++;
    });
    return { done: n, total: all.length, pct: all.length ? (n / all.length) * 100 : 0 };
  }

  /** 连续打卡天数（含今天；今天没打卡则从昨天往前算） */
  function streak(checkins) {
    var d = today();
    if (!checkins[d]) d = addDays(d, -1);
    var n = 0;
    while (checkins[d]) {
      n++;
      d = addDays(d, -1);
    }
    return n;
  }

  /** 最近 n 天内的活动次数 */
  function recentCount(checkins, n) {
    var d = today();
    var c = 0;
    for (var i = 0; i < n; i++) {
      if (checkins[d]) c++;
      d = addDays(d, -1);
    }
    return c;
  }

  /**
   * 构建热力图数据：从 start 到 end，按周排列。
   * 返回 { days: [{date, level, dow}], weeks }
   */
  function calendarCells(start, end, counts) {
    var s = start;
    var e = end;
    if (s > e) {
      var t = s;
      s = e;
      e = t;
    }
    // 起始日对齐到周一
    var dowStart = (parseYmd(s).getDay() + 6) % 7; // 周一=0
    var begin = addDays(s, -dowStart);

    var cells = [];
    var cur = begin;
    var guard = 0;
    while (cur <= e && guard++ < 2000) {
      var c = counts[cur] || 0;
      cells.push({
        date: cur,
        dow: (parseYmd(cur).getDay() + 6) % 7,
        count: c,
        level: c === 0 ? 0 : c === 1 ? 1 : c === 2 ? 2 : 3,
        inRange: cur >= s && cur <= e,
      });
      cur = addDays(cur, 1);
    }
    // 补足最后一周
    var last = cells[cells.length - 1];
    if (last && last.dow !== 6) {
      for (var i = last.dow + 1; i < 7; i++) {
        cells.push({ date: null, dow: i, count: 0, level: 0, inRange: false });
      }
    }
    return cells;
  }

  /** 打卡次数（按完成日期聚合） */
  function countsFromDone(done) {
    var c = {};
    Object.keys(done || {}).forEach(function (k) {
      var d = done[k];
      if (d) c[d] = (c[d] || 0) + 1;
    });
    return c;
  }

  /* ---------- Gist 同步 ---------- */

  var GH = {
    api: "https://api.github.com",
    headers: function (pat) {
      return {
        Authorization: "Bearer " + pat,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      };
    },
  };

  function getPat() {
    try {
      return localStorage.getItem(LS.pat) || "";
    } catch (e) {
      return "";
    }
  }
  function setPat(v) {
    try {
      if (v) localStorage.setItem(LS.pat, v);
      else localStorage.removeItem(LS.pat);
    } catch (e) {}
  }
  function getGistId() {
    try {
      return localStorage.getItem(LS.gistId) || "";
    } catch (e) {
      return "";
    }
  }
  function setGistId(v) {
    try {
      if (v) localStorage.setItem(LS.gistId, v);
      else localStorage.removeItem(LS.gistId);
    } catch (e) {}
  }

  /* 编辑器凭证：与 gist token 分开存 */
  function getEditPat() {
    try {
      return localStorage.getItem(LS.editPat) || "";
    } catch (e) {
      return "";
    }
  }
  function setEditPat(v) {
    try {
      if (v) localStorage.setItem(LS.editPat, v);
      else localStorage.removeItem(LS.editPat);
    } catch (e) {}
  }

  function isSyncEnabled() {
    return !!(getPat() && getGistId());
  }

  function ghError(r, body) {
    if (r.status === 401) {
      return new Error(
        "Token 无效或已过期（401）。请在设置里重新粘贴 classic token。本地数据未受影响。"
      );
    }
    if (r.status === 403 || r.status === 429) {
      if (r.headers.get("x-ratelimit-remaining") === "0") {
        var reset = r.headers.get("x-ratelimit-reset");
        var when = reset ? new Date(+reset * 1000).toLocaleTimeString() : "稍后";
        return new Error("触发了 GitHub 限流，请在 " + when + " 之后重试。");
      }
      return new Error(
        "没有权限（403）。多半是 token 缺少 gist scope，或使用了细粒度 token（细粒度不支持 Gist）。"
      );
    }
    if (r.status === 404) {
      return new Error("找不到 gist（404）。它可能已被删除。");
    }
    return new Error("GitHub 返回 " + r.status + "：" + (body && body.message ? body.message : "未知错误"));
  }

  function gistRemoteState() {
    var id = getGistId();
    var pat = getPat();
    if (!id || !pat) return Promise.resolve({ state: null, raw: null, sha: null });
    return fetch(GH.api + "/gists/" + id, { headers: GH.headers(pat) })
      .then(function (r) {
        return r.text().then(function (txt) {
          var body = null;
          try {
            body = JSON.parse(txt);
          } catch (e) {}
          if (!r.ok) throw ghError(r, body);
          var f = body.files && body.files[STATE_FILE];
          if (!f || !f.content) return { state: null, raw: null, sha: body.id };
          var state = null;
          try {
            state = normalizeState(JSON.parse(f.content));
          } catch (e) {
            state = null;
          }
          return { state: state, raw: f.content, sha: body.id };
        });
      })
      .catch(function (e) {
        // gist 被删：清掉 id，下次保存会重建
        if (e.message.indexOf("404") >= 0) setGistId("");
        throw e;
      });
  }

  function gistSave(state) {
    var pat = getPat();
    if (!pat) return Promise.reject(new Error("尚未填写 token"));
    var payload = {
      files: {},
    };
    payload.files[STATE_FILE] = { content: JSON.stringify(state, null, 2) };

    var id = getGistId();
    if (!id) {
      payload.description = "blog-plan-state";
      payload.public = false;
      return fetch(GH.api + "/gists", {
        method: "POST",
        headers: GH.headers(pat),
        body: JSON.stringify(payload),
      }).then(function (r) {
        return r.text().then(function (txt) {
          var body = null;
          try {
            body = JSON.parse(txt);
          } catch (e) {}
          if (!r.ok) throw ghError(r, body);
          setGistId(body.id);
          return body;
        });
      });
    }

    return fetch(GH.api + "/gists/" + id, {
      method: "PATCH",
      headers: GH.headers(pat),
      body: JSON.stringify(payload),
    }).then(function (r) {
      return r.text().then(function (txt) {
        var body = null;
        try {
          body = JSON.parse(txt);
        } catch (e) {}
        if (r.status === 404) {
          setGistId(""); // 重建
          throw ghError(r, body);
        }
        if (!r.ok) throw ghError(r, body);
        return body;
      });
    });
  }

  /* ---------- 状态中心 ---------- */

  var state = readLocal();
  var listeners = [];
  var syncStatus = { mode: isSyncEnabled() ? "idle" : "off", message: "", at: null };
  var saveTimer = null;
  var dirty = false;

  function emit() {
    listeners.forEach(function (fn) {
      try {
        fn(state, syncStatus);
      } catch (e) {
        console.error(e);
      }
    });
  }

  function subscribe(fn) {
    listeners.push(fn);
    return function () {
      listeners = listeners.filter(function (f) {
        return f !== fn;
      });
    };
  }

  function setSync(status, message) {
    syncStatus.mode = status;
    syncStatus.message = message || "";
    syncStatus.at = new Date();
    emit();
  }

  function persistLocal() {
    state.updatedAt = new Date().toISOString();
    writeLocal(state);
    dirty = true;
  }

  /** 勾选 / 取消勾选 */
  function setTaskDone(id, isDone) {
    if (isDone) {
      var d = today();
      state.done[id] = d;
      state.checkins[d] = true;
    } else {
      delete state.done[id];
    }
    persistLocal();
    emit();
    scheduleSave();
  }

  function resetAll() {
    state = emptyState();
    persistLocal();
    emit();
    scheduleSave();
  }

  /** 2 秒防抖后写远端 */
  function scheduleSave() {
    if (!getPat()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 2000);
  }

  function flushSave() {
    if (!dirty) return Promise.resolve();
    if (!getPat()) return Promise.resolve();

    setSync("busy", "正在同步…");
    // 保存前再取一次远端，避免覆盖另一台设备的记录
    return gistRemoteState()
      .catch(function () {
        return { state: null };
      })
      .then(function (remote) {
        var merged = remote.state ? mergeState(state, remote.state) : state;
        state = merged;
        writeLocal(state);
        return gistSave(merged);
      })
      .then(function () {
        dirty = false;
        setSync("ok", "已同步");
      })
      .catch(function (e) {
        setSync("error", e.message);
        // 不清除 token，也不清本地数据
      });
  }

  /** 页面加载时拉远端并取并集 */
  function pullRemote() {
    if (!getPat()) {
      setSync("off", "");
      return Promise.resolve(state);
    }
    if (!getGistId()) {
      // 有 token 但还没建 gist：什么都不做，等第一次保存时创建
      setSync("pending", "首次保存时会自动创建 gist");
      return Promise.resolve(state);
    }
    setSync("busy", "正在读取云端…");
    return gistRemoteState()
      .then(function (remote) {
        if (remote.state) {
          state = mergeState(state, remote.state);
          writeLocal(state);
        }
        dirty = false;
        setSync("ok", "已同步");
        emit();
        return state;
      })
      .catch(function (e) {
        setSync("error", e.message);
        return state;
      });
  }

  /** 导出 / 导入 */
  function exportState() {
    var s = state;
    var blob = new Blob([JSON.stringify(s, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = "blog-state-" + today() + ".json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function importState(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var incoming = normalizeState(JSON.parse(reader.result));
          state = mergeState(state, incoming);
          persistLocal();
          emit();
          scheduleSave();
          resolve(state);
        } catch (e) {
          reject(new Error("文件不是有效的状态 JSON"));
        }
      };
      reader.onerror = function () {
        reject(new Error("读取文件失败"));
      };
      reader.readAsText(file);
    });
  }

  /* ---------- 主题 ---------- */

  function currentTheme() {
    return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  }

  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    try {
      localStorage.setItem(LS.theme, t);
    } catch (e) {}
    $$(".theme-toggle").forEach(function (b) {
      b.textContent = t === "dark" ? "☾" : "☀";
      b.setAttribute("aria-label", t === "dark" ? "切换到浅色模式" : "切换到深色模式");
    });
  }

  function toggleTheme() {
    applyTheme(currentTheme() === "dark" ? "light" : "dark");
  }

  /* ---------- 页面挂载 ---------- */

  function mountHeader(active) {
    // 修正相对链接：所有页面都在根目录，直接用文件名
    $$(".theme-toggle").forEach(function (b) {
      b.addEventListener("click", toggleTheme);
    });
    applyTheme(currentTheme());
    if (active) {
      var link = $('.nav a[data-page="' + active + '"]');
      if (link) link.setAttribute("aria-current", "page");
    }
  }

  function mountFooter() {
    var y = $("#year");
    if (y) y.textContent = String(new Date().getFullYear());
  }

  /* ---------- 防丢失 ---------- */

  function installFlushHooks() {
    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "hidden" && dirty) flushSave();
    });
    window.addEventListener("beforeunload", function (e) {
      if (dirty && getPat()) {
        // 无法保证完成，但至少给浏览器一个提示
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  /* ---------- 头部渲染辅助（各页共用） ---------- */

  function renderProgressBar(pct) {
    return '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></div>';
  }

  function highlight(text, q) {
    var safe = esc(text);
    if (!q) return safe;
    var idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return safe;
    var before = esc(text.slice(0, idx));
    var hit = esc(text.slice(idx, idx + q.length));
    var after = esc(text.slice(idx + q.length));
    return before + "<mark>" + hit + "</mark>" + after;
  }

  /* ---------- 导出全局 ---------- */

  window.Blog = {
    // 工具
    $: $,
    $$: $$,
    el: el,
    esc: esc,
    debounce: debounce,
    // 日期
    ymd: ymd,
    today: today,
    parseYmd: parseYmd,
    addDays: addDays,
    daysBetween: daysBetween,
    fmtDate: fmtDate,
    fmtDateFull: fmtDateFull,
    // 取数
    getJson: getJson,
    getText: getText,
    splitFrontMatter: splitFrontMatter,
    // 路线与进度
    loadPlan: loadPlan,
    allTasks: allTasks,
    phaseProgress: phaseProgress,
    overallProgress: overallProgress,
    streak: streak,
    recentCount: recentCount,
    calendarCells: calendarCells,
    countsFromDone: countsFromDone,
    renderProgressBar: renderProgressBar,
    highlight: highlight,
    // 状态
    getState: function () {
      return state;
    },
    subscribe: subscribe,
    setTaskDone: setTaskDone,
    resetAll: resetAll,
    mergeState: mergeState,
    normalizeState: normalizeState,
    emptyState: emptyState,
    exportState: exportState,
    importState: importState,
    pullRemote: pullRemote,
    flushSave: flushSave,
    isSyncEnabled: isSyncEnabled,
    getSyncStatus: function () {
      return syncStatus;
    },
    getPat: getPat,
    setPat: setPat,
    getGistId: getGistId,
    setGistId: setGistId,
    getEditPat: getEditPat,
    setEditPat: setEditPat,
    GH: GH,
    ghError: ghError,
    // 主题
    applyTheme: applyTheme,
    toggleTheme: toggleTheme,
    currentTheme: currentTheme,
    // 挂载
    mountHeader: mountHeader,
    mountFooter: mountFooter,
    installFlushHooks: installFlushHooks,
  };
})();
