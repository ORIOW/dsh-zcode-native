import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { collectStatus } from './status.js'
import { ask } from './ask.js'
import { ZCODE_PROVIDER_NAME, ZCODE_TOOL_NAME, ZcodeSubagentProvider } from './provider.js'

export const name = 'zcode-native'

/** webServer is optional to the host: routes attach whenever the carrier is up. */
export const inject = ['webServer']

export const Config = Schema.object({
  debugPort: Schema.number().default(9222).description('ZCode 调试端口（CDP）'),
  cacheMs: Schema.number().default(15000).description('状态缓存有效期（毫秒）'),
  askTimeoutMs: Schema.number().default(600000).description('ask 等待答案的超时（毫秒）'),
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
  }

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
          try {
            send(response, 200, await ask(resolved, prompt))
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
  })

  ctx.inject(['subagents', 'tools'], (subCtx) => {
    // 先 provider 后工具：工具的 execute 要 startActivation，而它会
    // expectProvider 查表，provider 不在册就直接 UNKNOWN_PROVIDER。
    ctx.effect(
      () => subCtx.subagents.registerProvider(provider),
      `zcode-native: subagent provider "${ZCODE_PROVIDER_NAME}"`,
    )

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
  })
}
