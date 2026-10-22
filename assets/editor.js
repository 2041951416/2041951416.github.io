/* ============================================================
   Seek answer — 网页编辑器
   暴露 window.BlogEditor。

   设计约束：
   - 加载时不发任何网络请求，只在用户动作时工作。
   - 凭证是用户自己的 fine-grained PAT（单仓库 + Contents 读写）。
     它不是账号系统：谁拿到 token 谁就能改站。UI 必须诚实说明这一点。
   - 产品代码永不发 force:true，永不删 ref。
   ============================================================ */
(function () {
  "use strict";

  var B = window.Blog;

  /* 目标仓库。cfg 可被测试改写（分支名不是秘密：持有 token 的人
     本来就能推任意分支），这样提交原语能在临时分支上验证而不用碰 main。 */
  var cfg = {
    owner: "2041951416",
    repo: "2041951416.github.io",
    branch: "main",
  };
  var API = "https://api.github.com";

  function repoPath() {
    return "/repos/" + cfg.owner + "/" + cfg.repo;
  }
  function refPath() {
    return repoPath() + "/git/ref/heads/" + cfg.branch;
  }

  /* ---------- 基础请求 ---------- */

  function authHeaders(pat) {
    return {
      Authorization: "Bearer " + pat,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  function jsonHeaders(pat) {
    var h = authHeaders(pat);
    h["Content-Type"] = "application/json";
    return h;
  }

  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }

  /** 统一的错误构造：把 GitHub 的状态码翻译成人能看懂的话 */
  function apiError(status, body, what) {
    var msg = body && body.message ? body.message : "未知错误";
    if (status === 401) {
      return new Error("凭证无效或已过期（401）。请重新登录。你已输入的内容不会丢失。");
    }
    if (status === 403) {
      return new Error(
        "没有权限（403）。请确认 token 勾选了 Contents: Read and write，并且授权了 " +
          cfg.owner + "/" + cfg.repo + " 这个仓库。"
      );
    }
    if (status === 404) {
      return new Error("找不到资源（404）：" + (what || "") + "。");
    }
    if (status === 409 || (status === 422 && /fast forward/i.test(msg))) {
      return new Error("与他人改动冲突，正在重试…");
    }
    return new Error("GitHub 返回 " + status + "：" + msg);
  }

  /**
   * 发请求并解析 JSON，非 2xx 抛出 apiError。
   *
   * cache:"no-store" 是必须的：GitHub 的 git/ref 端点返回
   * `Cache-Control: private, max-age=60`，浏览器会缓存 60 秒。
   * 一旦读到缓存的旧 ref，新建的 commit 就不是快进，PATCH 会收到
   * 422 "Update is not a fast forward" —— 连续两次提交必现。
   */
  function req(method, path, pat, body, what) {
    var opts = {
      method: method,
      headers: body ? jsonHeaders(pat) : authHeaders(pat),
      cache: "no-store",
    };
    if (body) opts.body = JSON.stringify(body);
    return fetch(API + path, opts).then(function (r) {
      return r.text().then(function (txt) {
        var data = null;
        try {
          data = txt ? JSON.parse(txt) : null;
        } catch (e) {
          data = null;
        }
        if (!r.ok) throw apiError(r.status, data, what);
        return data;
      });
    });
  }

  /* ---------- base64 / UTF-8 ---------- */

  var enc = new TextEncoder();
  var dec = new TextDecoder("utf-8");

  function b64encode(text) {
    var bytes = enc.encode(text);
    var bin = "";
    // 分块避免 apply 参数过多
    var CHUNK = 0x8000;
    for (var i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function b64decode(b64) {
    var bin = atob(String(b64).replace(/\s/g, ""));
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return dec.decode(bytes);
  }

  /* ---------- 授权 ---------- */

  function isLoggedIn() {
    return !!B.getEditPat();
  }

  var verifyInFlight = null;

  /**
   * 验证 token 真的能写这个仓库，而不只是「有效」。
   * 光 GET /user 通过不代表有 Contents 写权限，所以实际跑一遍
   * blob → ref → 删 ref 的往返。
   */
  function verifyToken(pat) {
    if (verifyInFlight) return verifyInFlight;

    verifyInFlight = req("GET", "/user", pat, null, "读取账号信息")
      .then(function (user) {
        var base = repoPath();

        // 建一个临时 blob，证明 Contents 写权限
        return req("POST", base + "/git/blobs", pat, {
          content: "probe " + Date.now(),
          encoding: "utf-8",
        }, "创建临时 blob")
          .then(function (blob) {
            // 建一个临时 ref 指向它，证明能写 refs
            var refName = "refs/heads/editor-verify-" + Date.now();
            return req("POST", base + "/git/refs", pat, {
              ref: refName,
              sha: blob.sha,
            }, "创建临时分支")
              .then(function () {
                return req("DELETE", base + "/git/refs/heads/" + refName.split("/").pop(), pat, null, "清理临时分支")
                  .catch(function () {
                    return null; // 清理失败不应让验证失败
                  })
                  .then(function () {
                    return { login: user.login, owner: cfg.owner, repo: cfg.repo };
                  });
              });
          });
      })
      .then(function (out) {
        verifyInFlight = null;
        return out;
      })
      .catch(function (e) {
        verifyInFlight = null;
        throw e;
      });

    return verifyInFlight;
  }

  function login(pat) {
    var v = String(pat || "").trim();
    if (!v) return Promise.reject(new Error("请先粘贴 token"));
    return verifyToken(v).then(function (info) {
      B.setEditPat(v);
      return info;
    });
    // 失败时不存 —— 调用方负责显示错误
  }

  function logout() {
    B.setEditPat("");
    // 本地 token 已清，但已提交的内容不受影响
    return Promise.resolve();
  }

  /* ---------- 读取 ---------- */

  /** 读文件，返回 { text, sha, path } */
  function getFile(path, ref) {
    var pat = B.getEditPat();
    if (!pat) return Promise.reject(new Error("未登录"));
    var url = repoPath() + "/contents/" + path +
      "?ref=" + encodeURIComponent(ref || cfg.branch);
    // 同样禁用缓存：读到的 sha 用于比对，过期的 sha 会导致错误的并发判断
    return fetch(API + url, { headers: authHeaders(pat), cache: "no-store" })
      .then(function (r) {
        return r.text().then(function (txt) {
          var d = null;
          try {
            d = JSON.parse(txt);
          } catch (e) {}
          if (r.status === 404) {
            var e404 = new Error("文件不存在：" + path);
            e404.status = 404;
            throw e404;
          }
          if (!r.ok) throw apiError(r.status, d, path);
          if (Array.isArray(d)) throw new Error(path + " 是目录，不是文件");
          return {
            text: b64decode(d.content || ""),
            sha: d.sha,
            path: path,
          };
        });
      });
  }

  /** 文件存在返回 sha，不存在返回 null（不抛异常） */
  function fileExists(path, ref) {
    return getFile(path, ref)
      .then(function (f) {
        return f.sha;
      })
      .catch(function (e) {
        if (e.status === 404) return null;
        throw e;
      });
  }

  /* ---------- 原子提交 ---------- */

  function readRef() {
    var pat = B.getEditPat();
    return req("GET", refPath(), pat, null, "读取分支").then(function (ref) {
      var baseSha = ref.object.sha;
      return req("GET", repoPath() + "/git/commits/" + baseSha, pat, null, "读取提交").then(function (c) {
        return { baseSha: baseSha, baseTree: c.tree.sha };
      });
    });
  }

  function createBlob(text) {
    var pat = B.getEditPat();
    return req(
      "POST",
      repoPath() + "/git/blobs",
      pat,
      { content: text, encoding: "utf-8" },
      "创建 blob"
    ).then(function (b) {
      return b.sha;
    });
  }

  function createTree(baseTree, entries) {
    var pat = B.getEditPat();
    return req(
      "POST",
      repoPath() + "/git/trees",
      pat,
      { base_tree: baseTree, tree: entries },
      "创建 tree"
    ).then(function (t) {
      if (t.truncated) {
        throw new Error("文件树过大被截断，无法安全提交（本仓库不应触发，请反馈）");
      }
      return t.sha;
    });
  }

  function createCommit(treeSha, parentSha, message) {
    var pat = B.getEditPat();
    return req(
      "POST",
      repoPath() + "/git/commits",
      pat,
      { message: message, tree: treeSha, parents: [parentSha] },
      "创建提交"
    ).then(function (c) {
      return c.sha;
    });
  }

  function patchRef(commitSha) {
    var pat = B.getEditPat();
    return fetch(
      API + repoPath() + "/git/refs/heads/" + cfg.branch,
      {
        method: "PATCH",
        headers: jsonHeaders(pat),
        cache: "no-store",
        // force 故意省略（= false）：永不覆盖别人的提交
        body: JSON.stringify({ sha: commitSha }),
      }
    ).then(function (r) {
      return r.text().then(function (txt) {
        var d = null;
        try {
          d = txt ? JSON.parse(txt) : null;
        } catch (e) {}
        return { ok: r.ok, status: r.status, body: d };
      });
    });
  }

  /**
   * 一次提交改多个文件。
   *
   * changes 有两种形态：
   *   { put: { "path": "完整文本", ... }, del: ["path", ...] }        —— 直接给内容
   *   { build: function(ctx) { return {put, del} } }                  —— 按最新内容计算
   *
   * build 形式用于「改 manifest 某一条」这类依赖当前内容的操作：
   * 重试时会拿最新的 manifest 重新计算，按 slug 定位，不会写到错位置。
   */
  function commit(changes, message) {
    var pat = B.getEditPat();
    if (!pat) return Promise.reject(new Error("未登录"));
    if (changes.build && !message) return Promise.reject(new Error("缺少提交说明"));

    var MAX = 4;

    /**
     * 每一轮都重新读 ref，并（如果是 build 形态）在最新内容上重新计算改动。
     * 所有依赖 baseSha 的操作都收在同一个闭包里，避免变量逃逸。
     */
    function attempt(n) {
      return readRef().then(function (ref) {
        var baseSha = ref.baseSha;
        var baseTree = ref.baseTree;

        var workPromise = changes.build
          ? changes.build({
              baseSha: baseSha,
              getFile: function (p) {
                return getFile(p, baseSha);
              },
            })
          : Promise.resolve({ put: changes.put || {}, del: changes.del || [] });

        return workPromise.then(function (work) {
          var put = work.put || {};
          var del = work.del || [];
          var putPaths = Object.keys(put);

          // 零改动：不发任何请求
          if (!putPaths.length && !del.length) {
            return { sha: null, changed: false };
          }

          // 删除前确认文件真的存在，避免对不存在的路径发 sha:null 触发 422
          return Promise.all(
            del.map(function (p) {
              return fileExists(p, baseSha).then(function (sha) {
                return { path: p, exists: !!sha };
              });
            })
          ).then(function (checks) {
            var reallyDel = checks
              .filter(function (c) {
                return c.exists;
              })
              .map(function (c) {
                return c.path;
              });

            return Promise.all(
              putPaths.map(function (p) {
                return createBlob(put[p]).then(function (sha) {
                  return { path: p, mode: "100644", type: "blob", sha: sha };
                });
              })
            ).then(function (writeEntries) {
              var delEntries = reallyDel.map(function (p) {
                // sha 必须是 null，不能是 undefined —— JSON.stringify 会丢掉 undefined
                return { path: p, mode: "100644", type: "blob", sha: null };
              });
              var entries = writeEntries.concat(delEntries);
              if (!entries.length) return { sha: null, changed: false };

              return createTree(baseTree, entries)
                .then(function (treeSha) {
                  return createCommit(treeSha, baseSha, message);
                })
                .then(function (commitSha) {
                  return patchRef(commitSha).then(function (r) {
                    if (r.ok) return { sha: commitSha, changed: true };
                    if (r.status === 422 || r.status === 409) {
                      // put 形态带着完整文本，重试只会拿同一份旧文本再撞一次。
                      // 只有 build 形态能按最新内容重新计算，重试才有意义。
                      if (!changes.build) {
                        throw new Error(
                          "提交时与另一处改动冲突。请刷新页面后重试（不会丢失你已输入的内容）。"
                        );
                      }
                      if (n + 1 >= MAX) {
                        throw new Error("多次重试仍无法提交，可能有人正在同时编辑。请刷新后重试。");
                      }
                      return sleep(250 * Math.pow(2, n) + Math.random() * 150).then(function () {
                        return attempt(n + 1);
                      });
                    }
                    throw apiError(r.status, r.body, "更新分支");
                  });
                });
            });
          });
        });
      });
    }

    return attempt(0);
  }

  /* ---------- front matter ---------- */

  var FM_ORDER = ["title", "tags", "summary", "date"];

  /**
   * 比 B.splitFrontMatter 更严格：保留键的原始顺序和未知键，
   * 这样编辑一篇文章不会顺手把别人加的字段弄丢。
   */
  function parseFM(raw) {
    var text = String(raw == null ? "" : raw);
    var bom = false;
    if (text.charCodeAt(0) === 0xfeff) {
      bom = true;
      text = text.slice(1);
    }
    var eol = /\r\n/.test(text) ? "\r\n" : "\n";
    var m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
    if (!m) {
      return { meta: {}, order: [], body: text, eol: eol, bom: bom, hadFM: false };
    }
    var meta = {};
    var order = [];
    m[1].split(/\r?\n/).forEach(function (line) {
      var i = line.indexOf(":");
      if (i < 0) return;
      var k = line.slice(0, i).trim();
      var v = line.slice(i + 1).trim();
      if (!k) return;
      if (k === "tags") {
        meta.tags = v
          .split(/[,，]/)
          .map(function (t) {
            return t.trim();
          })
          .filter(Boolean);
      } else {
        meta[k] = v;
      }
      if (order.indexOf(k) < 0) order.push(k);
    });
    return { meta: meta, order: order, body: text.slice(m[0].length), eol: eol, bom: bom, hadFM: true };
  }

  function serializeFM(meta, body, opts) {
    var o = opts || {};
    var eol = o.eol || "\n";
    // 先按标准顺序，再补上未知键（保持原有相对顺序）
    var keys = FM_ORDER.filter(function (k) {
      return meta[k] !== undefined && meta[k] !== null && String(meta[k]).length > 0;
    });
    Object.keys(meta).forEach(function (k) {
      if (keys.indexOf(k) < 0 && meta[k] !== undefined && meta[k] !== null && String(meta[k]).length > 0) {
        keys.push(k);
      }
    });

    var lines = ["---"];
    keys.forEach(function (k) {
      if (k === "tags") {
        var tags = Array.isArray(meta.tags) ? meta.tags : String(meta.tags || "").split(/[,，]/);
        var clean = tags
          .map(function (t) {
            return String(t).trim();
          })
          .filter(Boolean);
        if (clean.length) lines.push("tags: " + clean.join(", "));
      } else {
        lines.push(k + ": " + String(meta[k]).trim());
      }
    });
    lines.push("---");

    var out = lines.join(eol) + eol + (body || "");
    return (o.bom ? "﻿" : "") + out;
  }

  /* ---------- slug 校验 ---------- */

  var SLUG_RE = /^[a-z0-9][a-z0-9\-_]*$/;

  /**
   * 返回错误信息，或 null 表示合法。
   * posts 与 notes 共用一个命名空间：post.html?p=<slug> 两者都能解析，
   * 所以重名会导致文章被错误的那一篇遮住。
   */
  function validateSlug(slug, kind, manifest, currentSlug) {
    var s = String(slug || "").trim();
    if (!s) return "请填写 slug（会用于网址）";
    if (s.length > 64) return "slug 不要超过 64 个字符";
    if (!SLUG_RE.test(s)) {
      return "只能用小写英文字母、数字、连字符和下划线，且必须以字母或数字开头";
    }
    if (currentSlug && s === currentSlug) return null; // 编辑模式下没改
    var all = []
      .concat((manifest && manifest.posts) || [])
      .concat((manifest && manifest.notes) || []);
    for (var i = 0; i < all.length; i++) {
      if (all[i].slug === s) return "这个 slug 已被「" + (all[i].title || s) + "」占用";
    }
    return null;
  }

  /* ---------- manifest 操作（按 slug 定位，不按下标） ---------- */

  function applyManifest(manifest, kind, slug, entry, oldSlug) {
    var out = JSON.parse(JSON.stringify(manifest || {}));
    if (!out.posts) out.posts = [];
    if (!out.notes) out.notes = [];
    var arr = kind === "note" ? out.notes : out.posts;
    var other = kind === "note" ? out.posts : out.notes;

    // 换 slug 时先删掉旧的（同时防止跨数组重名）
    var target = oldSlug || slug;
    arr = arr.filter(function (e) {
      return e.slug !== target && e.slug !== slug;
    });
    other = other.filter(function (e) {
      return e.slug !== slug;
    });

    if (entry) arr.push(entry);

    // 按日期倒序，最新在前
    arr.sort(function (a, b) {
      return String(b.date || "").localeCompare(String(a.date || ""));
    });

    if (kind === "note") {
      out.notes = arr;
      out.posts = other;
    } else {
      out.posts = arr;
      out.notes = other;
    }
    return out;
  }

  function buildEntry(fields) {
    return {
      slug: String(fields.slug).trim(),
      title: String(fields.title).trim(),
      date: fields.date,
      tags: fields.tags,
      summary: String(fields.summary).trim(),
    };
  }

  /* ---------- 工具 ---------- */

  function parseTags(s) {
    var seen = {};
    return String(s || "")
      .split(/[,，]/)
      .map(function (t) {
        return t.trim();
      })
      .filter(function (t) {
        if (!t || seen[t]) return false;
        seen[t] = true;
        return true;
      });
  }

  function stripScripts(html) {
    return String(html).replace(/<script[\s\S]*?<\/script>/gi, "");
  }

  /** 用 marked 渲染；edit.html 才会加载 marked */
  function preview(md) {
    if (!window.marked) throw new Error("预览需要 edit.html");
    return stripScripts(window.marked.parse(String(md || "")));
  }

  function shortSha(s) {
    return String(s || "").slice(0, 7);
  }

  /* ---------- 部署探测 ---------- */

  /**
   * 保存后轮询线上页面，等 workflow 把新内容发布出去。
   * 不用 API，直接看 pubic 页面 —— 这才是用户真正关心的东西。
   */
  function waitForDeploy(slug, opts) {
    var o = opts || {};
    var maxMs = o.maxMs || 180000;
    var interval = o.interval || 5000;
    var started = Date.now();
    var probeUrl = "post.html?p=" + encodeURIComponent(slug) + "&_=" + Date.now();

    function attempt() {
      if (Date.now() - started > maxMs) {
        return Promise.resolve({ ok: false, reason: "timeout" });
      }
      return fetch(probeUrl, { cache: "no-store" })
        .then(function (r) {
          return r.text();
        })
        .then(function (html) {
          // 部署完成后页面里会包含这篇文章的 slug 对应的内容
          var deployed = html.indexOf(slug) >= 0;
          if (deployed) return { ok: true };
          return sleep(interval).then(attempt);
        })
        .catch(function () {
          return sleep(interval).then(attempt);
        });
    }

    return sleep(interval).then(attempt);
  }

  /* ---------- 站点文案 ---------- */

  var SITE_CACHE_KEY = "blog.siteCache";
  var SITE_CACHE_TTL = 8000; // 8 秒内复用，避免同一页面重复请求

  /** 读文案：命中短期缓存就同步返回，否则异步取 */
  function loadSiteText() {
    try {
      var raw = localStorage.getItem(SITE_CACHE_KEY);
      if (raw) {
        var c = JSON.parse(raw);
        if (c && c.at && Date.now() - c.at < SITE_CACHE_TTL && c.data) {
          return Promise.resolve(c.data);
        }
      }
    } catch (e) {}

    return fetch("content/site.json", { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("site.json " + r.status);
        return r.json();
      })
      .then(function (data) {
        try {
          localStorage.setItem(SITE_CACHE_KEY, JSON.stringify({ at: Date.now(), data: data }));
        } catch (e) {}
        return data;
      });
  }

  /** 把 \n 渲染成 <br>，全程用 textContent，绝不注入 HTML */
  function setMultiline(node, text) {
    if (!node) return;
    node.textContent = "";
    String(text == null ? "" : text)
      .split(/\n/)
      .forEach(function (line, i) {
        if (i > 0) node.appendChild(document.createElement("br"));
        node.appendChild(document.createTextNode(line));
      });
  }

  /**
   * 只改已有节点的文本，不增删布局节点。
   * 这样即使 site.json 晚到，也不会引起重排或空白。
   */
  function applySiteText(site) {
    if (!site) return;

    if (site.brand) {
      B.$$(".brand").forEach(function (brand) {
        var first = brand.firstChild;
        if (first && first.nodeType === 3) first.nodeValue = site.brand;
      });
    }
    if (site.tagline) {
      B.$$(".brand em").forEach(function (em) {
        em.textContent = site.tagline;
      });
    }

    var hero = site.hero || {};
    var eyebrow = document.querySelector(".hero .eyebrow");
    if (eyebrow && hero.eyebrow) eyebrow.textContent = hero.eyebrow;
    var h1 = document.querySelector(".hero h1");
    if (h1 && hero.title) setMultiline(h1, hero.title);
    var lede = document.querySelector(".hero .lede");
    if (lede && hero.lede) setMultiline(lede, hero.lede);

    // 首页 about 段落：容器存在时整体替换，数量可变
    var aboutBox = document.getElementById("about-body");
    if (aboutBox && Array.isArray(site.about)) {
      aboutBox.textContent = "";
      site.about.forEach(function (para) {
        var p = document.createElement("p");
        p.className = "lede";
        p.style.fontSize = "0.92rem";
        p.textContent = para;
        aboutBox.appendChild(p);
      });
    }
  }

  /* ---------- 导出 ---------- */

  window.BlogEditor = {
    // UI 在 edit.html / 各页面里挂载
    init: function () {},
    isLoggedIn: isLoggedIn,
    login: login,
    logout: logout,
    verifyToken: verifyToken,
    getFile: getFile,
    fileExists: fileExists,
    commit: commit,
    // 内容处理
    parseFM: parseFM,
    serializeFM: serializeFM,
    validateSlug: validateSlug,
    applyManifest: applyManifest,
    buildEntry: buildEntry,
    parseTags: parseTags,
    preview: preview,
    shortSha: shortSha,
    waitForDeploy: waitForDeploy,
    // 站点文案
    loadSiteText: loadSiteText,
    applySiteText: applySiteText,
    setMultiline: setMultiline,
    // 工具
    b64encode: b64encode,
    b64decode: b64decode,
    cfg: cfg,
    SLUG_RE: SLUG_RE,
  };
})();
