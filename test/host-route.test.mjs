/**
 * Host-half wiring test — no DSH runtime, no network, no ZCode.
 *
 * `lib/index.js` imports '@deepseek-ai/schemastery' and '@deepseek-ai/dsh-tools',
 * which only exist inside the Desktop asar. To load the real module bare we copy
 * the host files into a temp dir that has stub node_modules — the source under
 * test is the real one.
 *
 * Proves:
 *   - M1/M3: the routes register through ctx.inject(['webServer']) (ctx.get
 *     measured undefined on the predecessor plugin and the route vanished),
 *     answer JSON with no-store, refuse non-loopback callers, cache for cacheMs;
 *   - M4: the provider registers through ctx.inject(['subagents', 'tools']) with
 *     a single-argument registerProvider, and subagent_zcode hands startActivation
 *     exactly the spec the host expects.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, copyFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SRC = join(here, '..', 'lib')
const ROOT = join(tmpdir(), `zn-host-${process.pid}`)
mkdirSync(join(ROOT, 'lib'), { recursive: true })
mkdirSync(join(ROOT, 'node_modules', '@deepseek-ai', 'schemastery'), { recursive: true })
mkdirSync(join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools'), { recursive: true })

writeFileSync(
  join(ROOT, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/schemastery', version: '0.0.0-stub', type: 'module', main: 'index.js', exports: { '.': './index.js' } }),
)
writeFileSync(
  join(ROOT, 'node_modules', '@deepseek-ai', 'schemastery', 'index.js'),
  `const chain = () => { const o = {}; o.default = (v) => { o._d = v; return o }; o.description = () => o; return o }
export default { object: (shape) => ({ shape }), number: chain, string: chain, boolean: chain }`,
)

// defineTool stub: keeps the shape the host enforces (name/description/
// parameters/output.schema+render/execute) and rejects the mistakes that the
// real compiler would reject, without pulling in the asar.
writeFileSync(
  join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'),
  JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0-stub', type: 'module', main: 'index.js', exports: { '.': './index.js' } }),
)
writeFileSync(
  join(ROOT, 'node_modules', '@deepseek-ai', 'dsh-tools', 'index.js'),
  `export function defineTool(options) {
  if (!options || typeof options.name !== 'string' || options.name.length === 0) throw new Error('defineTool: name required')
  if (typeof options.description !== 'string' || options.description.length === 0) throw new Error('defineTool: description required')
  if (typeof options.execute !== 'function') throw new Error('defineTool: execute required')
  if (!options.parameters || typeof options.parameters !== 'object') throw new Error('defineTool: parameters required')
  for (const [key, spec] of Object.entries(options.parameters)) {
    if (typeof spec?.type !== 'string') throw new Error('defineTool: parameter ' + key + ' needs a type')
    if (spec.required === true && spec.type === 'string' && typeof spec.description !== 'string') throw new Error('defineTool: required parameter ' + key + ' needs a description')
  }
  if (!options.output || typeof options.output.render !== 'function') throw new Error('defineTool: output.render required')
  if (!options.output.schema || options.output.schema.type !== 'object') throw new Error('defineTool: output.schema must be an object root')
  return options
}`,
)

writeFileSync(join(ROOT, 'package.json'), JSON.stringify({ name: 'zn-host-test', type: 'module', private: true }))
for (const f of ['index.js', 'status.js', 'cdp.js', 'ask.js', 'provider.js', 'launch.js', 'cli.js', 'checklist.js', 'checklist.md']) copyFileSync(join(SRC, f), join(ROOT, 'lib', f))

// POST /ask 会碰到两个对外说话的叶子模块：CDP（lib/ask.js）与真实的
// `node <zcode.cjs>` 子进程（lib/cli.js）。两者都不属于单元测试。真实实现原样
// 留在 *-impl.js，同名入口换成一个记账的壳：路由本身（index.js）、provider 接线
// 仍然是真源码，壳只让「选了哪个后端、传了什么参数、回了什么响应体」可观测。
for (const leaf of ['ask', 'cli']) {
  copyFileSync(join(ROOT, 'lib', `${leaf}.js`), join(ROOT, 'lib', `${leaf}-impl.js`))
}
writeFileSync(join(ROOT, 'lib', 'ask.js'), `export * from './ask-impl.js'
export const calls = []
export const state = { next: null }
export async function ask(config, prompt, deps) {
  calls.push({ config, prompt, deps })
  if (state.next instanceof Error) throw state.next
  return state.next ?? { status: 'ok', answer: 'fake cdp answer', elapsedMs: 1 }
}`)
writeFileSync(join(ROOT, 'lib', 'cli.js'), `export * from './cli-impl.js'
export const calls = []
export const state = { next: null }
export function runCliPrompt(config, prompt, deps) {
  calls.push({ config, prompt, deps })
  if (state.next instanceof Error) return Promise.reject(state.next)
  return Promise.resolve(state.next ?? { status: 'ok', text: 'fake cli answer', exitCode: 0, elapsedMs: 1 })
}`)

const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
// The very same module instances index.js was just wired against.
const askStub = await import(pathToFileURL(join(ROOT, 'lib', 'ask.js')).href)
const cliStub = await import(pathToFileURL(join(ROOT, 'lib', 'cli.js')).href)
test.after(() => rmSync(ROOT, { recursive: true, force: true }))

/** Minimal cordis-ish ctx: records injects/effects, wires fake services. */
function fakeCtx() {
  const routes = []
  const injects = []
  const subagents = {
    providers: [],
    activations: [],
    registerProvider(provider) {
      // 契约：单参数，收 provider 对象本身。
      if (arguments.length !== 1) throw new Error('registerProvider takes exactly one argument')
      this.providers.push(provider)
      return () => {}
    },
    async startActivation(spec) {
      this.activations.push(spec)
      return { childId: 'zcode-test-child' }
    },
  }
  const tools = {
    definitions: [],
    register(definition) {
      this.definitions.push(definition)
      return () => {}
    },
  }
  return {
    routes,
    injects,
    subagents,
    tools,
    inject(deps, cb) {
      injects.push([...deps])
      if (deps.includes('webServer')) {
        cb({ webServer: { register: (route) => { routes.push(route); return () => {} } } })
        return
      }
      cb({ subagents, tools })
    },
    effect(fn) { fn(); return () => {} },
  }
}

