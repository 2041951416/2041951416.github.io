/*
 * 提交原语的真实 API 测试。
 *
 * 站点由 workflow 从 main 发布，所以推送到临时分支不会产生任何可见页面。
 * 所有写操作都打在 editor-scratch-* 分支上，finally 里删除。
 *
 * 用法: node tools/test-commit.js <branch-name>
 * 需要环境变量 GITHUB_TOKEN（或从 gh auth token 取）。
 */
const puppeteer = require("puppeteer-core");

const OWNER = "2041951416";
const REPO = "2041951416.github.io";
const BASE = "http://localhost:8000/";
const BRANCH = process.argv[2];
const TOKEN = process.env.GITHUB_TOKEN;
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

if (!BRANCH) {
  console.error("缺少分支名参数");
  process.exit(2);
}
if (!TOKEN) {
  console.error("缺少 GITHUB_TOKEN");
  process.exit(2);
}

const results = [];
const pass = (n, e) => { results.push({ ok: true, n }); console.log("  PASS  " + n + (e ? "  — " + e : "")); };
const fail = (n, d) => { results.push({ ok: false, n, d }); console.log("  FAIL  " + n + "\n        " + d); };

/* 直接调 GitHub API 的辅助（用作外部观察者） */
async function api(path, method = "GET", body) {
  const r = await fetch("https://api.github.com" + path, {
    method,
    headers: {
      Authorization: "Bearer " + TOKEN,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const txt = await r.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch (e) {}
  return { ok: r.ok, status: r.status, data };
}

async function readFileAt(path, ref) {
  const r = await api(`/repos/${OWNER}/${REPO}/contents/${path}?ref=${ref}`);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(path + " -> " + r.status);
  return { text: Buffer.from(r.data.content, "base64").toString("utf8"), sha: r.data.sha };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox"],
  });
  const page = await browser.newPage();

  // 在页面里加载 app.js + editor.js，并把 cfg.branch 指向临时分支
  await page.goto(BASE + "index.html", { waitUntil: "networkidle0" });
  await page.addScriptTag({ url: BASE + "assets/editor.js" });
  await page.evaluate((t, br) => {
    localStorage.setItem("blog.editPat", t);
    window.BlogEditor.cfg.branch = br;
  }, TOKEN, BRANCH);

  const headBefore = (await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)).data.object.sha;

  /* ---------- 1. 改两个文件，一个提交 ---------- */
  console.log("\n[1] 原子提交：同时改 .md 和 index.json");
  const mdPath = "content/posts/why-this-blog.md";
  const idxPath = "content/index.json";
  const origMd = await readFileAt(mdPath, BRANCH);
  const origIdx = JSON.parse((await readFileAt(idxPath, BRANCH)).text);

  const marker = "TEST-MARKER-" + Date.now();
  const newMd = origMd.text.replace(/^summary:.*$/m, "summary: " + marker);
  const newIdx = JSON.parse(JSON.stringify(origIdx));
  const post = newIdx.posts.find((p) => p.slug === "why-this-blog");
  const oldSummary = post.summary;
  post.summary = marker;

  const r1 = await page.evaluate(async (put, msg) => {
    try {
      return { ok: true, res: await window.BlogEditor.commit({ put }, msg) };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  }, { [mdPath]: newMd, [idxPath]: JSON.stringify(newIdx, null, 2) + "\n" }, "test: edit two files");

  if (r1.ok && r1.res.changed) pass("commit 返回新 sha", r1.res.sha.slice(0, 7));
  else fail("commit 失败", JSON.stringify(r1));

  // 外部观察：只有一个新提交，两个父提交链正确
  const headAfter = (await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)).data.object.sha;
  const commitInfo = (await api(`/repos/${OWNER}/${REPO}/git/commits/${headAfter}`)).data;
  if (commitInfo.parents.length === 1 && commitInfo.parents[0].sha === headBefore)
    pass("只有一个父提交（不是 merge，不是多次提交）");
  else fail("父提交", JSON.stringify(commitInfo.parents));

  const filesChanged = await api(`/repos/${OWNER}/${REPO}/commits/${headAfter}`);
  const changed = (filesChanged.data.files || []).map((f) => f.filename).sort();
  if (changed.length === 2 && changed.includes(mdPath) && changed.includes(idxPath))
    pass("该提交恰好改了 2 个文件", changed.join(", "));
  else fail("改动文件", JSON.stringify(changed));

  const afterMd = await readFileAt(mdPath, BRANCH);
  const afterIdx = JSON.parse((await readFileAt(idxPath, BRANCH)).text);
  if (afterMd.text.includes(marker) && afterIdx.posts.find((p) => p.slug === "why-this-blog").summary === marker)
    pass("两个文件的改动都已生效");
  else fail("内容未生效", marker);

  /* ---------- 2. 空改动不发请求 ---------- */
  console.log("\n[2] 零改动不产生提交");
  const beforeEmpty = (await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)).data.object.sha;
  const r2 = await page.evaluate(async () => {
    try {
      return { ok: true, res: await window.BlogEditor.commit({}, "should not happen") };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  });
  const afterEmpty = (await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)).data.object.sha;
  if (r2.ok && r2.res.changed === false && beforeEmpty === afterEmpty)
    pass("空改动被跳过，分支未动");
  else fail("空改动处理", JSON.stringify({ r2, same: beforeEmpty === afterEmpty }));

  /* ---------- 3. 删除文件 ---------- */
  console.log("\n[3] 删除：manifest 与 .md 同时移除");
  const scratchPost = "content/posts/_scratch-del-" + Date.now() + ".md";
  // 先建一个待删文件
  await page.evaluate(async (p) => {
    return window.BlogEditor.commit({ put: { [p]: "---\ntitle: x\n---\nbody" } }, "test: seed file");
  }, scratchPost);
  const existsBefore = await readFileAt(scratchPost, BRANCH);
  if (existsBefore) pass("临时文件已创建");
  else fail("临时文件创建失败", scratchPost);

  // 用 build 形态：按提交时刻的最新 manifest 删除，避免携带过期文本
  const r3 = await page.evaluate(async (del) => {
    try {
      return {
        ok: true,
        res: await window.BlogEditor.commit(
          {
            build: async (ctx) => {
              const cur = await ctx.getFile("content/index.json");
              return { put: { "content/index.json": cur.text }, del };
            },
          },
          "test: delete"
        ),
      };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  }, [scratchPost]);

  const gone = await readFileAt(scratchPost, BRANCH);
  if (r3.ok && gone === null) pass("文件已从分支删除");
  else fail("删除失败", JSON.stringify({ r3, gone: gone !== null }));

  /* ---------- 4. 删除不存在的文件不报错 ---------- */
  console.log("\n[4] 删除不存在的文件被安全跳过");
  const r4 = await page.evaluate(async () => {
    try {
      return { ok: true, res: await window.BlogEditor.commit({ del: ["content/posts/does-not-exist-xyz.md"] }, "test: noop del") };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  });
  if (r4.ok && r4.res.changed === false) pass("不存在的删除被跳过，未产生提交");
  else fail("不存在的删除", JSON.stringify(r4));

  /* ---------- 5. 竞态：外部提交后原请求应失败并重试成功 ---------- */
  console.log("\n[5] 竞态重试");
  // 用 build 形态：内容依赖最新状态，这样重试才有意义
  const beforeRace = (await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)).data.object.sha;
  const raceMarker = "RACE-" + Date.now();

  // 并发：一边让页面按 build 提交，一边从外部抢先推一个提交
  const pagePromise = page.evaluate(async (mk) => {
    return window.BlogEditor.commit(
      {
        build: async (ctx) => {
          // 故意延迟，让外部提交先落地
          await new Promise((r) => setTimeout(r, 600));
          const cur = await ctx.getFile("content/index.json");
          const idx = JSON.parse(cur.text);
          idx.raceProbe = mk;
          return { put: { "content/index.json": JSON.stringify(idx, null, 2) + "\n" } };
        },
      },
      "test: race"
    );
  }, raceMarker);

  // 外部抢先在同一个 base 上推进分支（模拟另一台设备）
  await new Promise((r) => setTimeout(r, 200));
  const outer = await (async () => {
    const ref = (await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)).data.object.sha;
    const c = (await api(`/repos/${OWNER}/${REPO}/git/commits/${ref}`)).data;
    const b = (await api(`/repos/${OWNER}/${REPO}/git/blobs`, "POST", {
      content: "outer " + Date.now(),
      encoding: "utf-8",
    })).data;
    const t = (await api(`/repos/${OWNER}/${REPO}/git/trees`, "POST", {
      base_tree: c.tree.sha,
      tree: [{ path: "content/_race.txt", mode: "100644", type: "blob", sha: b.sha }],
    })).data;
    const nc = (await api(`/repos/${OWNER}/${REPO}/git/commits`, "POST", {
      message: "external concurrent commit",
      tree: t.sha,
      parents: [ref],
    })).data;
    await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, "PATCH", { sha: nc.sha });
    return nc.sha;
  })();

  let raceRes = null;
  let raceErr = null;
  try {
    raceRes = await pagePromise;
  } catch (e) {
    raceErr = e.message;
  }

  const finalIdx = JSON.parse((await readFileAt(idxPath, BRANCH)).text);
  const finalHead = (await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`)).data.object.sha;

  if (raceRes && finalIdx.raceProbe === raceMarker)
    pass("重试后页面的改动生效", "HEAD=" + finalHead.slice(0, 7));
  else fail("竞态重试失败", JSON.stringify({ raceRes, raceErr, probe: finalIdx.raceProbe }));

  // 外部那条提交的内容也必须还在（没被覆盖）
  const raceFile = await readFileAt("content/_race.txt", BRANCH);
  if (raceFile) pass("外部并发提交未被覆盖");
  else fail("外部提交丢失", "content/_race.txt 不见了");

  const finalCommit = (await api(`/repos/${OWNER}/${REPO}/git/commits/${finalHead}`)).data;
  if (finalCommit.parents[0].sha === outer)
    pass("重试建立在外部提交之上（fast-forward 链完整）");
  else fail("提交链", "parent=" + finalCommit.parents[0].sha.slice(0, 7) + " expect=" + outer.slice(0, 7));

  /* ---------- 6. 还原改动 ---------- */
  console.log("\n[6] 还原测试改动");
  await page.evaluate(
    async (orig, md, del) => {
      return window.BlogEditor.commit(
        {
          build: async (ctx) => {
            const cur = await ctx.getFile("content/index.json");
            const idx = JSON.parse(cur.text);
            delete idx.raceProbe;
            const p = idx.posts.find((x) => x.slug === "why-this-blog");
            if (p) p.summary = orig;
            return {
              put: {
                "content/index.json": JSON.stringify(idx, null, 2) + "\n",
                "content/posts/why-this-blog.md": md,
              },
              del,
            };
          },
        },
        "test: restore"
      );
    },
    oldSummary,
    origMd.text,
    ["content/_race.txt"]
  );

  const check = await readFileAt(mdPath, BRANCH);
  const raceGone = await readFileAt("content/_race.txt", BRANCH);
  if (!check.text.includes(marker) && raceGone === null) pass("测试改动已还原");
  else fail("还原不完整", JSON.stringify({ marker: check.text.includes(marker), raceGone: !!raceGone }));

  await browser.close();

  const bad = results.filter((r) => !r.ok);
  console.log("\n" + "=".repeat(56));
  console.log(`结果：${results.length - bad.length} 通过 / ${bad.length} 失败`);
  if (bad.length) process.exit(1);
})().catch((e) => {
  console.error("\n测试异常：", e);
  process.exit(2);
});
