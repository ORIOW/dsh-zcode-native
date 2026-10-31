/**
 * dsh-zcode-native — 原生子代理提供者（M4）。
 *
 * 把 ZCode 注册成 DSH 的一个 subagent backend，于是宿主侧由
 * `subagent_zcode` 工具暴露给模型。所有契约都取自宿主 asar 取证，不是推测：
 *
 *   - `ctx.subagents.registerProvider(provider)` **单参数**，收 provider 对象
 *     本身（`@deepseek-ai/dsh-subagent/lib/types/index.js:376`）。对象必须有
 *     `name`，并且 `start` 或 `prepareContinuable` 至少之一。
 *   - 有 `start` 而无 `prepareContinuable` ⇒ manager 走 `startExternal`，即
 *     ZCode 属于**外部后端**：宿主管不了子代理的会话，只拿一个 run handle。
 *   - `start(request)` 的返回值必须是 run handle
 *     `{ id, result: Promise<SubagentResult>, dispose(): Promise<void> }`
 *     （`lib/types/manager.js:747-757` 消费 `run.id` / `run.result` /
 *     `run.dispose`）。`id` 就是 childId。
 *   - `SubagentResult = { output: ContentBlock[], stopReason, structured?, diagnostic? }`，
 *     `stopReason ∈ 'completed' | 'aborted' | 'max-tokens' | 'refusal' | 'error'`
 *     （`lib/types/continuation-messages.js` 的 settlementSummary/创建处）。
 *   - `request.prompt` 是 **content block 数组**，不是字符串
 *     （`dsh-tool-subagent/lib/index.js:468` 构造 `[{ type:'text', text }]`）。
 *   - 外部后端拿不到父级强制的 start 能力，故 `capabilities` 必须全 false
 *     （`lib/types/out-of-process.js` 的 `NO_START_CAPABILITIES`）；工具侧对应
 *     不能传 `maxDepth`、`agentOptions`。
 *
 * 派活内核仍是 M3 的 `ask()`：走 CDP 驱动 ZCode 界面。因此**天然串行**（ZCode
 * 只有一张 composer），并发子代理会在 ask 的队列里排队，而不是并行。
 *
 * @module dsh-zcode-native/provider
 */
import { randomUUID } from 'node:crypto'
import { ask, AskError } from './ask.js'

export const ZCODE_PROVIDER_NAME = 'zcode'
export const ZCODE_TOOL_NAME = 'subagent_zcode'

/** 外部后端能支持的 start 能力：一个都不支持（ZCode 在别的进程里）。 */
export const NO_START_CAPABILITIES = Object.freeze({
  agentOptions: false,
  agentPreset: false,
  outputSchema: false,
  depthLimit: false,
})

/** dispose 等结果落地的宽限：ask 察觉 abort 后约 1 个采样周期内返回。 */
const DISPOSE_GRACE_MS = 5000

/**
 * content blocks → 一段纯文本。
 *
 * ZCode 的 composer 只吃文本：非文本块（图片等）无法投递，所以显式计数并在
 * prompt 尾部声明，而不是静默丢弃。
 *
 * @param {unknown} blocks - `SubagentRequest['prompt']`（正常是 block 数组）。
 * @returns {string} 可直接敲进 ZCode composer 的文本。
 */
export function promptText(blocks) {
  if (typeof blocks === 'string') return blocks.trim()
  if (!Array.isArray(blocks)) return ''
  const parts = []
  let omitted = 0
  for (const block of blocks) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else omitted += 1
  }
  const text = parts.join('\n\n').trim()
  if (omitted === 0) return text
  return text.length === 0
    ? `[${omitted} non-text prompt block(s) omitted: ZCode accepts text only]`
    : `${text}\n\n[${omitted} non-text prompt block(s) omitted: ZCode accepts text only]`
}

/**
 * `ask()` 的结算结果 → `SubagentResult`。
 *
 * `timeout` 不算成功：ask 只等到「文本两次采样不变」，超时意味着没等到结论，
 * 所以给 `stopReason:'error'` 并带上已有的部分文本，让父代理自己判断。
 *
 * @param {{ status: string, answer?: string, partialText?: string, elapsedMs?: number }} outcome
 * @param {number} askTimeoutMs
 * @returns {{ output: Array<{ type: 'text', text: string }>, stopReason: string, diagnostic?: string }}
 */