/**
 * A fake request whose body arrives asynchronously, the way a socket delivers it:
 * readRequestBody() only resolves after the 'end' event, so a synchronously
 * prepopulated object would not exercise the handler's await.
 */
function fakeRequest(method, socket, json) {
  const handlers = new Map()
  const payload = Buffer.from(typeof json === 'string' ? json : JSON.stringify(json))
  const request = {
    method,
    socket,
    destroys: 0,
    on(event, handler) {
      handlers.set(event, handler)
      return request
    },
    destroy() { request.destroys += 1 },
  }
  setImmediate(() => {
    handlers.get('data')?.(payload)
    handlers.get('end')?.()
  })
  return request
}

/** Drive the registered handler with a fake req/res pair. */
async function call(route, options = {}) {
  const method = options.method ?? 'GET'
  // Deliberately NOT a destructuring default: `undefined` must reach the handler
  // as-is, otherwise the helper would mask the very case under test.
  const remoteAddress = 'remoteAddress' in options ? options.remoteAddress : '127.0.0.1'
  let status = 0
  let headers = {}
  let body = ''
  const res = {
    writeHead(s, h) { status = s; headers = h },
    end(p) { body = p ?? '' },
  }
  const socket = options.noSocket ? undefined : { remoteAddress }
  const request = options.json === undefined
    ? { method, socket }
    : fakeRequest(method, socket, options.json)
  await route.handler(request, res)
  return { status, headers, body }
}

/** The /ask route the plugin registered (routes are exact-kind, matched by path). */
function askRouteOf(ctx) {
  return ctx.routes.find((route) => route.path === '/plugins/dsh-zcode-native/ask')
}

