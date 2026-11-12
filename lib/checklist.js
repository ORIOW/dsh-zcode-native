/**
 * 第三条路：把「手工给 ZCode 派活」的清单直接交给父代理。
 *
 * 前两条路都有机器前提：CDP 那条要有调试端口（ZCode 3.17.2 起 macOS 打包版不再
 * 接受这个开关），CLI 那条要有一个它认得的模型（模型选择只存在会话记录里，账号
 * 没额度或套餐对不上就报 `[1113]` / `Select a model`）。两条都够不到时，插件不该
 * 只丢一句错误：把这个清单交出去，父代理照着做一样能完成任务，只是要人手配合。
 *
 * `lib/checklist.md` 是工作区技能 `.dsh/skills/zcode-dispatch-checklist/SKILL.md`
 * 的同步副本（去掉了 frontmatter）。要改就改技能，然后重新生成：
 *
 *   awk 'BEGIN{n=0} /^---$/{n++; next} n>=2' \
 *     .dsh/skills/zcode-dispatch-checklist/SKILL.md.disabled > lib/checklist.md
 */
import { readFileSync } from 'node:fs'

/** 工具名。父代理在自动通道失败后调它，拿回下面这份清单。 */
export const ZCODE_CHECKLIST_TOOL_NAME = 'zcode_dispatch_checklist'

/**
 * 清单正文。放在独立 .md 里而不是模板字符串里：正文自带大量反引号与代码块，
 * 塞进 JS 字符串只会制造转义错误。
 */
export const DISPATCH_CHECKLIST = readFileSync(new URL('./checklist.md', import.meta.url), 'utf8').trim()

/**
 * 拼在失败诊断末尾的一句话。只出现在「自动通道大概率不可用」的失败上，正常
 * 业务失败（`busy`、空 prompt）不加，免得噪声盖住真正的原因。
 */
export const CHECKLIST_HINT =
  ' — if this backend cannot serve you (no debug port, or no model the CLI can use), '
  + `call ${ZCODE_CHECKLIST_TOOL_NAME} and follow it`

/**
 * 清单里写的是姊妹插件 dsh-zcode 的工具名，这里给出本插件的对应关系。
 * 不印这一段的话，读清单的模型会去找根本不存在的 `zcode_ask`。
 */
const TOOL_MAP = [
  '- 本插件的工具：`subagent_zcode`（走 CDP 驱动 ZCode 窗口）、`subagent_zcode_cli`（走内置 CLI 无头进程）、'
  + '`zcode_launch`（找并启动 ZCode 的调试端口；`plainFallback:true` 时端口开不起来就改用零参数拉起窗口，供手工派活）。',
  '- 清单正文里的 `zcode_ask` 对应 `subagent_zcode`；`zcode_status` / `zcode_capabilities` / `zcode_runs` '
  + '属于姊妹插件，本插件没有这些工具，状态请读 HTTP 路由 `/plugins/dsh-zcode-native/status`。',
].join('\n')

/**
 * 组装这次要交出去的清单。
 *
 * @param {{ reason?: string, backend?: string, diagnostic?: string }} [context]
 *   `reason` 是调用方给的场景说明（例如「CDP 端口连不上」）；`backend`/`diagnostic`
 *   是刚刚失败的那次派活，写进抬头让人知道为什么要退回手工。
 * @returns {string} 抬头 + 工具对照 + 技能正文
 */
export function checklistFor({ reason, backend, diagnostic } = {}) {
  const head = ['# ZCode 派活人工清单（第三条路：自动通道不可用时照此手工执行）']
  if (reason) head.push(`- 触发原因：${String(reason).trim()}`)
  if (backend) head.push(`- 先试过的后端：${String(backend).trim()}`)
  if (diagnostic) head.push(`- 那次的诊断：${String(diagnostic).trim()}`)
  head.push(TOOL_MAP)
  return `${head.join('\n')}\n\n${DISPATCH_CHECKLIST}\n`
}