/*
 * 编辑器 UI 测试。
 *
 * 全程拦截 api.github.com，不向真实仓库写入任何东西。
 * 断言的是「编辑器发出的请求内容是否正确」，而不是服务端行为
 * （服务端行为由 tools/test-commit.js 单独验证）。
 *
 * 用法: node tools/test-editor.js
 * 前置: 本地 http.server 已在 8000 端口（见 README）
 */
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");

const BASE = "http://localhost:8000/";
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const ROOT = process.env.SITE_ROOT || path.resolve(__dirname, "..");

const results = [];
const pass = (n, e) => { results.push({ ok: true, n }); console.log("  PASS  " + n + (e ? "  — " + e : "")); };
const fail = (n, d) => { results.push({ ok: false, n, d }); console.log("  FAIL  " + n + "\n        " + d); };

/* ---------- 假仓库状态 ---------- */

function fixture() {
  const manifestRaw = fs.readFileSync(path.join(ROOT, "content/index.json"), "utf8");
  const planRaw = fs.readFileSync(path.join(ROOT, "content/plan.json"), "utf8");
  const postMd = fs.readFileSync(path.join(ROOT, "content/posts/why-this-blog.md"), "utf8");

  const files = {};
  const sha = (p) => "sha-" + Buffer.from(p).toString("hex").slice(0, 12);

  files["content/index.json"] = manifestRaw;
  files["content/plan.json"] = planRaw;
  files["content/posts/why-this-blog.md"] = postMd;

  (JSON.parse(manifestRaw).posts || []).forEach((p) => {
    const f = `content/posts/${p.slug}.md`;
    if (!files[f]) files[f] = "---\ntitle: " + p.title + "\n---\nbody";
  });
  (JSON.parse(manifestRaw).notes || []).forEach((n) => {
    const f = `content/notes/${n.slug}.md`;
    if (!files[f]) files[f] = "---\ntitle: " + n.title + "\n---\nbody";
  });

  return {
    files,
    sha,
    headSha: "head0",
    treeSha: "tree0",
    commits: 0,
    calls: [],
  };
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  let repo = fixture();
  let tokenValid = true;

  await page.setRequestInterception(true);

  let slowSiteJson = false;

  page.on("request", async (req) => {
    const url = req.url();

    // 供第 9 步使用：故意延迟 site.json，验证品牌不会闪成空
    if (slowSiteJson && url.includes("content/site.json")) {
      await new Promise((r) => setTimeout(r, 1500));
      return req.continue();
    }

    if (!url.includes("api.github.com")) return req.continue();

    const method = req.method();
    const p = url.replace("https://api.github.com", "");
    const body = req.postData() ? JSON.parse(req.postData()) : null;
    repo.calls.push({ method, path: p, body });

    const json = (obj, status = 200) =>
      req.respond({ status, contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: JSON.stringify(obj) });

    if (method === "OPTIONS") {
      return req.respond({
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
        },
      });
    }

    if (p === "/user") {
      return tokenValid ? json({ login: "tester" }) : json({ message: "Bad credentials" }, 401);
    }

    // 分支 ref
    if (/^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\//.test(p)) {
      return json({ ref: "refs/heads/main", object: { sha: repo.headSha, type: "commit" } });
    }

    if (/\/git\/commits\/[^/]+$/.test(p)) {
      return json({ sha: repo.headSha, tree: { sha: repo.treeSha } });
    }

    if (/\/git\/blobs$/.test(p)) {
      const content = body && body.content;
      return json({ sha: "blob-" + Buffer.from(String(content)).toString("base64").slice(0, 10) }, 201);
    }

    if (/\/git\/trees$/.test(p)) {
      // 把 tree 条目记为最新一次提交内容，供断言
      repo.lastTree = body;
      return json({ sha: "tree-new", truncated: false }, 201);
    }

    if (/\/git\/commits$/.test(p)) {
      repo.lastCommit = body;
      repo.commits++;
      repo.headSha = "commit-" + repo.commits;
      return json({ sha: repo.headSha }, 201);
    }

    // ref 更新
    if (/\/git\/refs\/heads\//.test(p) && (method === "PATCH")) {
      repo.lastPatch = body;
      return json({ ref: "refs/heads/main", object: { sha: body.sha } });
    }

    // contents 读取
    const m = /\/repos\/[^/]+\/[^/]+\/contents\/([^?]+)/.exec(p);
    if (m) {
      const filePath = decodeURIComponent(m[1]);
      if (!(filePath in repo.files)) {
        return json({ message: "Not Found" }, 404);
      }
      return json({
        type: "file",
        path: filePath,
        sha: repo.sha(filePath),
        content: Buffer.from(repo.files[filePath], "utf8").toString("base64"),
        encoding: "base64",
      });
    }

    return json({ message: "unhandled " + method + " " + p }, 404);
  });

  function reset() {
    repo = fixture();
    tokenValid = true;
  }

  // beforeunload 守卫会拦住导航，测试里统一自动接受
  page.on("dialog", async (d) => {
    try {
      await d.accept();
    } catch (e) {
      // 已被其他地方处理
    }
  });

  async function open(url, opts = {}) {
    await page.evaluateOnNewDocument((logged) => {
      if (logged) localStorage.setItem("blog.editPat", "ghp_testtoken");
      else localStorage.removeItem("blog.editPat");
    }, !!opts.logged);
    await page.goto(BASE + url, { waitUntil: "networkidle0" }).catch(async () => {
      // 被 beforeunload 拦下时重试一次
      await page.goto(BASE + url, { waitUntil: "networkidle0" });
    });
  }

  /* ---------- 1. 未登录时零请求 ---------- */
  console.log("\n[1] 未登录时页面完全静默");
  reset();

  for (const u of ["index.html", "plan.html", "notes.html", "posts.html", "post.html?p=i2c-pullup"]) {
    await open(u, { logged: false });
    await new Promise((r) => setTimeout(r, 500));
    const apiCalls = repo.calls.filter((c) => c.path.startsWith("/"));
    if (apiCalls.length === 0) pass(u + " 未触发任何 GitHub 请求");
    else fail(u + " 有意外请求", JSON.stringify(apiCalls.slice(0, 3)));
  }

  await open("post.html?p=why-this-blog", { logged: false });
  const noBar = await page.evaluate(() => !document.getElementById("edit-bar"));
  if (noBar) pass("未登录时文章页没有编辑条");
  else fail("编辑条", "#edit-bar 存在于 DOM");

  const noNew = await page.evaluate(() => {
    const n = document.getElementById("new-post-slot");
    return n ? n.hidden : true;
  });
  if (noNew) pass("未登录时随笔页没有新建按钮");
  else fail("新建按钮", "可见");

  /* ---------- 2. 登录后出现编辑入口 ---------- */
  console.log("\n[2] 登录后编辑入口出现");
  reset();
  await open("post.html?p=why-this-blog", { logged: true });
  await page.waitForSelector("#edit-bar", { timeout: 8000 }).catch(() => {});
  const bar = await page.evaluate(() => {
    const b = document.getElementById("edit-bar");
    return b ? { text: b.textContent, hasEdit: !!b.querySelector('a[href^="edit.html?p="]'), hasDel: !!b.querySelector("#btn-delete") } : null;
  });
  if (bar && bar.hasEdit && bar.hasDel) pass("文章页出现编辑/删除", bar.text.replace(/\s+/g, " ").trim());
  else fail("编辑条", JSON.stringify(bar));

  /* ---------- 3. 新建随笔：请求体正确 ---------- */
  console.log("\n[3] 新建随笔的提交内容");
  reset();
  repo.calls.length = 0;
  await open("edit.html?new=post", { logged: true });
  await page.waitForSelector("#f-slug", { timeout: 8000 });

  await page.type("#f-slug", "test-new-post");
  await page.type("#f-title", "测试新建");
  await page.type("#f-tags", "a, b，a");
  await page.type("#f-summary", "这是一句摘要");
  await page.type("#f-body", "## 小节\n\n正文内容");

  await new Promise((r) => setTimeout(r, 300));
  await page.click("#btn-save");
  await new Promise((r) => setTimeout(r, 1500));

  if (repo.lastTree) pass("产生了 tree");
  else fail("未产生 tree", JSON.stringify(repo.calls.map((c) => c.method + " " + c.path)));

  if (repo.lastTree) {
    const paths = repo.lastTree.tree.map((e) => e.path).sort();
    const expect = ["content/index.json", "content/posts/test-new-post.md"];
    if (JSON.stringify(paths) === JSON.stringify(expect)) pass("tree 恰好包含 2 个文件", paths.join(", "));
    else fail("tree 路径", JSON.stringify(paths));

    if (repo.lastTree.base_tree === "tree0") pass("base_tree 正确");
    else fail("base_tree", String(repo.lastTree.base_tree));

    const delEntries = repo.lastTree.tree.filter((e) => e.sha === null);
    if (delEntries.length === 0) pass("新建时没有删除项");
    else fail("意外的删除项", JSON.stringify(delEntries));
  }

  // 检查 blob 用的是 utf-8 而不是 base64
  const blobCalls = repo.calls.filter((c) => c.path.endsWith("/git/blobs") && c.method === "POST");
  if (blobCalls.length >= 2) {
    const missing = blobCalls.filter((c) => !c.body || c.body.encoding !== "utf-8");
    if (missing.length === 0) pass("所有 blob 都用 utf-8 编码", blobCalls.length + " 个 blob");
    else fail("blob 编码", JSON.stringify(missing.map((c) => c.body)));
  } else {
    fail("blob 数量", String(blobCalls.length));
  }

  // front matter 格式
  const mdBlob = blobCalls.find((c) => c.body && /^---/.test(String(c.body.content)));
  if (mdBlob) {
    const text = mdBlob.body.content;
    const okOrder = /^---\ntitle: 测试新建\ntags: a, b\nsummary: 这是一句摘要\ndate: \d{4}-\d{2}-\d{2}\n---\n/.test(text);
    if (okOrder) pass("front matter 字段顺序正确且标签已去重", text.split("\n").slice(0, 5).join(" | "));
    else fail("front matter", JSON.stringify(text.slice(0, 160)));
  } else {
    fail("找不到 markdown blob", "");
  }

  // 调用顺序：blobs → tree → commit → patch
  const seq = repo.calls
    .filter((c) => ["POST", "PATCH"].includes(c.method))
    .map((c) => (c.path.endsWith("/git/blobs") ? "blob" : c.path.endsWith("/git/trees") ? "tree" : c.path.endsWith("/git/commits") ? "commit" : c.method === "PATCH" ? "patch" : "?"));
  const firstTree = seq.indexOf("tree");
  const firstCommit = seq.indexOf("commit");
  const firstPatch = seq.indexOf("patch");
  if (firstTree > -1 && firstCommit > firstTree && firstPatch > firstCommit)
    pass("调用顺序 blobs → tree → commit → patch", seq.join(" → "));
  else fail("调用顺序", seq.join(" → "));

  if (repo.lastPatch && /^commit-\d+$/.test(String(repo.lastPatch.sha)))
    pass("PATCH 携带新建提交的 sha", String(repo.lastPatch.sha));
  else fail("PATCH sha", JSON.stringify(repo.lastPatch));

  /* ---------- 4. 编辑：slug 只读、未知键保留 ---------- */
  console.log("\n[4] 编辑已有文章");
  reset();
  repo.calls.length = 0;
  // 给源文件加一个未知 front matter 键，验证不会被丢掉
  repo.files["content/posts/why-this-blog.md"] = repo.files["content/posts/why-this-blog.md"].replace(/^---\n/, "---\ncustom: keep-me\n");

  await open("edit.html?p=why-this-blog", { logged: true });
  await page.waitForSelector("#f-title", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 600));

  const readOnly = await page.evaluate(() => document.getElementById("f-slug").readOnly);
  if (readOnly) pass("编辑模式下 slug 只读");
  else fail("slug 只读", "readOnly=false");

  const bodyBefore = await page.evaluate(() => document.getElementById("f-body").value);

  // 只改摘要
  await page.evaluate(() => {
    const el = document.getElementById("f-summary");
    el.value = "改过的摘要";
    el.dispatchEvent(new Event("input"));
  });
  await new Promise((r) => setTimeout(r, 300));
  await page.click("#btn-save");
  await new Promise((r) => setTimeout(r, 1200));

  const editBlob = repo.calls
    .filter((c) => c.path.endsWith("/git/blobs"))
    .map((c) => c.body && c.body.content)
    .find((t) => t && /^---/.test(t));

  if (editBlob) {
    if (/custom: keep-me/.test(editBlob)) pass("未知 front matter 键被保留");
    else fail("未知键丢失", editBlob.slice(0, 200));

    if (/summary: 改过的摘要/.test(editBlob)) pass("摘要已更新");
    else fail("摘要未更新", "");

    const afterBody = editBlob.split(/^---$/m).slice(2).join("---");
    if (afterBody.trim() === bodyBefore.trim()) pass("正文逐字节未改动");
    else fail("正文被改动", JSON.stringify(afterBody.slice(0, 120)));
  } else {
    fail("编辑未产生 blob", "");
  }

  /* ---------- 5. 校验：非法 slug 不发请求 ---------- */
  console.log("\n[5] 校验拦截");
  for (const bad of ["Bad Slug", "Ünïcode", "-lead", "why-this-blog"]) {
    reset();
    await open("edit.html?new=note", { logged: true });
    await page.waitForSelector("#f-slug");
    await new Promise((r) => setTimeout(r, 400));
    repo.calls.length = 0;

    await page.type("#f-slug", bad);
    await page.type("#f-title", "标题");
    await page.type("#f-summary", "摘要");
    await page.type("#f-body", "正文");
    await new Promise((r) => setTimeout(r, 250));
    await page.click("#btn-save");
    await new Promise((r) => setTimeout(r, 600));

    const writes = repo.calls.filter((c) => ["POST", "PATCH"].includes(c.method));
    const err = await page.evaluate(() => document.getElementById("e-slug").textContent.trim());
    if (writes.length === 0 && err) pass('拒绝 "' + bad + '"', err.slice(0, 40));
    else fail('"' + bad + '" 未被拒绝', JSON.stringify({ writes: writes.length, err }));
  }

  /* ---------- 6. 删除：sha:null 且不用 POST /contents ---------- */
  console.log("\n[6] 删除文章");
  reset();
  repo.calls.length = 0;
  await open("post.html?p=why-this-blog", { logged: true });
  await page.waitForSelector("#btn-delete", { timeout: 8000 });

  await page.click("#btn-delete");
  await new Promise((r) => setTimeout(r, 1500));

  if (repo.lastTree) {
    const delEntry = repo.lastTree.tree.find((e) => e.sha === null);
    if (delEntry && delEntry.path === "content/posts/why-this-blog.md")
      pass("删除项 sha 为 null", delEntry.path);
    else fail("删除项", JSON.stringify(repo.lastTree.tree));

    const idxEntry = repo.lastTree.tree.find((e) => e.path === "content/index.json");
    if (idxEntry) pass("同一提交里也更新了 index.json");
    else fail("index.json 未更新", "");
  } else {
    fail("删除未产生 tree", "");
  }

  const usedContentsApi = repo.calls.some((c) => c.method === "POST" && c.path.includes("/contents/"));
  if (!usedContentsApi) pass("没有使用单文件 POST /contents");
  else fail("使用了 POST /contents", "");

  /* ---------- 7. 计划编辑：id 保护 ---------- */
  console.log("\n[7] 计划编辑的 id 保护");
  reset();
  await open("edit.html?plan=1", { logged: true });
  await page.evaluate(() => {
    localStorage.setItem(
      "blog.state",
      JSON.stringify({ schema: 1, done: { "p1-t1": "2026-10-01", "p1-t2": "2026-10-02" }, checkins: {}, profile: { startDate: "2026-10-01" } })
    );
  });
  await page.reload({ waitUntil: "networkidle0" });
  await page.waitForSelector(".plan-task-row", { timeout: 8000 });
  await new Promise((r) => setTimeout(r, 500));

  const planInfo = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".plan-task-row")];
    const warns = rows.map((r) => {
      const w = r.querySelector(".plan-warn");
      return w ? w.textContent.trim() : "";
    }).filter(Boolean);
    return {
      phases: document.querySelectorAll(".phase-block").length,
      tasks: rows.length,
      warns: warns,
      phaseIds: [...document.querySelectorAll(".plan-id")].map((e) => e.textContent.trim()),
    };
  });

  if (planInfo.phases === 5) pass("渲染 5 个阶段");
  else fail("阶段数", String(planInfo.phases));
  if (planInfo.tasks === 26) pass("渲染 26 个任务");
  else fail("任务数", String(planInfo.tasks));
  if (JSON.stringify(planInfo.phaseIds) === JSON.stringify(["p1", "p2", "p3", "p4", "p5"]))
    pass("阶段 id 原样显示", planInfo.phaseIds.join(","));
  else fail("阶段 id", JSON.stringify(planInfo.phaseIds));
  // p1-t1 / p1-t2 各有一条进度，所以应出现两条「已有 1 条进度」
  const warnOk =
    planInfo.warns.length === 2 && planInfo.warns.every((w) => /已有 1 条进度/.test(w));
  if (warnOk) pass("按任务分别提示进度数量", planInfo.warns.join(" / "));
  else fail("进度提示", JSON.stringify(planInfo.warns));

  // 改阶段标题后保存，id 必须不变
  reset();
  repo.calls.length = 0;
  await page.evaluate(() => {
    const inp = document.querySelector(".phase-title-input");
    inp.value = "改过的阶段标题";
    inp.dispatchEvent(new Event("input"));
  });
  await new Promise((r) => setTimeout(r, 250));
  await page.click("#btn-plan-save");
  await new Promise((r) => setTimeout(r, 1200));

  const planBlob = repo.calls
    .filter((c) => c.path.endsWith("/git/blobs"))
    .map((c) => c.body && c.body.content)
    .find((t) => t && t.includes("phases"));

  if (planBlob) {
    const parsed = JSON.parse(planBlob);
    const ids = parsed.phases.map((p) => p.id);
    if (JSON.stringify(ids) === JSON.stringify(["p1", "p2", "p3", "p4", "p5"])) pass("只改标题后阶段 id 未变", ids.join(","));
    else fail("阶段 id 被改动", JSON.stringify(ids));
    if (parsed.phases[0].title === "改过的阶段标题") pass("标题已更新");
    else fail("标题未更新", parsed.phases[0].title);
    const taskCount = parsed.phases.reduce((n, p) => n + p.tasks.length, 0);
    if (taskCount === 26) pass("任务数仍为 26");
    else fail("任务数变化", String(taskCount));
  } else {
    fail("计划保存未产生 blob", "");
  }

  /* ---------- 8. 坏 token 不落盘 ---------- */
  console.log("\n[8] 无效 token 不写入本地");
  reset();
  tokenValid = false;
  await open("edit.html", { logged: false });
  await page.waitForSelector("#pat", { timeout: 8000 });
  await page.type("#pat", "bad-token-value");
  await page.click("#btn-login");
  await new Promise((r) => setTimeout(r, 1200));

  const stored = await page.evaluate(() => localStorage.getItem("blog.editPat"));
  const msg = await page.evaluate(() => document.getElementById("login-msg").textContent.trim());
  if (!stored) pass("验证失败时 token 未写入 localStorage");
  else fail("token 被错误写入", String(stored));
  if (/401|无效|过期/.test(msg)) pass("显示了明确的错误", msg.slice(0, 50));
  else fail("错误提示", msg);

  /* ---------- 9. 站点文案：防闪烁 ---------- */
  console.log("\n[9] 站点文案与应用");
  reset();

  slowSiteJson = true;
  await page.goto(BASE + "index.html", { waitUntil: "domcontentloaded" });
  const brandAtDCL = await page.evaluate(() => {
    const b = document.querySelector(".brand");
    return b ? b.textContent.trim() : "(missing)";
  });
  if (brandAtDCL.startsWith("Seek answer")) pass("DOMContentLoaded 时品牌已就位（不会闪空）", brandAtDCL);
  else fail("品牌闪烁", brandAtDCL);

  await new Promise((r) => setTimeout(r, 2500));
  const afterSite = await page.evaluate(() => ({
    brand: (document.querySelector(".brand") || {}).textContent || "",
    heroTitle: (document.querySelector(".hero h1") || {}).textContent || "",
    aboutParas: document.querySelectorAll("#about-body p").length,
  }));
  if (afterSite.aboutParas >= 1) pass("site.json 渲染了关于段落", String(afterSite.aboutParas) + " 段");
  else fail("关于段落", JSON.stringify(afterSite));
  slowSiteJson = false;

  await browser.close();

  const bad = results.filter((r) => !r.ok);
  console.log("\n" + "=".repeat(56));
  console.log(`结果：${results.length - bad.length} 通过 / ${bad.length} 失败`);
  if (bad.length) {
    console.log("\n失败项：");
    bad.forEach((f) => console.log("  · " + f.n + " — " + f.d));
    process.exit(1);
  }
})().catch((e) => {
  console.error("\n测试异常：", e);
  process.exit(2);
});