/** Clear what the recording backends saw; called by every /ask route test. */
function resetBackends() {
  askStub.calls.length = 0
  askStub.state.next = null
  cliStub.calls.length = 0
  cliStub.state.next = null
}

/** Apply the plugin once with the given config. */
function boot(config = { debugPort: 9333, cacheMs: 15000 }) {
  const ctx = fakeCtx()
  mod.apply(ctx, config)
  return ctx
}

test('inject is ["webServer"] and both service groups register through ctx.inject', () => {
  assert.deepEqual(mod.inject, ['webServer'])
  const ctx = boot()
  // webServer first (routes), then the M4 pair (provider + tool). 延后注册是刻意的：
  // ctx.get 在 apply 时刻拿不到这些服务。
  assert.deepEqual(ctx.injects, [['webServer'], ['subagents', 'tools']])
  // M3 added POST /ask next to the M1 status route.
  assert.equal(ctx.routes.length, 2)
  assert.equal(ctx.routes[0].path, '/plugins/dsh-zcode-native/status')
  assert.equal(ctx.routes[1].path, '/plugins/dsh-zcode-native/ask')
})

test('route is exact-kind and answers JSON with no-store', async () => {
  const ctx = boot()
  const route = ctx.routes[0]
  assert.equal(route.kind, 'exact')
  const res = await call(route)
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.doesNotThrow(() => JSON.parse(res.body))
})

test('non-loopback callers get 403', async () => {
  for (const addr of ['10.0.0.5', '192.168.1.9', undefined, null, '']) {
    const res = await call(boot().routes[0], { remoteAddress: addr })
    assert.equal(res.status, 403, `addr=${addr} must be refused`)
  }
})

test('a request with no socket at all is refused (fail closed)', async () => {
  const res = await call(boot().routes[0], { noSocket: true })
  assert.equal(res.status, 403)
})

test('loopback forms are accepted', async () => {
  for (const addr of ['127.0.0.1', '127.5.6.7', '::1', '::ffff:127.0.0.1']) {
    const res = await call(boot().routes[0], { remoteAddress: addr })
    assert.equal(res.status, 200, `addr=${addr} must be allowed`)
  }
})

test('non-GET/HEAD methods get 405', async () => {
  assert.equal((await call(boot().routes[0], { method: 'POST' })).status, 405)
})

test('cacheMs serves the second call from cache', async () => {
  const ctx = boot({ debugPort: 9333, cacheMs: 60000 })
  const a = await call(ctx.routes[0])
  const b = await call(ctx.routes[0])
  assert.equal(a.body, b.body)
})

// ---- M4: 原生子代理接线 ----------------------------------------------------

test('M4: provider is registered as "zcode" and carries the config through', () => {
  const ctx = boot({ debugPort: 9222, cacheMs: 15000, askTimeoutMs: 12345 })
  assert.equal(ctx.subagents.providers.length, 2, 'CDP backend and CLI backend')
  const provider = ctx.subagents.providers.find((entry) => entry.name === 'zcode')
  assert.equal(provider.name, 'zcode')
  assert.equal(provider.prepareContinuable, undefined, '有 prepareContinuable 宿主会当 local 后端')
  assert.equal(provider.capabilities.depthLimit, false)
  // provider 的 options 来自插件 config —— debugPort/askTimeoutMs 必须真的透传。
  assert.equal(provider.options.debugPort, 9222)
  assert.equal(provider.options.askTimeoutMs, 12345)
})

