/**
 * Unit tests for lib/provider.js — the M4 subagent backend.
 *
 * 不碰真 ZCode：`start()` 的派活内核用 `options.runAsk` 换掉，于是取消链接、
 * 结算映射、dispose 语义都能在没有 CDP 的情况下断言。
 *
 * 契约来源（asar 取证，不是推测）：
 *   - provider 由 `ctx.subagents.registerProvider(provider)` 单参数注册，
 *     必须有 `name` + `start`；
 *   - `start(request)` 返回 `{ id, result, dispose }`，`result` 永不 reject；
 *   - result 是 `{ output: ContentBlock[], stopReason, diagnostic? }`，
 *     stopReason ∈ completed | aborted | max-tokens | refusal | error。
 *
 * Run: node --test test/provider.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ZCODE_CLI_PROVIDER_NAME,
  ZCODE_CLI_TOOL_NAME,
  ZCODE_PROVIDER_NAME,
  ZCODE_TOOL_NAME,
  NO_START_CAPABILITIES,
  ZcodeCliSubagentProvider,
  ZcodeSubagentProvider,
  promptText,
  toCliResult,
  toResult,
} from '../lib/provider.js'
import { CliError } from '../lib/cli.js'

const PROMPT = [{ type: 'text', text: '在 README.md 第一行写标题' }]

test('provider name and tool name are the documented identifiers', () => {
  assert.equal(ZCODE_PROVIDER_NAME, 'zcode')
  assert.equal(ZCODE_TOOL_NAME, 'subagent_zcode')
})

test('外部后端不声明任何 start 能力，且不继承父上下文', () => {
  const provider = new ZcodeSubagentProvider(ZCODE_PROVIDER_NAME)
  assert.equal(provider.name, 'zcode')
  assert.equal(provider.inheritsParentContext, false)
  // 全 false 是硬要求：assertCapabilities 只在传了 agentOptions/outputSchema/
  // maxDepth/agentPreset 时才要求对应能力为 true，我们一个都不传。
  assert.deepEqual(provider.capabilities, {
    agentOptions: false,
    agentPreset: false,
    outputSchema: false,
    depthLimit: false,
  })
  assert.equal(NO_START_CAPABILITIES, provider.capabilities)
  // 只实现 start：有 prepareContinuable 就会被宿主当成 local 后端。
  assert.equal(typeof provider.start, 'function')
  assert.equal(provider.prepareContinuable, undefined)
})

test('promptText 只取文本块，非文本块显式计数而不是静默丢弃', () => {
  assert.equal(promptText('  直接字符串  '), '直接字符串')
  assert.equal(promptText(PROMPT), '在 README.md 第一行写标题')
  assert.equal(
    promptText([
      { type: 'text', text: '第一段' },
      { type: 'image', source: {} },
      { type: 'text', text: '第二段' },
    ]),
    '第一段\n\n第二段\n\n[1 non-text prompt block(s) omitted: ZCode accepts text only]',
  )
  assert.equal(
    promptText([{ type: 'image', source: {} }]),
    '[1 non-text prompt block(s) omitted: ZCode accepts text only]',
  )
  // 形状不认识时给空串，交给 start() 判成 error，而不是把 undefined 敲进 composer。
  assert.equal(promptText(undefined), '')
  assert.equal(promptText(null), '')
  assert.equal(promptText(42), '')
})

test('toResult 把 ask 结果映射成 SubagentResult', () => {
  assert.deepEqual(toResult({ status: 'ok', answer: 'ok 文本' }, 1000), {
    output: [{ type: 'text', text: 'ok 文本' }],
    stopReason: 'completed',
  })
  // 空答案是 completed + 空 output，不是 error：ZCode 确实答了，只是没内容。
  assert.deepEqual(toResult({ status: 'ok', answer: '' }, 1000), { output: [], stopReason: 'completed' })
  assert.deepEqual(toResult({ status: 'aborted' }, 1000), { output: [], stopReason: 'aborted' })

  // 超时给 error + 已有部分文本 + 诊断，父代理据此判断，不假装成功。
  const timeout = toResult({ status: 'timeout', partialText: '写到一半' }, 1234)
  assert.equal(timeout.stopReason, 'error')
  assert.deepEqual(timeout.output, [{ type: 'text', text: '写到一半' }])
  assert.match(timeout.diagnostic, /1234ms/)
  assert.match(timeout.diagnostic, /status: timeout/)
  assert.match(timeout.diagnostic, /partial text/)

  const noPartial = toResult({ status: 'timeout', partialText: '' }, 10)
  assert.deepEqual(noPartial.output, [])
  assert.doesNotMatch(noPartial.diagnostic, /partial text/)
})

test('start() 返回 run handle：id 唯一、result 落定成 completed', async () => {
  const provider = new ZcodeSubagentProvider('zcode', {
    runAsk: async () => ({ status: 'ok', answer: '答案' }),
  })
  const run = provider.start({ prompt: PROMPT })
  try {
    assert.match(run.id, /^zcode-[0-9a-f-]{36}$/)
    assert.equal(typeof run.dispose, 'function')
    const result = await run.result
    assert.deepEqual(result, { output: [{ type: 'text', text: '答案' }], stopReason: 'completed' })
    // 第二次启动必须拿到不同 childId，否则 manager 的 assertChildIdAvailable 会炸。
    assert.notEqual(provider.start({ prompt: PROMPT }).id, run.id)
  } finally {
    await run.dispose()
  }
})

test('空 prompt 不派活，直接结算成 error 并说明原因', async () => {
  let called = false
  const provider = new ZcodeSubagentProvider('zcode', {
    runAsk: async () => {
      called = true
      return { status: 'ok', answer: '不该到这' }
    },
  })
  const run = provider.start({ prompt: [] })
  const result = await run.result
  await run.dispose()
  assert.equal(called, false)
  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /prompt was empty/)
})

test('父级 abort 会传播进 ask，并结算成 aborted', async () => {
  let seenSignal = null
  const provider = new ZcodeSubagentProvider('zcode', {
    runAsk: (config) =>
      new Promise((resolve) => {
        seenSignal = config.signal
        config.signal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true })
      }),
  })
  const parent = new AbortController()
  const run = provider.start({ prompt: PROMPT, signal: parent.signal })
  // 拿到 manager 的 signal 之外的**本 provider 自己的** signal：dispose 也要能拉。
  assert.notEqual(seenSignal, parent.signal)
  parent.abort({ kind: 'parent' })
  assert.deepEqual(await run.result, { output: [], stopReason: 'aborted' })
  await run.dispose()
})

test('父级 signal 已经 aborted 时不派活', async () => {
  let called = false
  const provider = new ZcodeSubagentProvider('zcode', {
    runAsk: async () => {
      called = true
      return { status: 'ok', answer: '不该到这' }
    },
  })
  const parent = new AbortController()
  parent.abort({ kind: 'parent' })
  const run = provider.start({ prompt: PROMPT, signal: parent.signal })
  assert.deepEqual(await run.result, { output: [], stopReason: 'aborted' })
  await run.dispose()
  assert.equal(called, false)
})

test('dispose 会中止进行中的派活，且幂等', async () => {
  let aborts = 0
  const provider = new ZcodeSubagentProvider('zcode', {
    runAsk: (config) =>
      new Promise((resolve) => {
        config.signal.addEventListener(
          'abort',
          () => {
            aborts += 1
            resolve({ status: 'aborted' })
          },
          { once: true },
        )
      }),
  })
  const run = provider.start({ prompt: PROMPT })
  const first = run.dispose()
  const second = run.dispose()
  assert.equal(first, second, 'dispose 必须缓存同一个 promise')
  await first
  assert.equal(aborts, 1, 'abort 只能触发一次')
  assert.deepEqual(await run.result, { output: [], stopReason: 'aborted' })
})

test('AskError 变成 diagnostic 而不是抛出', async () => {
  const { AskError } = await import('../lib/ask.js')
  const provider = new ZcodeSubagentProvider('zcode', {
    runAsk: async () => {
      throw new AskError('busy', 'ZCode is generating')
    },
  })
  const run = provider.start({ prompt: PROMPT })
  const result = await run.result
  await run.dispose()
  assert.deepEqual(result.output, [])
  assert.equal(result.stopReason, 'error')
  assert.equal(result.diagnostic, 'zcode: busy: ZCode is generating')
})

test('普通异常也收敛成 diagnostic', async () => {
  const provider = new ZcodeSubagentProvider('zcode', {
    runAsk: async () => {
      throw new Error('CDP connect ECONNREFUSED 127.0.0.1:9222')
    },
  })
  const run = provider.start({ prompt: PROMPT })
  const result = await run.result
  await run.dispose()
  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /ECONNREFUSED 127\.0\.0\.1:9222/)
})

// ---- CLI 后端 ------------------------------------------------------------

test('cli provider names are distinct from the CDP backend', () => {
  assert.equal(ZCODE_CLI_PROVIDER_NAME, 'zcode-cli')
  assert.equal(ZCODE_CLI_TOOL_NAME, 'subagent_zcode_cli')
  const provider = new ZcodeCliSubagentProvider(ZCODE_CLI_PROVIDER_NAME)
  assert.equal(provider.name, 'zcode-cli')
  assert.equal(provider.inheritsParentContext, false)
  assert.deepEqual(provider.capabilities, NO_START_CAPABILITIES)
})

test('cli provider: a clean run settles completed, with the ANSI stripped', async () => {
  const seen = []
  const provider = new ZcodeCliSubagentProvider(ZCODE_CLI_PROVIDER_NAME, {
    timeoutMs: 1000,
    runCli: async (config, prompt) => {
      seen.push({ config, prompt })
      return { status: 'ok', text: '\u001b[32mOK\u001b[0m', exitCode: 0, elapsedMs: 12 }
    },
  })
  const handle = provider.start({ prompt: PROMPT, cwd: '/tmp/ws' })
  const result = await handle.result
  assert.deepEqual(result, { output: [{ type: 'text', text: 'OK' }], stopReason: 'completed' })
  assert.equal(seen[0].prompt, '在 README.md 第一行写标题')
  assert.equal(seen[0].config.cwd, '/tmp/ws')
  assert.equal(seen[0].config.timeoutMs, 1000)
  assert.match(handle.id, /^zcode-cli-/)
})

test('cli provider: a nonzero exit is an error whose diagnostic keeps the stderr tail', async () => {
  const provider = new ZcodeCliSubagentProvider(ZCODE_CLI_PROVIDER_NAME, {
    runCli: async () => {
      throw new CliError('cli-exit', 'zcode cli: exit code 1 — the cli said: [1113][余额不足]')
    },
  })
  const result = await provider.start({ prompt: PROMPT }).result
  assert.equal(result.stopReason, 'error')
  assert.deepEqual(result.output, [])
  assert.match(result.diagnostic, /^zcode-cli: cli-exit: /)
  assert.match(result.diagnostic, /\[1113\]/)
})

test('cli provider: dispose aborts the child and settles as aborted', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let seenSignal
  const provider = new ZcodeCliSubagentProvider(ZCODE_CLI_PROVIDER_NAME, {
    runCli: async (config) => {
      seenSignal = config.signal
      await gate
      throw new CliError('cli-aborted', 'zcode cli: killed by SIGTERM')
    },
  })
  const handle = provider.start({ prompt: PROMPT })
  await handle.dispose()
  release()
  const result = await handle.result
  assert.equal(seenSignal.aborted, true)
  assert.equal(result.stopReason, 'aborted')
  assert.equal(result.diagnostic, undefined)
})

test('cli provider: an empty prompt never reaches the CLI', async () => {
  let called = 0
  const provider = new ZcodeCliSubagentProvider(ZCODE_CLI_PROVIDER_NAME, {
    runCli: async () => {
      called += 1
      return { status: 'ok', text: 'x', exitCode: 0, elapsedMs: 1 }
    },
  })
  const result = await provider.start({ prompt: [] }).result
  assert.equal(called, 0)
  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /prompt was empty/)
})

test('cli provider: exit code 0 with an empty stdout is an error, not an empty answer', () => {
  const result = toCliResult({ status: 'ok', text: '  \n' }, 1000)
  assert.equal(result.stopReason, 'error')
  assert.match(result.diagnostic, /printed no answer/)
})
