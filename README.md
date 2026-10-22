# Seek answer · 嵌入式 & PCB 学习日志

个人学习博客，纯静态页面，**没有构建步骤**。

站点：<https://2041951416.github.io/>

---

## 直接在网页上编辑（推荐）

打开 <https://2041951416.github.io/edit.html> 登录后就能改文章、学习计划和首页文案，
不用碰 Git。

### 第一次要做的准备（约两分钟）

1. GitHub → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**
2. **Generate new token**，名称随便填（比如 `blog-editor`）
3. **Repository access** → **Only select repositories** → 只勾 `2041951416.github.io`
4. **Repository permissions** → 找到 **Contents** → 选 **Read and write**
   （其余全部保持 No access，尤其是 Workflows 不要给）
5. **Expiration** 建议设 90 天
6. 点 Generate，复制 `github_pat_` 开头的字符串

回到 <https://2041951416.github.io/edit.html>，粘贴到输入框，点「保存并验证」。
验证通过后会一直记住，直到你点「退出登录」。

### 这个 token 有多大权力

| 能做 | 不能做 |
|---|---|
| 改这个仓库里的任何文件（文章、页面、样式） | ❌ 改 `.github/workflows/`（GitHub 服务端强制拒绝） |
| 提交、建分支 | ❌ 删除仓库 |
| | ❌ 改仓库设置 |
| | ❌ 访问你的其它仓库（token 只授权了这一个） |

**但要清楚**：拿到这个 token 的人能改你的网站。所以
- 只在自己的设备上登录
- 不要粘贴到聊天、帖子或录屏里
- 不用了就点「退出登录」，或者去 GitHub 撤销 token

### 能改什么

| 入口 | 能做的事 |
|---|---|
| 文章页的「编辑 / 删除」 | 改标题、标签、摘要、正文 |
| 随笔页、知识点页的「新建」 | 写新文章 |
| 学习计划页的「编辑路线」 | 增删改阶段和任务、调整顺序 |
| `edit.html?site=1` | 改站名、首页标题、简介、各页导语 |

导航标签、页脚文案、浏览器标题是固定的 —— 它们写错会导致入口失效，所以不开放编辑。

**改任务的 id 会丢进度。** 进度是按 id 记的，编辑器会在你点「改 id」时提示影响多少条记录。
只改标题永远安全。

保存后大约 30 秒自动发布，编辑器会自己探测并提示「已上线」。

---

## 手动改文件（网页编辑器不好使时的退路）

### 我要发一篇新随笔

**一共两步。**

### 1. 新建文章文件

在 `content/posts/` 下建一个 `.md` 文件，文件名就是文章的 slug（网址锚点）。

文件名规则：全小写、用连字符、不要中文和空格。例如 `stm32-first-led.md`。

文件开头必须是 front matter：

```markdown
---
title: 文章标题
tags: 标签一, 标签二
summary: 一句话摘要，显示在列表里。
date: 2026-10-22
---

正文从这里开始。

## 二级标题

正文支持标准 Markdown：列表、表格、代码块、引用。
```

`tags` 用英文逗号分隔。`date` 用 `YYYY-MM-DD`。

### 2. 在清单里登记

打开 `content/index.json`，在 `posts` 数组里加一条（放在最前面就是最新）：

```json
{
  "slug": "stm32-first-led",
  "title": "文章标题",
  "date": "2026-10-22",
  "tags": ["标签一", "标签二"],
  "summary": "一句话摘要。"
}
```

`slug` 必须和文件名（去掉 `.md`）完全一致。

### 在 GitHub 网页上怎么做

1. 打开仓库 → `content/posts/` → **Add file** → **Create new file**
2. 文件名填 `xxx.md`，粘贴内容
3. 提交
4. 再打开 `content/index.json` → 铅笔图标编辑 → 加一条 → 提交

两次提交后，等几十秒，站点就更新了。

---

### 我要加一条知识点

流程和上面**完全一样**，只是：