test('M4: subagent_zcode is registered with a self-contained prompt contract', () => {
  const ctx = boot()
  assert.equal(ctx.tools.definitions.length, 4, 'subagent_zcode, subagent_zcode_cli, zcode_launch and zcode_dispatch_checklist')
  const tool = ctx.tools.definitions.find((entry) => entry.name === 'subagent_zcode')
  assert.equal(tool.name, 'subagent_zcode')
  assert.deepEqual(Object.keys(tool.parameters).sort(), ['description', 'prompt'])
  assert.equal(tool.parameters.description.required, true)
  assert.equal(tool.parameters.prompt.required, true)
  // 不暴露 cwd：ZCode 只认自己打开的项目，传 cwd 是假支持。
  assert.equal(tool.parameters.cwd, undefined)
  assert.match(tool.description, /ZCode/)
  assert.match(tool.description, /does not see this conversation/)
  assert.deepEqual(tool.output.schema.properties.kind.const, 'activation')
  assert.deepEqual(tool.output.schema.required, undefined, 'schema 用 per-property required')
  assert.equal(tool.output.schema.properties.subagentId.type, 'string')
})

test('M4: execute refuses to run without a calling agent', async () => {
  const tool = boot().tools.definitions.find((entry) => entry.name === 'subagent_zcode')
  await assert.rejects(
    () => tool.execute({ description: 'd', prompt: 'p' }, { signal: new AbortController().signal }),
    /requires a calling agent/,
  )
})

test('M4: execute hands startActivation the exact host spec', async () => {
  const ctx = boot()
  const tool = ctx.tools.definitions.find((entry) => entry.name === 'subagent_zcode')
  const parent = { id: 'agent-1' }
  const value = await tool.execute(
    { description: '读 README', prompt: '读 README.md 第一行' },
    { agent: parent, signal: new AbortController().signal },
  )
  assert.deepEqual(value, { kind: 'activation', subagentId: 'zcode-test-child' })
  assert.equal(ctx.subagents.activations.length, 1)
  const spec = ctx.subagents.activations[0]
  assert.equal(spec.provider, 'zcode')
  assert.equal(spec.label, '读 README')
  assert.equal(spec.delivery, 'parent')
  assert.deepEqual(spec.request.prompt, [{ type: 'text', text: '读 README.md 第一行' }])
  assert.equal(spec.request.parent, parent)
  // capabilities 全 false ⇒ 这些字段一个都不能出现，否则 assertCapabilities 抛。
  for (const key of ['agentOptions', 'agentPreset', 'outputSchema', 'maxDepth']) {
    assert.equal(spec.request[key], undefined, `${key} must not be forwarded to an external backend`)
  }
})

test('M4: an aborted exec signal stops before startActivation', async () => {
  const ctx = boot()
  const tool = ctx.tools.definitions.find((entry) => entry.name === 'subagent_zcode')
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => tool.execute({ description: 'd', prompt: 'p' }, { agent: { id: 'a' }, signal: controller.signal }),
  )
  assert.equal(ctx.subagents.activations.length, 0)
})

// ---- issue #1: 从会话里启动 ZCode ------------------------------------------

test('launch: zcode_launch exposes the two optional knobs and no surprises', () => {
  const ctx = boot()
  const tool = ctx.tools.definitions.find((entry) => entry.name === 'zcode_launch')
  assert.ok(tool, 'zcode_launch must be registered next to subagent_zcode')
  assert.deepEqual(Object.keys(tool.parameters).sort(), ['executablePath', 'restart'])
  // Both are optional: the zero-arg call is the common one.
  for (const [key, spec] of Object.entries(tool.parameters)) {
    assert.notEqual(spec.required, true, `${key} must stay optional`)
    assert.equal(typeof spec.description, 'string')
  }
  assert.equal(tool.isConcurrencySafe(), false, 'starting an app is not concurrency safe')
  assert.deepEqual(
    Object.keys(tool.output.schema.properties).sort(),
    ['alreadyRunning', 'browser', 'executablePath', 'launched', 'port', 'restarted'],
  )
  assert.equal(tool.output.schema.properties.port.type, 'number')
  assert.match(tool.description, /ZCode/)
})

// ---- CLI 后端（ZCode 3.17.2 没有 CDP 时的替代通道） -----------------------

