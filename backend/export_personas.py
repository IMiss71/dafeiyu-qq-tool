# -*- coding: utf-8 -*-
"""
导出 / 列出 AstrBot 的人设（personas）。

personas 存在 AstrBot 的 SQLite 里（data/data_v4.db），纯 Python 标准库读取，零依赖。
用法：
    python export_personas.py            # 列出所有人设（JSON）
    python export_personas.py --set <id> # 把某个人设设为默认
"""
import json
import os
import sqlite3
import sys


def db_path():
    # 与 deploy.js 保持一致：沙盒在 %LOCALAPPDATA%\DaFeiYuQQ
    base = os.environ.get('LOCALAPPDATA') or os.path.expanduser('~')
    root = os.path.join(base, 'DaFeiYuQQ')
    data = os.path.join(root, 'data')
    for name in ('data_v4.db', 'astrbot.db', 'data.db'):
        p = os.path.join(data, name)
        if os.path.exists(p):
            return p
    return os.path.join(data, 'data_v4.db')


def main():
    p = db_path()
    if not os.path.exists(p):
        print(json.dumps({'ok': False, 'error': '还没有人设数据（AstrBot 至少要成功启动过一次才会建库）', 'path': p}, ensure_ascii=False))
        return 0
    con = sqlite3.connect(p)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    try:
        cur.execute('SELECT * FROM personas')
    except Exception as e:  # 表还不存在
        print(json.dumps({'ok': False, 'error': f'读取人设表失败：{e}', 'path': p}, ensure_ascii=False))
        return 0
    rows = [dict(r) for r in cur.fetchall()]

    set_id = None
    if '--set' in sys.argv:
        i = sys.argv.index('--set')
        if i + 1 < len(sys.argv):
            set_id = sys.argv[i + 1]
    if set_id:
        try:
            cur.execute('UPDATE personas SET is_default = 0')
            cur.execute('UPDATE personas SET is_default = 1 WHERE id = ?', (set_id,))
            con.commit()
        except Exception as e:
            print(json.dumps({'ok': False, 'error': f'设置默认人设失败：{e}'}, ensure_ascii=False))
            return 0

    out = []
    for r in rows:
        # 只回传有用的字段，prompt 可能很长，截断一点点避免刷屏
        prompt = r.get('prompt') or ''
        out.append({
            'id': r.get('id'),
            'name': r.get('name') or r.get('persona_id') or r.get('id'),
            'is_default': bool(r.get('is_default')),
            'created_at': r.get('created_at'),
            'updated_at': r.get('updated_at'),
            'prompt_len': len(prompt),
            'prompt': prompt[:200],
        })
    print(json.dumps({'ok': True, 'path': p, 'set': set_id, 'personas': out}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
