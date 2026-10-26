#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""把「免费侧」的 provider 接回 AstrBot：本地向量（Ollama）+ 语音（Edge TTS）。

这两样都是零 token 成本的：embedding 走本机 Ollama，TTS 走微软 Edge 免费接口。
换机器 / 重装后跑一次即可，AstrBot 需要重启才生效。

用法:
  python tools/wire_providers.py                # 两个都接
  python tools/wire_providers.py --only tts
  python tools/wire_providers.py --only embedding
  python tools/wire_providers.py --dry          # 只看会改什么
  python tools/wire_providers.py --tts-prob 0.3 # 语音触发概率（默认沿用备份值 0.3）
"""
import json
import os
import shutil
import sys

try:  # py3
    import urllib.request as _u
except ImportError:  # pragma: no cover
    _u = None

NEW_DATA = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'DaFeiYuQQ', 'data')
DEFAULT_BACKUP = os.path.join(os.path.expanduser('~'), 'dafeiyu_backup_20261024')
OLLAMA_PORT = 11434


def load(p):
    return json.load(open(p, encoding='utf-8-sig'))


def save(p, d, bom=True):
    # cmd_config.json 原文件带 BOM；但**插件配置绝对不能带 BOM** —— AstrBot 的 json 解析
    # 会直接失败，插件读到空配置，表现为"装了却完全没效果"且日志一句错都不报。
    enc = 'utf-8-sig' if bom else 'utf-8'
    with open(p, 'w', encoding=enc, newline='') as f:
        json.dump(d, f, ensure_ascii=False, indent=2)


def ollama_alive(port=OLLAMA_PORT):
    if not _u:
        return False
    try:
        with _u.urlopen('http://127.0.0.1:%d/api/tags' % port, timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def ollama_models(port=OLLAMA_PORT):
    if not _u:
        return []
    try:
        with _u.urlopen('http://127.0.0.1:%d/api/tags' % port, timeout=3) as r:
            data = json.loads(r.read().decode('utf-8'))
        return [m.get('name', '') for m in data.get('models', [])]
    except Exception:
        return []


def pick_vision_model(models):
    """从 Ollama 模型里挑一个能看图的：优先已经做好的 -cap 变体。"""
    # 已生成的图片描述专用变体（system 压过思考），优先复用。
    # 可能出现 -cap-cap 这种重复叠加的残留，出现次数少、名字短的才是"正统"那一版。
    caps = sorted(
        {n.split(':')[0] for n in models if n.split(':')[0].endswith('-cap')},
        key=lambda x: (x.count('-cap'), len(x)),
    )
    if caps:
        return caps[0]
    # 其次按已知的视觉模型族匹配
    for pat in ('qwen3.5', 'qwen3-vl', 'qwen2.5vl', 'qwen2-vl', 'llava', 'minicpm-v', 'moondream', 'gemma3', 'internvl'):
        for n in models:
            if n.lower().startswith(pat):
                return n
    return None


def point_plugin_vision(vision_id, work_data):
    """把 reimage / meme_manager 里指向旧模型的识图 provider 改到新的 id 上。"""
    touched = []
    cfg_dir = os.path.join(work_data, 'config')

    rp = os.path.join(cfg_dir, 'astrbot_plugin_reimage_config.json')
    if os.path.exists(rp):
        try:
            d = load(rp)
            ip = d.setdefault('img_provider', {})
            if ip.get('provider_id') != vision_id:
                ip['provider_id'] = vision_id
                save(rp, d, bom=False)
                touched.append('reimage')
        except Exception as e:
            print('  [warn] reimage 配置改写失败:', e)

    mp = os.path.join(cfg_dir, 'meme_manager_config.json')
    if os.path.exists(mp):
        try:
            d = load(mp)
            changed = False
            for sec in ('semantic', 'auto_collect'):
                sub = d.get(sec)
                if isinstance(sub, dict) and 'vision_provider_id' in sub:
                    if sub.get('vision_provider_id') != vision_id:
                        sub['vision_provider_id'] = vision_id
                        changed = True
            if changed:
                save(mp, d, bom=False)
                touched.append('meme_manager')
        except Exception as e:
            print('  [warn] meme_manager 配置改写失败:', e)
    return touched


def upsert(cfg, prov):
    """存在则整体替换（保留 id），不存在则追加。"""
    providers = cfg.setdefault('provider', [])
    for i, p in enumerate(providers):
        if p.get('id') == prov['id']:
            providers[i] = prov
            return 'updated'
    providers.append(prov)
    return 'added'


def main():
    args = sys.argv[1:]
    dry = '--dry' in args
    only = 'both'
    if '--only' in args:
        only = args[args.index('--only') + 1]
    tts_prob = None
    if '--tts-prob' in args:
        tts_prob = float(args[args.index('--tts-prob') + 1])

    cfg_path = os.path.join(NEW_DATA, 'cmd_config.json')
    if not os.path.exists(cfg_path):
        print('找不到 cmd_config.json:', cfg_path)
        return 1
    cfg = load(cfg_path)

    # 备份里的原始定义（能拿到就用原参数，拿不到用内置兜底）
    old = {}
    old_cfg = os.path.join(DEFAULT_BACKUP, 'cmd_config.json')
    if os.path.exists(old_cfg):
        old = load(old_cfg)
    old_map = {p.get('id'): p for p in old.get('provider', [])}

    changed = []

    # ---------- 1) 本地向量（Ollama embedding）----------
    if only in ('both', 'embedding'):
        if not ollama_alive():
            print('[skip] Ollama 没在跑（127.0.0.1:%d 无响应），跳过 embedding 接入' % OLLAMA_PORT)
        else:
            models = ollama_models()
            cand = None
            for want in ('nomic-embed-text:cpu', 'nomic-embed-text:latest', 'nomic-embed-text'):
                if want in models:
                    cand = want
                    break
            if not cand:
                print('[skip] Ollama 里没有 nomic-embed-text，先执行: ollama pull nomic-embed-text')
            else:
                emb = dict(old_map.get('ollama_embedding/nomic-embed-text:cpu') or {})
                emb.update({
                    'id': 'ollama_embedding/nomic-embed-text:cpu',
                    'type': 'ollama_embedding',
                    'provider_type': 'embedding',
                    'enable': True,
                    'model': cand,
                    'embedding_model': cand,
                    # 备份里是 docker 环境写的 host.docker.internal，本机必须换成 127.0.0.1
                    'embedding_api_base': 'http://127.0.0.1:%d' % OLLAMA_PORT,
                    'embedding_dimensions': 768,
                    'timeout': 180,
                })
                changed.append(('embedding', upsert(cfg, emb), cand))

    # ---------- 2) 语音（Edge TTS，免费免 Key）----------
    # ---------- 3) 识图（本地 Ollama 视觉模型）----------
    if only in ('both', 'all', 'vision'):
        if not ollama_alive():
            print('[skip] Ollama 没在跑，跳过识图接入')
        else:
            vm = pick_vision_model(ollama_models())
            if not vm:
                print('[skip] Ollama 里没有视觉模型，先执行: ollama pull qwen2.5vl:7b')
            else:
                vid = 'ollama/%s' % vm
                prov = {
                    'id': vid,
                    'enable': True,
                    'model': vm,
                    'modalities': ['text', 'image', 'tool_use'],
                    # 关键：qwen3.5 这类思考型视觉模型在 /v1 上会把正文全塞进 reasoning，
                    # content 留空 → AstrBot 拿到空描述，表现为"识图没反应"。实测只有
                    # chat_template_kwargs 能压住（think:false、system 指令都无效）。
                    'custom_extra_body': {
                        'temperature': 0.3,
                        'chat_template_kwargs': {'enable_thinking': False},
                    },
                    'max_context_tokens': 16384,
                }
                # Ollama 一律用扁平配置，绝不挂 provider_source_id：
                # 配置里第一个 source 往往是 deepseek，挂上去就会变成
                # "拿 deepseek 的 Key 和地址去请求 qwen3.5-4b-cap" → 400 无效模型名。
                prov.update({
                    'type': 'openai_chat_completion',
                    'key': ['ollama'],
                    'api_base': 'http://localhost:11434/v1',
                })
                changed.append(('vision', upsert(cfg, prov), vm))

                ps = cfg.setdefault('provider_settings', {})
                ps['default_image_caption_provider_id'] = vid
                ps.setdefault(
                    'image_caption_prompt',
                    '用中文一句话描述图片：先说要表达什么，再念出图中所有文字，总计不超过60字。',
                )
                changed.append(('caption', 'on', vid))
                for t in point_plugin_vision(vid, NEW_DATA):
                    changed.append(('plugin_cfg', 'updated', t))

    if only in ('both', 'all', 'tts'):
        tts = dict(old_map.get('edge_tts') or {})
        tts.update({
            'id': 'edge_tts',
            'provider': 'microsoft',
            'type': 'edge_tts',
            'provider_type': 'text_to_speech',
            'enable': True,
        })
        tts.setdefault('edge-tts-voice', 'zh-CN-XiaoyiNeural')
        tts.setdefault('rate', '+14%')
        tts.setdefault('volume', '+0%')
        tts.setdefault('pitch', '+12Hz')
        tts.setdefault('timeout', 20)
        changed.append(('edge_tts', upsert(cfg, tts), tts.get('edge-tts-voice')))

        s = cfg.setdefault('provider_tts_settings', {})
        s['enable'] = True
        s['provider_id'] = 'edge_tts'
        s.setdefault('dual_output', False)
        s.setdefault('use_file_service', False)
        s['trigger_probability'] = (
            tts_prob if tts_prob is not None
            else (old.get('provider_tts_settings') or {}).get('trigger_probability', 0.3)
        )
        changed.append(('tts_settings', 'on', json.dumps(s, ensure_ascii=False)))

    if not changed:
        print('没有任何改动')
        return 0

    for kind, act, detail in changed:
        print('%-14s %-8s %s' % (kind, act, detail))

    if dry:
        print('（演练模式，未落盘）')
        return 0

    bak = cfg_path + '.pre_providers.bak'
    if not os.path.exists(bak):
        shutil.copy2(cfg_path, bak)
    save(cfg_path, cfg)
    print('已写入', cfg_path)
    print('改动前备份:', bak)
    print('提示: 需要重启 AstrBot 才生效（POST /api/start 或点「启动机器人」）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