export function toResult(outcome, askTimeoutMs) {
  if (outcome?.status === 'ok') {
    const text = typeof outcome.answer === 'string' ? outcome.answer : ''
    return {
      output: text.length === 0 ? [] : [{ type: 'text', text }],
      stopReason: 'completed',
    }
  }
  if (outcome?.status === 'aborted') return { output: [], stopReason: 'aborted' }
  const partial = typeof outcome?.partialText === 'string' ? outcome.partialText : ''
  return {
    output: partial.length === 0 ? [] : [{ type: 'text', text: partial }],
    stopReason: 'error',
    diagnostic: `zcode: no settled answer within ${askTimeoutMs}ms (status: ${String(outcome?.status)})`
      + (partial.length === 0 ? '' : '; the output above is the partial text ZCode had produced'),
  }
}

/**
 * 一个 ZCode 子代理后端。
 *
 * 只声明 `start`，不声明 `prepareContinuable`：外部后端不接受后续消息，父代理
 * 拿到的是完成通知而不是可续对话。`inheritsParentContext: false` 让工具描述
 * 正确告诉模型「子代理看不到本对话」。
 */
export class ZcodeSubagentProvider {
  /** provider 名，也是 `startActivation({ provider })` 查找用的键。 */
  name

  /** 外部后端：父级强制的 start 能力全不支持。 */
  capabilities = NO_START_CAPABILITIES

  /** ZCode 是独立应用，看不到本对话历史。 */
  inheritsParentContext = false

  /**
   * @param {string} name - provider 名。
   * @param {{ debugPort?: number, askTimeoutMs?: number, runAsk?: Function }} [options]
   *   `debugPort` / `askTimeoutMs` 透传给 ask()；`runAsk` 仅供测试替换派活内核。
   */
  constructor(name, options = {}) {
    this.name = name
    this.options = options
  }

  /**
   * 启动一次子代理执行。
   *
   * @param {{ prompt?: unknown, cwd?: string, label?: string, signal?: AbortSignal }} request
   * @returns {{ id: string, result: Promise<object>, dispose: () => Promise<void> }}
   */
  start(request) {
    const id = `zcode-${randomUUID()}`
    const text = promptText(request?.prompt)
    const askTimeoutMs = this.options?.askTimeoutMs ?? 600000
    const parentSignal = request?.signal

    // 自己的 controller：manager 的 abort 只能表示「父级停止」，dispose 需要
    // 一个本 provider 能主动拉的口子，两者都汇到同一个 signal。
    const controller = new AbortController()
    const onParentAbort = () => controller.abort(parentSignal?.reason)
    if (parentSignal) {
      if (parentSignal.aborted) controller.abort(parentSignal.reason)
      else parentSignal.addEventListener('abort', onParentAbort, { once: true })
    }

    const settle = async () => {
      if (controller.signal.aborted) return { output: [], stopReason: 'aborted' }
      if (text.length === 0) {
        return { output: [], stopReason: 'error', diagnostic: 'zcode: the delegated prompt was empty' }
      }
      // `runAsk` 是测试缝：默认就是真的 CDP 派活，测试里换成脚本化实现，
      // 这样 start() 的取消/结算/销毁逻辑可以脱离 ZCode 单测。
      const runAsk = this.options?.runAsk ?? ask
      try {
        const outcome = await runAsk({ ...this.options, signal: controller.signal }, text)
        return toResult(outcome, askTimeoutMs)
      } catch (error) {
        if (controller.signal.aborted) return { output: [], stopReason: 'aborted' }
        return {
          output: [],
          stopReason: 'error',
          diagnostic: error instanceof AskError
            ? `zcode: ${error.code}: ${error.message}`
            : `zcode: ${error?.message ?? String(error)}`,
        }
      }
    }

    const result = settle()

    let disposal
    return {
      id,
      result,
      dispose() {
        if (disposal !== undefined) return disposal
        controller.abort({ kind: 'disposed' })
        parentSignal?.removeEventListener('abort', onParentAbort)
        // 结果必须落定，但 teardown 不能被一次卡死的 ask 拖住。
        disposal = Promise.race([
          result.then(
            () => undefined,
            () => undefined,
          ),
          new Promise((resolve) => setTimeout(resolve, DISPOSE_GRACE_MS).unref?.()),
        ])
        return disposal
      },
    }
  }
}
