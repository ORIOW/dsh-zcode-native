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
import { CliError, DEFAULT_CLI_TIMEOUT_MS, parseCliAnswer, runCliPrompt } from './cli.js'
import { CHECKLIST_HINT } from './checklist.js'
import { resolveSessionForCwd } from './sessions.js'

export const ZCODE_PROVIDER_NAME = 'zcode'
export const ZCODE_TOOL_NAME = 'subagent_zcode'

/** CLI 后端：驱动 ZCode 自带的无头 CLI，不需要 CDP，也不需要 ZCode 窗口。 */
export const ZCODE_CLI_PROVIDER_NAME = 'zcode-cli'
export const ZCODE_CLI_TOOL_NAME = 'subagent_zcode_cli'

/**
 * 自动通道「够不到」时的失败才加提示：CDP 端口起不来、CLI 没有它认得的模型。
 * 业务失败（`busy`、空 prompt）不加——提示只该出现在「这条路本身不可用」时。
 *
 * @param {string} text - 原始诊断
 * @param {'cdp'|'cli'} backend
 * @param {{ code?: string }} [error]
 * @returns {string}
 */
function withChecklistHint(text, backend, error) {
  const code = String(error?.code ?? '')
  const unreachable = backend === 'cdp'
    ? code === 'zcode-not-running' || code === 'launch-timeout'
    : code === 'cli-not-found' || code === 'cli-exit' || code === 'cli-spawn'
  return unreachable ? `${text}${CHECKLIST_HINT}` : text
}

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
 * 构造一次子代理执行的 run handle。
 *
 * 两个后端共用同一套取消语义：manager 的 abort 只表示「父级停止」，dispose 还要
 * 一个 provider 自己能拉的出口，两者汇到同一个 signal；`result` 由 settle 保证
 * 永不 reject。
 *
 * @param {string} idPrefix - childId 前缀，用来区分两种后端。
 * @param {{ signal?: AbortSignal }} request
 * @param {(signal: AbortSignal) => Promise<object>} settle
 * @returns {{ id: string, result: Promise<object>, dispose: () => Promise<void> }}
 */
function runHandle(idPrefix, request, settle) {
  const id = `${idPrefix}${randomUUID()}`
  const parentSignal = request?.signal
  const controller = new AbortController()
  const onParentAbort = () => controller.abort(parentSignal?.reason)
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort(parentSignal.reason)
    else parentSignal.addEventListener('abort', onParentAbort, { once: true })
  }

  const result = settle(controller.signal)

  let disposal
  return {
    id,
    result,
    dispose() {
      if (disposal !== undefined) return disposal
      controller.abort({ kind: 'disposed' })
      parentSignal?.removeEventListener('abort', onParentAbort)
      // 结果必须落定，但 teardown 不能被一次卡死的派活拖住。
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
    const text = promptText(request?.prompt)
    const askTimeoutMs = this.options?.askTimeoutMs ?? 600000

    return runHandle('zcode-', request, async (signal) => {
      if (signal.aborted) return { output: [], stopReason: 'aborted' }
      if (text.length === 0) {
        return { output: [], stopReason: 'error', diagnostic: 'zcode: the delegated prompt was empty' }
      }
      // `runAsk` 是测试缝：默认就是真的 CDP 派活，测试里换成脚本化实现，
      // 这样 start() 的取消/结算/销毁逻辑可以脱离 ZCode 单测。
      const runAsk = this.options?.runAsk ?? ask
      try {
        // 第三个参数是 ask() 的注入面：`ensureRunning`（issue #1 的自动启动）与
        // 测试用的 attachCdp/sleep/now 都从这里进。只把 options 当 config 传，
        // 这些钩子会被静默丢掉——subagent_zcode 就永远走不到自动启动那条兜底。
        const outcome = await runAsk({ ...this.options, signal }, text, this.options)
        return toResult(outcome, askTimeoutMs)
      } catch (error) {
        if (signal.aborted) return { output: [], stopReason: 'aborted' }
        return {
          output: [],
          stopReason: 'error',
          diagnostic: withChecklistHint(
            error instanceof AskError
              ? `zcode: ${error.code}: ${error.message}`
              : `zcode: ${error?.message ?? String(error)}`,
            'cdp',
            error,
          ),
        }
      }
    })
  }
}