test('cli backend: a second provider and a second delegation tool are registered', () => {
  const ctx = boot({ cliTimeoutMs: 4321 })
  const cli = ctx.subagents.providers.find((entry) => entry.name === 'zcode-cli')
  assert.ok(cli, 'zcode-cli provider must be registered')
  assert.equal(cli.prepareContinuable, undefined)
  assert.equal(cli.capabilities.depthLimit, false)
  assert.equal(cli.inheritsParentContext, false)
  assert.equal(cli.options.timeoutMs, 4321)
  assert.equal(cli.options.entryPath, undefined, 'empty cliEntry means discover')
})

test('cli backend: cliEnabled false removes the provider and its tool, leaving M4 untouched', () => {
  const ctx = boot({ cliEnabled: false })
  assert.deepEqual(ctx.subagents.providers.map((entry) => entry.name), ['zcode'])
  assert.deepEqual(
    ctx.tools.definitions.map((entry) => entry.name).sort(),
    ['subagent_zcode', 'zcode_dispatch_checklist', 'zcode_launch'],
  )
})

test('cli backend: subagent_zcode_cli routes to the zcode-cli provider', async () => {
  const ctx = boot()
  const tool = ctx.tools.definitions.find((entry) => entry.name === 'subagent_zcode_cli')
  assert.deepEqual(Object.keys(tool.parameters).sort(), ['description', 'prompt'])
  assert.match(tool.description, /no debug port/)
  assert.match(tool.description, /zcode login/)
  const value = await tool.execute(
    { description: '跑一遍测试', prompt: '在本仓库跑 node --test' },
    { agent: { id: 'agent-2' }, signal: new AbortController().signal },
  )
  assert.deepEqual(value, { kind: 'activation', subagentId: 'zcode-test-child' })
  const spec = ctx.subagents.activations[0]
  assert.equal(spec.provider, 'zcode-cli')
  for (const key of ['agentOptions', 'agentPreset', 'outputSchema', 'maxDepth']) {
    assert.equal(spec.request[key], undefined, `${key} must not be forwarded to an external backend`)
  }
})

test('checklist: zcode_dispatch_checklist hands back the manual procedure', async () => {
  const ctx = boot()
  const tool = ctx.tools.definitions.find((entry) => entry.name === 'zcode_dispatch_checklist')
  assert.ok(tool, 'the third path must be registered next to the two backends')
  assert.deepEqual(Object.keys(tool.parameters), ['reason'])
  assert.equal(tool.parameters.reason.required, undefined, 'reason is optional')
  assert.equal(tool.isConcurrencySafe(), true)
  assert.deepEqual(Object.keys(tool.output.schema.properties).sort(), ['guide', 'kind'])

  const value = await tool.execute(
    { reason: 'CDP 端口不可用，CLI 也没有可用模型' },
    { signal: new AbortController().signal },
  )
  assert.equal(value.kind, 'checklist')
  assert.match(value.guide, /CDP 端口不可用，CLI 也没有可用模型/)
  assert.match(value.guide, /DOM 项目守卫/)
  assert.match(value.guide, /subagent_zcode/)

  const rendered = tool.output.render({}, value)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0].type, 'text')
  assert.equal(rendered[0].text, value.guide, '渲染就是整份清单，不要截断')
})

// ---- POST /ask: backend 选择器（缺省 cdp / 显式 cli） -----------------------
//
// 这一层只证明「路由把活交给了谁、给了什么参数、回了什么」。CDP 与真实 CLI
// 子进程由上面那两个记账壳代替，见文件顶部 fixture 的说明。