- 文件放 `content/notes/`
- 登记到 `content/index.json` 的 `notes` 数组

知识点和随笔的区别只是列表页的展示方式（知识点是卡片网格 + 全文搜索，随笔是时间线列表）。

---

### 我要改学习路线

编辑 `content/plan.json`。结构是：

```json
{
  "phases": [
    {
      "id": "p1",
      "title": "阶段名称",
      "tasks": [
        { "id": "p1-t1", "title": "任务描述" }
      ]
    }
  ]
}
```

**三条铁律：**

1. **已经勾选过的任务，绝对不要改 `id`。** 进度是按 id 记的，改了 id 就等于那个勾选凭空消失。
2. **`id` 不要重复。** 阶段用 `p1`、`p2`…，任务用 `p1-t1`、`p1-t2`…
3. **想加任务就新起一个 id**，比如在 p1 末尾加 `p1-t7`。想删任务直接删掉那一条即可（已完成的记录会变成无效数据，不影响使用）。

可选：给任务加 `"ref": "笔记的slug"`，会在任务后面显示一个跳转箭头，点进去看对应的知识点页。

---

### 我要开启云同步（多设备）

不开启也能用，勾选记录只存在当前浏览器。开启后自动同步到你自己的私有 Gist。

### 步骤

1. 打开 GitHub → **Settings** → **Developer settings**
2. 左栏 **Personal access tokens** → **Tokens (classic)**
3. **Generate new token (classic)**
4. Note 随便填（比如 `blog`），Expiration 选你觉得合适的
5. **只勾选 `gist` 这一个 scope**，其他全部不勾
6. 点 Generate，复制生成的 token（只显示一次）
7. 回到网站 → 学习计划页 → 最下面「云同步设置」→ 粘贴 token → 保存并连接

第一次勾选任务时，会自动创建一个私有 Gist 保存状态。Gist ID 会自动写回输入框。

### 注意

> **不能用 fine-grained token（细粒度 token）。** GitHub 的细粒度 token 不支持 Gist API。
> 必须是 **classic** token，并且勾 `gist` scope。

### 冲突怎么处理

两台设备都改过时，采用**并集合并**：所有已完成的任务取合并，打卡日期取合并，同一条记录保留更早的完成日期。

**不会丢数据。** 代价是：在一台设备上取消勾选，不会同步到另一台——需要两边都点一次「✕」取消。

### Token 存在哪里，安全吗

存在浏览器 `localStorage`，不上传到任何第三方。

风险是真实的，但可控：

- 你只给 `gist` 一个 scope，这个 token **不能读写任何代码仓库**，也不能改账号设置
- 随时可以在 GitHub 上一键撤销
- 这个站点没有服务端，也没有任何接收用户输入的地方

可能泄露的途径：本站出现 XSS 漏洞、装了能读该站点数据的浏览器扩展、别人用了你的电脑。
所以：**不要把 token 贴进聊天窗口或录屏里。** 一旦不小心贴了，立刻去 GitHub 撤销重发。

### 不用云同步的兜底

学习计划页有「导出 JSON」和「导入 JSON」。定期导出一份放着，换设备时导入即可。

---

## 本地预览

`fetch()` 在 `file://` 下会被浏览器拦截，所以必须起一个本地服务：

```powershell
cd C:\Users\20419\github-pages
D:\python311\python.exe -m http.server 8000 --bind 127.0.0.1
```

然后打开 <http://localhost:8000/>

> 注意用 `localhost` 而不是 `127.0.0.1`，部分浏览器只把 `localhost` 当作安全上下文。

改完文件刷新页面即可，不用重启服务。

---

## 发完文章检查一遍

```powershell
D:\python311\python.exe tools\check.py
```

会检查：

- `index.json` 里登记的每一条，文件是否真的存在
- 有没有文件建了但忘了登记
- front matter 和 `index.json` 的标题、标签是否对得上
- slug 有没有重复
- `plan.json` 的任务 id 有没有重复

只读，不会改任何文件。

---