/**
 * CLI 后端的结算 → `SubagentResult`。
 *
 * CLI 的 `-p` 模式只有两种可观测结局：退出码 0（stdout 是答案）或非零（抛
 * CliError，诊断里已带 stderr 尾巴）。所以这里只处理「退出码 0 但 stdout 是
 * 空的」这一种可疑成功：CLI 把结论写进了 stderr、stdout 只留白，这种不能当
 * 答案投给父代理。
 *
 * @param {{ status?: string, text?: string }} outcome
 * @param {number} timeoutMs
 * @returns {{ output: Array<{ type: 'text', text: string }>, stopReason: string, diagnostic?: string }}
 */
export function toCliResult(outcome, timeoutMs) {
  if (outcome?.status !== 'ok') {
    return {
      output: [],
      stopReason: 'error',
      diagnostic: withChecklistHint(
        `zcode-cli: unexpected outcome "${String(outcome?.status)}" (timeout ${timeoutMs}ms)`,
        'cli',
        { code: 'cli-exit' },
      ),
    }
  }
  const parsed = parseCliAnswer(outcome.text)
  if (parsed.empty) {
    return {
      output: [],
      stopReason: 'error',
      diagnostic: withChecklistHint(
        'zcode-cli: exit code 0 but the cli printed no answer'
          + '; check `zcode login` and the model selected in the ZCode app',
        'cli',
        { code: 'cli-exit' },
      ),
    }
  }
  return { output: [{ type: 'text', text: parsed.text }], stopReason: 'completed' }
}

/**
 * ZCode 内置 CLI 的子代理后端。
 *
 * 与 CDP 后端是两条独立的通道：这个后端不需要 ZCode 窗口、不需要调试端口，
 * 每次派活起一个 `node <app>/Resources/glm/zcode.cjs -p <prompt>` 子进程。代价
 * 是每次都新建一个 CLI 会话（拿不到续对话），且必须能通过 `zcode login` 鉴权。
 */
export class ZcodeCliSubagentProvider {
  /** provider 名，也是 `startActivation({ provider })` 查找用的键。 */
  name

  /** 同样是外部后端：能力全不支持。 */
  capabilities = NO_START_CAPABILITIES

  /** CLI 是独立进程，看不到本对话历史。 */
  inheritsParentContext = false

  /**
   * @param {string} name - provider 名。
   * @param {{ entryPath?: string, cwd?: string, timeoutMs?: number, sessionId?: string, runCli?: Function }} [options]
   *   `entryPath` 留空则按平台候选表发现；`sessionId` 是拿去 `--resume` 的 ZCode 会话
   *   （CLI 只认会话级的模型选择）；`runCli` 仅供测试替换派活内核。
   */
  constructor(name, options = {}) {
    this.name = name
    this.options = options
  }

  /**
   * @param {{ prompt?: unknown, cwd?: string, label?: string, signal?: AbortSignal }} request
   * @returns {{ id: string, result: Promise<object>, dispose: () => Promise<void> }}
   */
  start(request) {
    const text = promptText(request?.prompt)
    const timeoutMs = this.options?.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS
    const cwd = this.options?.cwd ?? request?.cwd ?? process.cwd()

    // 模型选择是会话级的，所以「用哪个模型」=「resume 哪条 ZCode 会话」。默认按
    // 工作目录自动认领：ZCode 里第一条在该目录干活的会话（桌面端与 CLI 共用同一
    // 份会话库）。不同 DSH 会话在不同项目里派活，就会落到不同的 ZCode 会话上。
    // `sessionId` 只作显式覆盖（例如目标会话不在这个目录）。
    const configuredSession = typeof this.options?.sessionId === 'string' ? this.options.sessionId.trim() : ''
    const resolveSession = this.options?.sessionResolver ?? resolveSessionForCwd
    const resolvedSession = configuredSession || resolveSession(cwd)?.id || ''

    return runHandle('zcode-cli-', request, async (signal) => {
      if (signal.aborted) return { output: [], stopReason: 'aborted' }
      if (text.length === 0) {
        return { output: [], stopReason: 'error', diagnostic: 'zcode-cli: the delegated prompt was empty' }
      }
      const runCli = this.options?.runCli ?? runCliPrompt
      try {
        const outcome = await runCli({ ...this.options, cwd, timeoutMs, signal, sessionId: resolvedSession }, text)
        return toCliResult(outcome, timeoutMs)
      } catch (error) {
        if (signal.aborted) return { output: [], stopReason: 'aborted' }
        return {
          output: [],
          stopReason: 'error',
          diagnostic: withChecklistHint(
            error instanceof CliError
              ? `zcode-cli: ${error.code}: ${error.message}`
              : `zcode-cli: ${error?.message ?? String(error)}`,
            'cli',
            error,
          ),
        }
      }
    })
  }
}