test('ask route: omitting backend (or "cdp") keeps the old path byte-for-byte', async () => {
  const ctx = boot({ debugPort: 9333, cacheMs: 15000 })
  const route = askRouteOf(ctx)
  const sentinel = { status: 'ok', answer: '老路径的答案 ✓', elapsedMs: 42 }

  for (const body of [{ prompt: '你好' }, { prompt: '你好', backend: 'cdp' }]) {
    resetBackends()
    askStub.state.next = sentinel
    const res = await call(route, { method: 'POST', json: body })

    assert.equal(res.status, 200)
    // 逐字节：handler 不得重塑 ask() 的结果（不补字段、不改键序、不加 backend）。
    assert.equal(res.body, JSON.stringify(sentinel), `body=${JSON.stringify(body)} must pass through untouched`)
    assert.deepEqual(Object.keys(JSON.parse(res.body)).sort(), ['answer', 'elapsedMs', 'status'])
    assert.equal(cliStub.calls.length, 0, 'the cli backend must not run for the cdp path')

    assert.equal(askStub.calls.length, 1)
    const [{ config, prompt, deps }] = askStub.calls
    assert.equal(prompt, '你好')
    assert.equal(config.debugPort, 9333)
    // 第三参数与加这个字段之前一样：恰好一个 ensureRunning。
    assert.deepEqual(Object.keys(deps), ['ensureRunning'])
    assert.equal(typeof deps.ensureRunning, 'function')
  }
})

test('ask route: backend "cli" drives the CLI backend with the configured knobs', async () => {
  const ctx = boot({ cliEntry: '/opt/zcode/glm/zcode.cjs', cliTimeoutMs: 2222, cliSessionId: 'sess-42' })
  const route = askRouteOf(ctx)
  resetBackends()
  const outcome = { status: 'ok', text: '来自无头进程的答案', exitCode: 0, elapsedMs: 11 }
  cliStub.state.next = outcome

  const res = await call(route, { method: 'POST', json: { prompt: '跑一遍测试', backend: 'cli' } })

  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), { ...outcome, backend: 'cli' })
  assert.equal(askStub.calls.length, 0, 'the cdp backend must not be touched')

  assert.equal(cliStub.calls.length, 1)
  assert.equal(cliStub.calls[0].prompt, '跑一遍测试')
  assert.deepEqual(cliStub.calls[0].config, {
    entryPath: '/opt/zcode/glm/zcode.cjs',
    cwd: process.cwd(),
    timeoutMs: 2222,
    sessionId: 'sess-42',
  })
})

test('ask route: backend "cli" with cliEnabled:false answers an error and spawns nothing', async () => {
  const ctx = boot({ cliEnabled: false })
  const route = askRouteOf(ctx)
  resetBackends()

  const res = await call(route, { method: 'POST', json: { prompt: '跑一遍测试', backend: 'cli' } })

  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), {
    status: 'error',
    error: 'cli-disabled: the CLI backend is turned off (cliEnabled: false)',
    elapsedMs: null,
    backend: 'cli',
  })
  assert.equal(cliStub.calls.length, 0, 'a disabled backend must not reach the CLI process')
  assert.equal(askStub.calls.length, 0)
})

test('ask route: a failing CLI backend answers 200 with the stable error shape', async () => {
  const ctx = boot()
  const route = askRouteOf(ctx)
  resetBackends()
  cliStub.state.next = Object.assign(new Error('no answer within 600000ms'), { code: 'cli-timeout' })

  const res = await call(route, { method: 'POST', json: { prompt: 'p', backend: 'cli' } })

  assert.equal(res.status, 200)
  assert.deepEqual(JSON.parse(res.body), {
    status: 'error',
    error: 'cli-timeout: no answer within 600000ms',
    elapsedMs: null,
    backend: 'cli',
  })
})

test('ask route: an unknown backend is a 400 and touches neither backend', async () => {
  const ctx = boot()
  const route = askRouteOf(ctx)
  resetBackends()

  for (const backend of ['nope', '', null, 'CDP', 1]) {
    const res = await call(route, { method: 'POST', json: { prompt: 'p', backend } })
    assert.equal(res.status, 400, `backend=${JSON.stringify(backend)} must be refused`)
    assert.deepEqual(JSON.parse(res.body), { error: 'backend must be "cdp" or "cli"' })
  }

  assert.equal(askStub.calls.length, 0, 'an invalid backend must not reach cdp')
  assert.equal(cliStub.calls.length, 0, 'an invalid backend must not reach the cli')
})
