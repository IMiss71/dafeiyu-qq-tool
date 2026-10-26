# -*- coding: utf-8 -*-
"""
AstrBot 补丁：去掉语音末尾那一大段空白（AGPL 第 13 条要求的"公开你的改动"）

背景
----
AstrBot 4.29.x 的 `core/provider/sources/edge_tts_source.py` 在把 mp3 转 wav 时写了：

    "-af", "apad=pad_dur=2",  # 确保输出时长准确

也就是**每句语音结尾都强行补 2 秒静音**。叠加 edge_tts 自身在句尾留的约 0.76 秒静音，
QQ 里听到的就是"说完之后要空白两三秒才结束"，短句尤其明显（1.8 秒的话 + 2.8 秒空白）。

改动
----
把补白的滤镜换成"先裁掉尾部静音，再只留 0.2 秒自然收尾"：

    "silenceremove=stop_periods=-1:stop_duration=0.1:stop_threshold=-50dB,apad=pad_dur=0.2"

实测 4.01 秒（含 0.76 秒空白）的样本裁剪后为 3.41 秒，尾部无长静音。

用法
----
    python apply_astrbot_tts_trim_patch.py

会自动给所有找到的 AstrBot 安装（uvx 的 cache archive + uv tool）打补丁。
幂等：文件里已出现 `silenceremove` 就跳过。AstrBot 升级覆盖文件后需重跑一次。
"""
import glob
import os
import re
import sys

TARGET_REL = os.path.join('core', 'provider', 'sources', 'edge_tts_source.py')
PAD_ANCHOR = '"apad=pad_dur=2"'
NEW_FILTER = '"silenceremove=stop_periods=-1:stop_duration=0.1:stop_threshold=-50dB,apad=pad_dur=0.2"'


def find_astrbot_dirs():
    """AstrBot 可能装在多处：uvx 用的是 uv cache archive，uv tool install 用的是 APPDATA。"""
    roots = []
    local = os.environ.get('LOCALAPPDATA') or ''
    cache = os.path.join(local, 'uv', 'cache', 'archive-v0')
    if os.path.isdir(cache):
        for entry in sorted(glob.glob(os.path.join(cache, '*', 'Lib', 'site-packages', 'astrbot'))):
            if os.path.isdir(entry):
                roots.append(entry)
    appdata = os.environ.get('APPDATA') or ''
    p = os.path.join(appdata, 'uv', 'tools', 'astrbot', 'Lib', 'site-packages', 'astrbot')
    if os.path.isdir(p):
        roots.append(p)
    return roots


def find_targets():
    out = []
    for root in find_astrbot_dirs():
        p = os.path.join(root, TARGET_REL)
        if os.path.exists(p):
            out.append(p)
    return out


def patch(path):
    with open(path, 'r', encoding='utf-8') as f:
        raw = f.read()
    if 'silenceremove' in raw:
        return 'SKIPPED', '已经打过补丁'
    if PAD_ANCHOR not in raw:
        return 'FAILED', '未找到 apad=pad_dur=2（AstrBot 版本可能不同，请人工确认）'
    # 顺带把那句会误导人的注释一起换掉
    raw2 = raw.replace(PAD_ANCHOR, NEW_FILTER)
    raw2 = re.sub(
        r'(apad=pad_dur=0\.2",[ \t]*)#[^\n]*',
        r'\1# 裁掉尾部空白（原版在这里强行补 2 秒静音）',
        raw2,
        count=1,
    )
    with open(path, 'w', encoding='utf-8') as f:
        f.write(raw2)
    return 'PATCHED', path


def main():
    paths = sys.argv[1:] or find_targets()
    if not paths:
        print('FAILED: 找不到 edge_tts_source.py，请先安装并启动过一次 AstrBot，或手动传入路径')
        return 1
    ok = True
    for p in paths:
        status, info = patch(p)
        print(f'{status}: {info}')
        if status == 'FAILED':
            ok = False
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
