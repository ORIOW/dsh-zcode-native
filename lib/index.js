import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { collectStatus } from './status.js'
import { ask } from './ask.js'
import { DEFAULT_LAUNCH_TIMEOUT_MS, ZCODE_LAUNCH_TOOL_NAME, launch } from './launch.js'
import { ZCODE_CHECKLIST_TOOL_NAME, checklistFor } from './checklist.js'
import {
  ZCODE_CLI_PROVIDER_NAME,
  ZCODE_CLI_TOOL_NAME,
  ZCODE_PROVIDER_NAME,
  ZCODE_TOOL_NAME,
  ZcodeCliSubagentProvider,
  ZcodeSubagentProvider,
} from './provider.js'
import { DEFAULT_CLI_TIMEOUT_MS, runCliPrompt } from './cli.js'

export const name = 'zcode-native'

/** webServer is optional to the host: routes attach whenever the carrier is up. */
export const inject = ['webServer']

export const Config = Schema.object({
  debugPort: Schema.number().default(9222).description('ZCode 调试端口（CDP）'),
  cacheMs: Schema.number().default(15000).description('状态缓存有效期（毫秒）'),
  askTimeoutMs: Schema.number().default(600000).description('ask 等待答案的超时（毫秒）'),
  autoLaunch: Schema.boolean().default(true)
    .description('调试端口连不上时，自动查找本地 ZCode 并以 --remote-debugging-port 启动它'),
  zcodeExecutable: Schema.string().default('')
    .description('ZCode 可执行文件的绝对路径；留空则按平台常见安装位置、PATH、目录扫描依次自动查找'),
  launchTimeoutMs: Schema.number().default(DEFAULT_LAUNCH_TIMEOUT_MS)
    .description('启动 ZCode 后等待调试端口就绪的超时（毫秒）'),
  cliEnabled: Schema.boolean().default(true)
    .description('注册 ZCode 内置 CLI 后端：不需要调试端口，每次派活起一个无头 CLI 进程'),
  cliEntry: Schema.string().default('')
    .description('zcode.cjs 的绝对路径；留空则按平台安装位置自动查找'),
  cliTimeoutMs: Schema.number().default(DEFAULT_CLI_TIMEOUT_MS)
    .description('一次 CLI 派活的超时（毫秒）'),
  cliSessionId: Schema.string().default('')
    .description('要复用的 ZCode 会话 id（在 ZCode 界面里复制）；CLI 只认会话级的模型选择，留空则每次新建会话'),
})

export const STATUS_ROUTE = '/plugins/dsh-zcode-native/status'
export const ASK_ROUTE = '/plugins/dsh-zcode-native/ask'

/** /ask request bodies are tiny prompts, not uploads. */
const MAX_BODY_BYTES = 64 * 1024

/** loopback (127.0.0.0/8 + ::1, including the ::ffff: mapped form) or nothing. */
function isLoopback(address) {
  if (typeof address !== 'string' || address.length === 0) return false
  const normalised = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return normalised === '::1' || normalised === '127.0.0.1' || normalised.startsWith('127.')
}

function send(response, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

/** Read the request body up to maxBytes; reject with { code:'too-large' } beyond that. */
function readRequestBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    let settled = false
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      fn(value)
    }
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        settle(reject, Object.assign(new Error(`body exceeds ${maxBytes} bytes`), { code: 'too-large' }))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => settle(resolve, Buffer.concat(chunks).toString('utf8')))
    request.on('error', (error) => settle(reject, error))
  })
}

