#!/usr/bin/env python3
"""Retire the community ZCode connector (M5) — reversible, with backups.

三处改动，全部先备份再原子写回：
  1. DSH Harness profile `cordis.patch.yml`：注释掉 `zcode-connect` 的 insert 块
  2. `profiles/web/.dsh-market/state.json`：disabled 追加 `dsh-zcode-connect`
  3. `@wingsky-1/dsh-mcp-manager/mcp.json`：移除 `zcode` 全局 MCP 服务器

用法：python3 scripts/retire-zcode-connect.py [--revert]
回滚：加 `--revert` 会用最近一次 .bak-retire-zcode-* 覆盖回去。
"""
import json
import shutil
import sys
import time
from pathlib import Path

HARNESS = Path.home() / 'Library/Application Support/dsh-desktop/harness'
PROFILE = HARNESS / 'profiles/web'
PATCH = PROFILE / 'cordis.patch.yml'
STATE = PROFILE / '.dsh-market/state.json'
MCP = HARNESS / '@wingsky-1/dsh-mcp-manager/mcp.json'

STAMP = time.strftime('%Y%m%d-%H%M%S')
REVERT = '--revert' in sys.argv

PATCH_BLOCK = """# ZCode (Z.ai) desktop-app connector — panel + bridge + MCP tools
- insert:
    - id: zcode-connect
      name: dsh-zcode-connect
      config:
        debugPort: 9333
        bridgePort: 9444
        bridgeMode: on-demand
"""

PATCH_COMMENTED = """# ZCode (Z.ai) desktop-app connector — 2026-10-31 退役，改用 dsh-zcode-native。
# 块整体保留为注释，便于回滚（scripts/retire-zcode-connect.py --revert）。
# - insert:
#     - id: zcode-connect
#       name: dsh-zcode-connect
#       config:
#         debugPort: 9333
#         bridgePort: 9444
#         bridgeMode: on-demand
"""


def backup(path: Path) -> Path:
    dst = path.with_name(f'{path.name}.bak-retire-zcode-{STAMP}')
    shutil.copy2(path, dst)
    return dst


def latest_backup(path: Path) -> Path | None:
    found = sorted(path.parent.glob(f'{path.name}.bak-retire-zcode-*'))
    return found[-1] if found else None


def main() -> int:
    if REVERT:
        for path in (PATCH, STATE, MCP):
            bak = latest_backup(path)
            if bak is None:
                print(f'!! no backup for {path.name}')
                continue
            shutil.copy2(bak, path)
            print(f'reverted {path.name} <- {bak.name}')
        return 0

    # 1. profile patch
    raw = PATCH.read_text()
    if PATCH_COMMENTED in raw:
        print('= patch already retired')
    else:
        assert raw.count(PATCH_BLOCK) == 1, 'zcode-connect block not found exactly once'
        print(f'backup {backup(PATCH).name}')
        PATCH.write_text(raw.replace(PATCH_BLOCK, PATCH_COMMENTED))
        print('+ patch: zcode-connect block commented out')

    # 2. market disabled list
    state = json.loads(STATE.read_text())
    disabled = state.setdefault('disabled', [])
    if 'dsh-zcode-connect' in disabled:
        print('= state.json already disabled')
    else:
        print(f'backup {backup(STATE).name}')
        disabled.append('dsh-zcode-connect')
        STATE.write_text(json.dumps(state, ensure_ascii=False, indent=1) + '\n')
        print('+ state.json: disabled += dsh-zcode-connect')

    # 3. global MCP server
    mcp = json.loads(MCP.read_text())
    before = [s['name'] for s in mcp['servers']]
    kept = [s for s in mcp['servers'] if s['name'] != 'zcode']
    if len(kept) == len(before):
        print('= mcp.json already without zcode')
    else:
        print(f'backup {backup(MCP).name}')
        mcp['servers'] = kept
        MCP.write_text(json.dumps(mcp, ensure_ascii=False, indent=1) + '\n')
        print(f'+ mcp.json: removed zcode (kept {[s["name"] for s in kept]})')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
