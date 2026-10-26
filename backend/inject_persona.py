#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
inject_persona.py —— 把大肥鱼人设直接写进 AstrBot 的 SQLite 数据库（personas 表），
无需打开仪表盘、无需复制粘贴。

用法（由 backend/deploy.js 调用）：
  python inject_persona.py --data-dir <AstrBot data 目录> \
                           --id dafeiyu --name 大肥鱼 --prompt-file <人设文本路径>

特性：
  1. 自适应查找数据库：在 data-dir 下搜索含 personas 表的 *.db 文件。
  2. 自适应表结构：用 PRAGMA table_info 探测真实列名，只写存在的列，
     兼容 AstrBot 不同版本（prompt / system_prompt 字段名差异）。
  3. 幂等：persona_id 已存在则更新，不存在则插入。
"""
import argparse
import datetime
import glob
import json
import os
import sqlite3
import sys
import time


def norm_forward(p):
    """返回干净的正斜杠绝对路径。sqlite3 在本环境只对正斜杠绝对路径可靠。"""
    return os.path.abspath(p).replace("\\", "/")


def find_db(data_dir):
    """在 data-dir 下找到含 personas 表的 sqlite 文件。"""
    candidates = []
    # 也允许直接传入 db 路径
    if os.path.isfile(data_dir) and data_dir.endswith(".db"):
        candidates.append(norm_forward(data_dir))
    else:
        data_dir = norm_forward(data_dir)
        try:
            for fn in os.listdir(data_dir):
                if fn.endswith(".db"):
                    candidates.append(norm_forward(os.path.join(data_dir, fn)))
        except Exception:
            pass
    for p in candidates:
        try:
            con = sqlite3.connect(p, timeout=10)
            cur = con.cursor()
            cur.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='personas'"
            )
            if cur.fetchone():
                con.close()
                return p
            con.close()
        except Exception:
            continue
    return None


def inject(db_path, pid, name, prompt, begin_dialogs="[]"):
    db_path = norm_forward(db_path)
    con = sqlite3.connect(db_path, timeout=10)
    con.execute("PRAGMA busy_timeout=10000")
    cur = con.cursor()

    # 探测真实列名
    cur.execute("PRAGMA table_info(personas)")
    cols = {row[1] for row in cur.fetchall()}

    # 确定“系统提示词”列名：优先 prompt，回退 system_prompt
    prompt_col = None
    if "prompt" in cols:
        prompt_col = "prompt"
    elif "system_prompt" in cols:
        prompt_col = "system_prompt"

    # 组装要写入的字段
    # 注意：AstrBot 4.29 的 personas 表没有 name 列（只有 persona_id），
    # 所以 name 只在列确实存在时才写，否则会报 "table personas has no column named name"
    values = {"persona_id": pid}
    if name and "name" in cols:
        values["name"] = name
    if prompt_col:
        values[prompt_col] = prompt
    if "begin_dialogs" in cols:
        values["begin_dialogs"] = begin_dialogs
    if "sort_order" in cols:
        values["sort_order"] = 0
    if "tools" in cols:
        values["tools"] = None  # None = 允许全部工具
    if "skills" in cols:
        values["skills"] = None  # None = 允许全部技能
    if "custom_error_message" in cols:
        values["custom_error_message"] = ""
    if "folder_id" in cols:
        values["folder_id"] = None
    # SQLModel 的 TimestampMixin：created_at / updated_at 都是 NOT NULL
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")
    for ts_col in ("created_at", "updated_at"):
        if ts_col in cols:
            values[ts_col] = now

    col_names = list(values.keys())
    placeholders = ", ".join("?" for _ in col_names)
    col_list = ", ".join(col_names)
    # created_at 不该被覆盖
    update_list = ", ".join(
        f"{c}=excluded.{c}"
        for c in col_names
        if c not in ("persona_id", "created_at")
    )

    if update_list:
        sql = (
            f"INSERT INTO personas ({col_list}) VALUES ({placeholders}) "
            f"ON CONFLICT(persona_id) DO UPDATE SET {update_list}"
        )
    else:
        sql = f"INSERT INTO personas ({col_list}) VALUES ({placeholders})"

    # AstrBot 正在运行时可能短暂持有写锁（虽然 WAL 模式大多能并发）。
    # 这里用 busy_timeout + 重试双保险，避免一次 SQLITE_BUSY 就整条失败。
    params = [values[c] for c in col_names]
    last_err = None
    for attempt in range(5):
        try:
            cur.execute(sql, params)
            con.commit()
            break
        except sqlite3.OperationalError as e:
            last_err = e
            if "busy" in str(e).lower():
                time.sleep(0.5 * (attempt + 1))
                continue
            raise
    else:
        con.close()
        raise last_err if last_err else RuntimeError("写入数据库失败（未知原因）")
    con.close()

    return {
        "ok": True,
        "persona_id": pid,
        "db": db_path,
        "prompt_col": prompt_col,
        "written": col_names,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True, help="AstrBot data 目录")
    ap.add_argument("--id", default="dafeiyu")
    ap.add_argument("--name", default="大肥鱼")
    ap.add_argument("--prompt-file", required=True, help="人设系统提示词文本文件路径")
    args = ap.parse_args()

    if not os.path.isdir(args.data_dir):
        print(json.dumps({"ok": False, "error": f"data 目录不存在: {args.data_dir}"}))
        sys.exit(1)

    try:
        with open(args.prompt_file, "r", encoding="utf-8") as f:
            prompt = f.read().strip()
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"读取人设文件失败: {e}"}))
        sys.exit(1)

    if not prompt:
        print(json.dumps({"ok": False, "error": "人设文本为空"}))
        sys.exit(1)

    db = find_db(args.data_dir)
    if not db:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "未找到 AstrBot 的数据库（personas 表）。请先完成「安装并初始化 AstrBot」步骤。",
                }
            )
        )
        sys.exit(1)

    try:
        result = inject(db, args.id, args.name, prompt)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"写入数据库失败: {e}"}))
        sys.exit(1)


if __name__ == "__main__":
    main()