export function apply(ctx, config) {
  console.log('[zcode-native] loaded')

  const resolved = {
    debugPort: config?.debugPort ?? 9222,
    cacheMs: config?.cacheMs ?? 15000,
    askTimeoutMs: config?.askTimeoutMs ?? 600000,
    autoLaunch: config?.autoLaunch ?? true,
    zcodeExecutable: config?.zcodeExecutable || '',
    launchTimeoutMs: config?.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS,
    cliEnabled: config?.cliEnabled ?? true,
    cliEntry: config?.cliEntry || '',
    cliTimeoutMs: config?.cliTimeoutMs ?? DEFAULT_CLI_TIMEOUT_MS,
    cliSessionId: (config?.cliSessionId ?? '').trim(),
  }

  // 启动器只描述「怎么找、怎么起」，不自己决定何时起：ask() 在 CDP 连不上时
  // 才调它，工具则允许模型/用户显式调。restart 永远不由这里预设——杀掉用户的
  // ZCode 必须是一次显式决定。
  const launcher = {
    port: resolved.debugPort,
    executablePath: resolved.zcodeExecutable || undefined,
    timeoutMs: resolved.launchTimeoutMs,
  }
  const ensureRunning = resolved.autoLaunch ? async () => launch(launcher) : undefined

  let cache = { at: 0, value: null }
  const status = async () => {
    const now = Date.now()
    if (cache.value !== null && now - cache.at < resolved.cacheMs) return cache.value
    cache = { at: now, value: await collectStatus(resolved) }
    return cache.value
  }

  // Deferred on purpose: the web carrier is not up at composition time — ctx.get
  // ('webServer') measured undefined on the predecessor plugin and the route
  // silently vanished. ctx.inject waits for it.
  ctx.inject(['webServer'], (webCtx) => {
    ctx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: STATUS_ROUTE,
        handler: async (request, response) => {
          if (request.method !== 'GET' && request.method !== 'HEAD') {
            return send(response, 405, { error: 'GET only' })
          }
          if (!isLoopback(request.socket?.remoteAddress)) {
            return send(response, 403, { error: 'loopback only' })
          }
          try {
            send(response, 200, await status())
          } catch (error) {
            send(response, 500, { error: error.message })
          }
        },
      }),
      `zcode-native: GET ${STATUS_ROUTE}`,
    )

    // POST /ask — drives the ZCode composer. Serialized inside ask(); errors
    // surface as { status:'error', error } rather than a 5xx so the caller can
    // read the stable AskError code.
    ctx.effect(
      () => webCtx.webServer.register({
        kind: 'exact',
        path: ASK_ROUTE,
        handler: async (request, response) => {
          if (request.method !== 'POST') return send(response, 405, { error: 'POST only' })
          if (!isLoopback(request.socket?.remoteAddress)) {
            return send(response, 403, { error: 'loopback only' })
          }
          let body
          try {
            body = JSON.parse((await readRequestBody(request, MAX_BODY_BYTES)) || '{}')
          } catch (error) {
            if (error.code === 'too-large') return send(response, 413, { error: `body exceeds ${MAX_BODY_BYTES} bytes` })
            return send(response, 400, { error: 'invalid JSON body' })
          }
          const prompt = body?.prompt
          if (typeof prompt !== 'string' || prompt.trim().length === 0) {
            return send(response, 400, { error: 'prompt must be a non-empty string' })
          }
          // `backend` 只是「走哪条通道」的选择器，不是新语义：缺省/`cdp` 与加这个
          // 字段之前是同一条路径、同一个响应体。要它的原因很具体——macOS 上的
          // ZCode 3.17.2 打包版根本不带调试端口，CDP 在这类机器上直接够不到；内置
          // CLI 是同机另一条可用通道。默认留在 cdp 上，老调用方零改动。
          const backend = body.backend === undefined ? 'cdp' : body.backend
          if (backend !== 'cdp' && backend !== 'cli') {
            return send(response, 400, { error: 'backend must be "cdp" or "cli"' })
          }
          if (backend === 'cli') {
            // 显式拒绝而不是偷偷回落到 CDP：调用方选 cli 就是为了不碰 ZCode 窗口，
            // 回落会把「界面里的答案」冒充成「无头进程的答案」。
            if (resolved.cliEnabled === false) {
              return send(response, 200, {
                status: 'error',
                error: 'cli-disabled: the CLI backend is turned off (cliEnabled: false)',
                elapsedMs: null,
                backend: 'cli',
              })
            }
            try {
              const outcome = await runCliPrompt({
                entryPath: resolved.cliEntry || undefined,
                cwd: process.cwd(),
                timeoutMs: resolved.cliTimeoutMs,
                sessionId: resolved.cliSessionId || undefined,
              }, prompt)
              send(response, 200, { ...outcome, backend: 'cli' })
            } catch (error) {
              send(response, 200, {
                status: 'error',
                error: error.code ? `${error.code}: ${error.message}` : (error.message || 'unknown cli failure'),
                elapsedMs: null,
                backend: 'cli',
              })
            }
            return
          }
          try {
            send(response, 200, await ask(resolved, prompt, { ensureRunning }))
          } catch (error) {
            send(response, 200, {
              status: 'error',
              error: error.code ? `${error.code}: ${error.message}` : (error.message || 'unknown ask failure'),
              elapsedMs: null,
            })
          }
        },
      }),
      `zcode-native: POST ${ASK_ROUTE}`,
    )
  })

  // ---- M4: ZCode 作为原生子代理后端 ----------------------------------------
  //
  // provider 与工具都走 ctx.inject：subagents / tools 在本插件 apply 时未就绪，
  // 直接 ctx.get 会拿到 undefined（M0 的 webServer 已踩过同一个坑）。
  const provider = new ZcodeSubagentProvider(ZCODE_PROVIDER_NAME, {
    debugPort: resolved.debugPort,
    askTimeoutMs: resolved.askTimeoutMs,
    // ask() 在 attach 失败时会调它：找到本地 ZCode 并用调试端口启动，然后重连。
    // provider.start() 会把 options 原样透传给 ask，所以这里加一个键就够了。
    ensureRunning,
  })

  // CLI 后端：ZCode 3.17.2 在 macOS 上关掉了 CDP，这是同一台机器上另一条可用
  // 通道——驱动 ZCode 自带的无头 CLI（`Resources/glm/zcode.cjs`）。两条后端并存，
  // 模型按需挑 `subagent_zcode`（驱动窗口）或 `subagent_zcode_cli`（无头进程）。
  // 关掉 cliEnabled 就只剩 CDP 后端，与加这个功能之前完全一致。
  const cliProvider = resolved.cliEnabled
    ? new ZcodeCliSubagentProvider(ZCODE_CLI_PROVIDER_NAME, {
      entryPath: resolved.cliEntry || undefined,
      timeoutMs: resolved.cliTimeoutMs,
      sessionId: resolved.cliSessionId || undefined,
    })
    : null

  ctx.inject(['subagents', 'tools'], (subCtx) => {
    // 先 provider 后工具：工具的 execute 要 startActivation，而它会
    // expectProvider 查表，provider 不在册就直接 UNKNOWN_PROVIDER。
    ctx.effect(
      () => subCtx.subagents.registerProvider(provider),
      `zcode-native: subagent provider "${ZCODE_PROVIDER_NAME}"`,
    )
    if (cliProvider) {
      ctx.effect(
        () => subCtx.subagents.registerProvider(cliProvider),
        `zcode-native: subagent provider "${ZCODE_CLI_PROVIDER_NAME}"`,
      )
    }

    const definition = defineTool({
      name: ZCODE_TOOL_NAME,
      description:
        `Delegate a self-contained task to ZCode — the Z.ai desktop coding agent — and return its answer. `
        + `ZCode runs in its own app, on whatever project it currently has open, and does not see this conversation, `
        + `so the prompt must be complete on its own. It cannot receive follow-up messages: the completion notice carries its final answer. `
        + `Requires the ZCode app to be running with remote debugging enabled; delegations are serialized because ZCode has a single composer.`,
      parameters: {
        description: {
          type: 'string',
          required: true,
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        prompt: {
          type: 'string',
          required: true,
          description: 'The complete, self-contained task for ZCode. It does not share this conversation context, so include everything it needs — file paths, the repo, and what "done" looks like.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'activation' },
            subagentId: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const parent = exec.agent
        if (!parent) throw new Error(`${ZCODE_TOOL_NAME} requires a calling agent (exec.agent was undefined)`)
        exec.signal.throwIfAborted()
        // 刻意不传 cwd：ZCode 只认自己打开的项目，传一个它不会用的目录是假支持。
        // 也不传 agentPreset/agentOptions/outputSchema/maxDepth —— provider 的
        // capabilities 全 false（外部后端），传了 assertCapabilities 直接抛。
        const activation = await subCtx.subagents.startActivation({
          provider: ZCODE_PROVIDER_NAME,
          label: args.description,
          request: { prompt: [{ type: 'text', text: args.prompt }], parent },
          signal: exec.signal,
          delivery: 'parent',
        })
        return { kind: 'activation', subagentId: activation.childId }
      },
    })

    ctx.effect(
      () => subCtx.tools.register(definition),
      `zcode-native: tool "${ZCODE_TOOL_NAME}"`,
    )

    // ---- CLI 后端工具 ------------------------------------------------------
    //
    // 与 subagent_zcode 的区别是通道，不是语义：同样是「派一个自包含任务，拿一段
    // 最终文本」。CLI 后端不碰 ZCode 窗口，所以不受「ZCode 停在哪个会话」影响，
    // 但每次都是新会话（拿不到续聊），而且必须先 `zcode login` 过。
    if (cliProvider) {
      const cliDefinition = defineTool({
        name: ZCODE_CLI_TOOL_NAME,
        description:
          `Delegate a self-contained task to ZCode through its bundled CLI and return the answer. `
          + `Unlike ${ZCODE_TOOL_NAME} this needs no debug port and no ZCode window: it starts a headless `
          + `node <ZCode>/Resources/glm/zcode.cjs -p <prompt> process per dispatch, in the workspace directory. `
          + `Each dispatch is a new CLI session (no follow-ups) and requires a prior \`zcode login\` in that ZCode install. `
          + `Dispatches are serialized because every CLI run shares one local database.`,
        parameters: {
          description: {
            type: 'string',
            required: true,
            description: 'A short (3-5 word) description of the delegated task, for display.',
          },
          prompt: {
            type: 'string',
            required: true,
            description: 'The complete, self-contained task for ZCode. It does not share this conversation context, so include everything it needs — file paths, the repo, and what "done" looks like.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'activation' },
              subagentId: { type: 'string', required: true },
            },
          },
          render: (_args, value) => [{ type: 'text', text: `started subagent ${value.subagentId}` }],
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
          const parent = exec.agent
          if (!parent) throw new Error(`${ZCODE_CLI_TOOL_NAME} requires a calling agent (exec.agent was undefined)`)
          exec.signal.throwIfAborted()
          const activation = await subCtx.subagents.startActivation({
            provider: ZCODE_CLI_PROVIDER_NAME,
            label: args.description,
            request: { prompt: [{ type: 'text', text: args.prompt }], parent },
            signal: exec.signal,
            delivery: 'parent',
          })
          return { kind: 'activation', subagentId: activation.childId }
        },
      })

      ctx.effect(
        () => subCtx.tools.register(cliDefinition),
        `zcode-native: tool "${ZCODE_CLI_TOOL_NAME}"`,
      )
    }

    // ---- 启动 ZCode（issue #1）-------------------------------------------
    //
    // 派活前 ZCode 必须已经在跑、而且带着 --remote-debugging-port。以前这一步是
    // 用户手动做的（退出 ZCode → 终端里带参数重启），Windows 上尤其别扭。这个
    // 工具让「在会话里让 ZCode 跑起来」成为一次正常调用：用户说一句、模型调一次，
    // 之后再 subagent_zcode 就有后端了。ask() 另有同一条兜底（autoLaunch）。
    const launchDefinition = defineTool({
      name: ZCODE_LAUNCH_TOOL_NAME,
      description:
        `Find the local ZCode app and start it with the remote debugging port this plugin drives, then wait until `
        + `ZCode answers on that port. Use it when ZCode is not running, or after a dispatch failed because nothing `
        + `answered on 127.0.0.1:${resolved.debugPort}. It reuses an already-wired instance. `
        + `A ZCode that is running WITHOUT the debug port cannot be fixed by starting a second copy (Electron focuses `
        + `the first one), so pass restart:true to quit it and relaunch — that loses unsaved work in ZCode.`,
      parameters: {
        restart: {
          type: 'boolean',
          description: 'Quit a running ZCode that has no debug port and relaunch it. Unsaved work in ZCode is lost.',
        },
        executablePath: {
          type: 'string',
          description: 'Explicit ZCode executable path, when auto-discovery misses it (e.g. C:\\Program Files\\ZCode\\ZCode.exe).',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            launched: { type: 'boolean', required: true },
            alreadyRunning: { type: 'boolean', required: true },
            restarted: { type: 'boolean', required: true },
            port: { type: 'number', required: true },
            executablePath: { type: 'string' },
            browser: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.alreadyRunning
            ? `ZCode already answers on 127.0.0.1:${value.port}${value.browser ? ` (${value.browser})` : ''}`
            : `started ZCode with CDP on 127.0.0.1:${value.port}${value.browser ? ` (${value.browser})` : ''}`
              + `${value.restarted ? ' — the previous instance was quit and relaunched' : ''}`
              + `${value.executablePath ? `\nexecutable: ${value.executablePath}` : ''}`,
        }],
      },
      isConcurrencySafe: () => false,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        const outcome = await launch({
          ...launcher,
          executablePath: typeof args.executablePath === 'string' && args.executablePath.length > 0
            ? args.executablePath
            : launcher.executablePath,
          restart: args.restart === true,
        })
        return {
          launched: outcome.launched === true,
          alreadyRunning: outcome.alreadyRunning === true,
          restarted: outcome.restarted === true,
          port: outcome.port,
          executablePath: outcome.executablePath ?? '',
          browser: outcome.browser ?? '',
        }
      },
    })

    ctx.effect(
      () => subCtx.tools.register(launchDefinition),
      `zcode-native: tool "${ZCODE_LAUNCH_TOOL_NAME}"`,
    )

    // 第三条路：前两条（CDP / 内置 CLI）都要机器条件，够不到时退回人工清单。
    // 这里不新增 provider：拿回清单的是父代理自己，没必要造一个假装干活的子代理。
    const checklistDefinition = defineTool({
      name: ZCODE_CHECKLIST_TOOL_NAME,
      description:
        `Hand back the manual procedure for driving ZCode when neither automated backend can serve you: `
        + `no debug port (${ZCODE_TOOL_NAME} cannot reach ZCode), or the CLI has no model it can use `
        + `(${ZCODE_CLI_TOOL_NAME} reports [1113] / "Select a model"). The text carries the DOM project guard, `
        + `the composer and answer selectors that actually work, and the failure modes measured on ZCode 3.17.2. `
        + `Follow it together with the user instead of retrying the same call.`,
      parameters: {
        reason: {
          type: 'string',
          description: 'Why the automated paths are unavailable, e.g. "CDP port 9222 refuses connections".',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, const: 'checklist' },
            guide: { type: 'string', required: true },
          },
        },
        render: (_args, value) => [{ type: 'text', text: value.guide }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        exec.signal.throwIfAborted()
        return {
          kind: 'checklist',
          guide: checklistFor({ reason: args.reason }),
        }
      },
    })

    ctx.effect(
      () => subCtx.tools.register(checklistDefinition),
      `zcode-native: tool "${ZCODE_CHECKLIST_TOOL_NAME}"`,
    )
  })
}
