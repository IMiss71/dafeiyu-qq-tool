#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把 dafeiyu_backup_20261024 里的 12 个插件 + 插件配置/数据/知识库 恢复到当前 AstrBot 数据目录。

用法: python tools/restore_plugins.py [--backup-dir <路径>] [--dry]
原则: 只增不改 —— 现有 data_v4.db / cmd_config.json 一律不动，
      插件配置若目标已存在则先备份为 .pre_restore.bak 再覆盖。
"""
import os
import shutil
import sys
import glob
from datetime import datetime

NEW_DATA = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'DaFeiYuQQ', 'data')
DEFAULT_BACKUP = os.path.join(os.path.expanduser('~'), 'dafeiyu_backup_20261024')


def main():
    dry = '--dry' in sys.argv
    backup_dir = DEFAULT_BACKUP
    if '--backup-dir' in sys.argv:
        backup_dir = sys.argv[sys.argv.index('--backup-dir') + 1]

    if not os.path.isdir(backup_dir):
        print('备份目录不存在:', backup_dir)
        return 1
    if not os.path.isdir(NEW_DATA):
        print('AstrBot 数据目录不存在:', NEW_DATA)
        return 1

    stamp = datetime.now().strftime('%Y%m%d_%H%M%S')
    safety = os.path.join(NEW_DATA, '_pre_plugin_restore_' + stamp)
    report = []

    def ensure(d):
        if not dry:
            os.makedirs(d, exist_ok=True)

    def copy_item(src, dst, label):
        if not os.path.exists(src):
            report.append(('SKIP', label, '源不存在 ' + src))
            return
        if os.path.exists(dst):
            try:
                bak = dst.rstrip('\\/') + '.pre_restore.bak'
                if not dry:
                    if os.path.isdir(dst):
                        shutil.copytree(dst, bak, dirs_exist_ok=True)
                    else:
                        shutil.copy2(dst, bak)
                report.append(('BAK', label, os.path.basename(bak)))
            except Exception as e:
                report.append(('WARN', label, '备份失败 %s' % e))
        try:
            if not dry:
                if os.path.isdir(src):
                    shutil.copytree(src, dst, dirs_exist_ok=True)
                else:
                    shutil.copy2(src, dst)
            report.append(('COPY', label, '%s -> %s' % (src, dst)))
        except Exception as e:
            report.append(('FAIL', label, str(e)))

    # 0) 安全快照：只保护两个关键配置文件
    ensure(safety)
    for f in ('data_v4.db', 'cmd_config.json', 'config.json'):
        p = os.path.join(NEW_DATA, f)
        if os.path.exists(p) and not dry:
            shutil.copy2(p, os.path.join(safety, f))
    report.append(('SAFE', '安全快照', safety))

    # 1) 插件代码
    plugins_src = os.path.join(backup_dir, 'plugins')
    plugins_dst = os.path.join(NEW_DATA, 'plugins')
    ensure(plugins_dst)
    for name in sorted(os.listdir(plugins_src)):
        s = os.path.join(plugins_src, name)
        if os.path.isdir(s):
            copy_item(s, os.path.join(plugins_dst, name), 'plugin:' + name)

    # 2) 插件运行数据（记忆、表情包索引等）
    pd_src = os.path.join(backup_dir, 'plugin_data')
    pd_dst = os.path.join(NEW_DATA, 'plugin_data')
    if os.path.isdir(pd_src):
        ensure(pd_dst)
        for name in sorted(os.listdir(pd_src)):
            s = os.path.join(pd_src, name)
            copy_item(s, os.path.join(pd_dst, name), 'data:' + name)

    # 3) 插件配置（跳过 .bak / .db）
    cfg_src = os.path.join(backup_dir, 'config')
    cfg_dst = os.path.join(NEW_DATA, 'config')
    if os.path.isdir(cfg_src):
        ensure(cfg_dst)
        for f in sorted(os.listdir(cfg_src)):
            if not f.endswith('_config.json'):
                continue
            copy_item(os.path.join(cfg_src, f), os.path.join(cfg_dst, f), 'cfg:' + f)

    # 4) 知识库
    kb_src = os.path.join(backup_dir, 'knowledge_base')
    kb_dst = os.path.join(NEW_DATA, 'knowledge_base')
    if os.path.isdir(kb_src):
        ensure(kb_dst)
        for f in sorted(os.listdir(kb_src)):
            if f.startswith('kb.db'):
                copy_item(os.path.join(kb_src, f), os.path.join(kb_dst, f), 'kb:' + f)

    for k, a, b in report:
        print('%-5s %-28s %s' % (k, a, b))
    print('\n完成。%s' % ('（演练模式，未落盘）' if dry else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main())