## 目录结构

```
.
├── index.html              概览仪表盘
├── plan.html               学习计划 + 打卡
├── notes.html              知识点（卡片 + 全文搜索）
├── posts.html              随笔列表
├── post.html               单篇阅读器（?p=slug 路由，带目录）
├── edit.html               网页编辑器（文章 / 计划 / 站点文案）
├── .github/workflows/
│   └── pages.yml           部署流水线：推送 main 即自动发布
├── assets/
│   ├── style.css           全部样式（设计 token 在 :root）
│   ├── theme.js            深色模式，同步执行防闪屏
│   ├── app.js              取数、状态合并、进度、日历、Gist 同步
│   └── editor.js           编辑器的提交原语、front matter、文案渲染
├── content/
│   ├── index.json          ★ 内容清单，加文章要改这里
│   ├── plan.json           ★ 学习路线，改进度要改这里
│   ├── site.json           ★ 站名、首页标题、各页导语
│   ├── notes/*.md          知识点
│   └── posts/*.md          随笔
└── tools/
    ├── check.py            一致性检查
    ├── test-commit.js      提交原语对真实 API 的测试
    └── test-editor.js      编辑器 UI 测试（拦截请求，不碰真实仓库）
```

---

## 换个颜色 / 改字体

打开 `assets/style.css`，最顶上就是：

```css
:root {
  --bg: #fafaf9;        /* 背景 */
  --ink: #1a1a1a;       /* 正文 */
  --accent: #b87333;    /* 强调色（铜） */
  --content: 720px;     /* 正文栏宽 */
  --serif: Georgia, ...; /* 标题字体 */
}
```

改 `--accent` 就能整体换色调。深色模式在下面的 `[data-theme="dark"]` 里，对应改一遍即可。

---

## 一些实现细节（日后回头看时有用）

- **没有构建**：所有页面都是手写 HTML，直接在 GitHub Pages 上跑。加内容不需要跑任何命令。
- **为什么有 `content/index.json`**：GitHub Pages 不能列目录，浏览器也没法知道 `content/posts/` 里有几个文件，所以必须有一份清单。
- **marked 锁在 18.1.1**：新版不再提供 `marked.min.js`，路径是 `lib/marked.umd.js`。升级前先确认文件名。
- **进度和路线分开存**：`plan.json` 在 git 里（版本化、可回溯），进度在 Gist/localStorage。混在一起会互相覆盖。
- **合并用并集**：联网后 `本地 ∪ 远端`，所以任何一台设备的记录都不会被另一台覆盖掉。
- **`.nojekyll`**：让 GitHub Pages 跳过 Jekyll 处理，避免下划线开头的文件出问题。
- **为什么用 Actions 部署而不是分支发布**：分支发布（legacy）模式下，删掉的文件可能长期残留在发布产物里——曾经删除的 `cnc-app/` 就这样在线上存活了几个月，且源站已无该文件却仍返回 200。改用 Actions 后每次 push 都生成一份全新 artifact，删除立即生效。`upload-pages-artifact` 会自动排除 `.git` 和 `.github`。
- **改完推送就行**：不再需要手动触发部署。`main` 分支一推，workflow 自动构建发布，约 30 秒。
- **编辑器为什么一次提交改两个文件**：改一篇文章要同时动 `.md` 和 `index.json`。分两次提交的话，中间失败会留下「清单指向不存在的文件」。所以用 Git Data API 的 blob → tree → commit → ref 一次性完成。
- **编辑器的请求必须禁用 HTTP 缓存**：GitHub 的 `git/ref` 端点返回 `Cache-Control: max-age=60`，读到缓存的旧 ref 就会基于过期 base 建提交，PATCH 必现 422「Update is not a fast forward」。代码里所有请求都带 `cache: "no-store"`。
- **为什么菜单上的导航不做成 JS 渲染**：品牌和导航写死在 HTML 里，`site.json` 只异步替换文本。这样即使请求失败或很慢，页面也不会闪出空白。
