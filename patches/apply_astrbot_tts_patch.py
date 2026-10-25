# -*- coding: utf-8 -*-
"""
AstrBot 补丁：让 force_tts / no_tts 真正生效（AGPL 第 13 条要求的"公开你的改动"）

背景
----
AstrBot 4.29.1 的 `core/pipeline/result_decorate/stage.py` 里，是否朗读只由概率决定：

    should_tts = enable and is_llm_result() and ... and random.random() <= self.tts_trigger_probability

它完全不读插件通过 `event.set_extra("force_tts", True)` 设的标记，于是
"你说发语音它就发语音"这类插件形同虚设，表现为"让它发语音也不发，只能靠概率撞上"。

改动
----
把上面那一行等价替换为：

    and (
        bool(event.get_extra("force_tts"))
        or (not event.get_extra("no_tts")
            and random.random() <= self.tts_trigger_probability)
    )

即：插件显式要求发语音 → 必发；插件显式要求别发 → 不发；都没说 → 仍按原概率。

用法
----
    python apply_astrbot_tts_patch.py                 # 自动定位常见安装路径
    python apply_astrbot_tts_patch.py <stage.py 路径> # 手动指定

幂等：已经打过（文件里出现 `_force_tts`）就跳过。AstrBot 升级覆盖文件后需重跑一次。
"""
import os
import re
import sys

TARGET_REL = os.path.join('core', 'pipeline', 'result_decorate', 'stage.py')
ANCHOR = 'and random.random() <= self.tts_trigger_probability'
# 注意：幂等标记必须是补丁真正写进去的内容。
# 早期版本用 '_force_tts' 判断，但插入的文本是 get_extra("force_tts")（前面是引号不是下划线），
# 于是每次都判定"没打过"，重复打补丁时正则又匹配不上，刷出一堆 FAILED 假象。
MARK = 'event.get_extra("force_tts")'


def candidates():
    """AstrBot 可能装在多处：uvx 实际跑的是 uv 的 cache archive，uv tool install 在 APPDATA。
    只找 APPDATA 会漏掉真正生效的那一份（表现为"打过补丁了但没变化"）。"""
    import glob

    out = []
    local = os.environ.get('LOCALAPPDATA') or ''
    cache = os.path.join(local, 'uv', 'cache', 'archive-v0')
    if os.path.isdir(cache):
        out.extend(sorted(glob.glob(os.path.join(cache, '*', 'Lib', 'site-packages', 'astrbot', TARGET_REL))))
    appdata = os.environ.get('APPDATA') or ''
    out.append(os.path.join(appdata, 'uv', 'tools', 'astrbot', 'Lib', 'site-packages', 'astrbot', TARGET_REL))
    return out


def find_targets():
    return [c for c in candidates() if os.path.exists(c)]


def patch(path):
    with open(path, 'r', encoding='utf-8') as f:
        raw = f.read()
    if '_force_tts' in raw:
        return 'SKIPPED', '已经打过补丁'
    m = re.search(r'^([ \t]+)' + re.escape(ANCHOR) + r'[ \t]*$', raw, re.M)
    if not m:
        return 'FAILED', '未匹配到目标代码（AstrBot 版本可能不同，请人工确认）'
    indent = m.group(1)
    nl = '\r\n' if '\r\n' in raw else '\n'
    inner = indent + '    '
    replacement = nl.join([
        indent + 'and (',
        inner + 'bool(event.get_extra("force_tts"))',
        inner + 'or (not event.get_extra("no_tts")',
        inner + '    and random.random() <= self.tts_trigger_probability)',
        indent + ')',
    ])
    with open(path, 'w', encoding='utf-8') as f:
        f.write(raw[:m.start()] + replacement + raw[m.end():])
    return 'PATCHED', path


def main():
    paths = sys.argv[1:] or find_targets()
    if not paths:
        print('FAILED: 找不到 stage.py，请先安装并启动过一次 AstrBot，或手动传入路径')
        return 1
    ok = True
    for path in paths:
        status, info = patch(path)
        print(f'{status}: {info}')
        if status == 'FAILED':
            ok = False
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
