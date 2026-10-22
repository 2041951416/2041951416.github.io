#!/usr/bin/env python3
"""检查 content/index.json 与实际 Markdown 文件是否一致。

只读，不修改任何文件。发完文章跑一遍：

    py tools/check.py

检查项：
  1. index.json 里登记的每一条，对应文件是否存在
  2. 每个存在的 .md 文件，是否在 index.json 里登记过（防止漏登记）
  3. front matter 的 title / tags 与 index.json 是否冲突
  4. slug 是否重复、是否含有不安全的字符
  5. plan.json 的任务 id 是否唯一
"""

import json
import os
import re
import sys

# Windows 终端默认 GBK，强制 UTF-8 输出避免 UnicodeEncodeError
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONTENT = os.path.join(ROOT, "content")

SAFE_SLUG = re.compile(r"^[a-z0-9][a-z0-9\-_]*$")
errors = []
warnings = []


def read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def parse_front_matter(raw):
    raw = raw.lstrip("﻿")
    m = re.match(r"^---\r?\n(.*?)\r?\n---\r?\n?", raw, re.S)
    if not m:
        return {}
    meta = {}
    for line in m.group(1).splitlines():
        if ":" not in line:
            continue
        k, v = line.split(":", 1)
        k, v = k.strip(), v.strip()
        if not k:
            continue
        if k == "tags":
            meta[k] = [t.strip() for t in v.split(",") if t.strip()]
        else:
            meta[k] = v
    return meta


def check_section(manifest, key, folder):
    entries = manifest.get(key, [])
    seen = set()
    listed = set()
    dirpath = os.path.join(CONTENT, folder)

    if not os.path.isdir(dirpath):
        errors.append(f"缺少目录 content/{folder}/")
        return

    for e in entries:
        slug = e.get("slug", "")
        if not slug:
            errors.append(f"content/index.json 的 {key} 中有一条缺少 slug")
            continue
        if slug in seen:
            errors.append(f"{key}: slug 重复 —— {slug}")
        seen.add(slug)
        listed.add(slug)

        if not SAFE_SLUG.match(slug):
            warnings.append(
                f"{key}/{slug}: slug 建议只用小写字母、数字和连字符（当前：{slug}）"
            )

        path = os.path.join(dirpath, slug + ".md")
        if not os.path.isfile(path):
            errors.append(f"{key}/{slug}: index.json 登记了，但找不到 content/{folder}/{slug}.md")
            continue

        meta = parse_front_matter(read_text(path))
        if not meta:
            warnings.append(f"{key}/{slug}: 没有 front matter（建议加上 title/tags/summary/date）")
            continue

        mt = meta.get("title", "").strip()
        if mt and mt != e.get("title", "").strip():
            warnings.append(
                f"{key}/{slug}: 标题不一致 —— index.json「{e.get('title')}」 vs 文件「{mt}」"
            )
        if not mt and not e.get("title"):
            errors.append(f"{key}/{slug}: index.json 和 front matter 都没有标题")

        mtags = set(meta.get("tags", []))
        etags = set(e.get("tags", []))
        if mtags and etags and mtags != etags:
            warnings.append(f"{key}/{slug}: 标签不一致 —— {sorted(mtags)} vs {sorted(etags)}")

        if not e.get("date"):
            warnings.append(f"{key}/{slug}: index.json 缺少 date")

    # 反向检查：目录里有文件但没登记
    for fn in sorted(os.listdir(dirpath)):
        if not fn.endswith(".md"):
            continue
        slug = fn[:-3]
        if slug not in listed:
            errors.append(f"content/{folder}/{fn} 存在，但没在 index.json 的 {key} 里登记")


def check_plan():
    path = os.path.join(CONTENT, "plan.json")
    if not os.path.isfile(path):
        errors.append("缺少 content/plan.json")
        return
    try:
        plan = json.loads(read_text(path))
    except json.JSONDecodeError as e:
        errors.append(f"content/plan.json 不是合法 JSON：{e}")
        return

    phases = plan.get("phases", [])
    if not phases:
        warnings.append("content/plan.json 里没有任何阶段")
        return

    task_ids = set()
    phase_ids = set()
    total = 0
    for ph in phases:
        pid = ph.get("id", "")
        if not pid:
            errors.append("plan.json 有阶段缺少 id")
        elif pid in phase_ids:
            errors.append(f"plan.json: 阶段 id 重复 —— {pid}")
        phase_ids.add(pid)

        tasks = ph.get("tasks", [])
        if not tasks:
            warnings.append(f"plan.json: 阶段 {pid or ph.get('title')} 没有任务")
        for t in tasks:
            total += 1
            tid = t.get("id", "")
            if not tid:
                errors.append(f"plan.json: 阶段 {pid} 有任务缺少 id")
                continue
            if tid in task_ids:
                errors.append(f"plan.json: 任务 id 重复 —— {tid}")
            task_ids.add(tid)
            if not t.get("title"):
                errors.append(f"plan.json: 任务 {tid} 缺少 title")

    print(f"  阶段 {len(phases)} 个，任务 {total} 项")


def main():
    idx_path = os.path.join(CONTENT, "index.json")
    if not os.path.isfile(idx_path):
        print("✗ 找不到 content/index.json")
        return 1

    try:
        manifest = json.loads(read_text(idx_path))
    except json.JSONDecodeError as e:
        print(f"✗ content/index.json 不是合法 JSON：{e}")
        return 1

    print("检查内容清单…")
    check_section(manifest, "posts", "posts")
    check_section(manifest, "notes", "notes")
    print(
        f"  随笔 {len(manifest.get('posts', []))} 篇，"
        f"知识点 {len(manifest.get('notes', []))} 条"
    )

    print("检查学习路线…")
    check_plan()

    print()
    if warnings:
        print(f"⚠ {len(warnings)} 个提醒：")
        for w in warnings:
            print(f"  · {w}")
        print()

    if errors:
        print(f"✗ {len(errors)} 个错误：")
        for e in errors:
            print(f"  · {e}")
        return 1

    print("✓ 全部一致。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
