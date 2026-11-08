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
for (const f of ['index.js', 'status.js', 'cdp.js', 'ask.js', 'provider.js', 'launch.js', 'cli.js']) copyFileSync(join(SRC, f), join(ROOT, 'lib', f))

const mod = await import(pathToFileURL(join(ROOT, 'lib', 'index.js')).href)
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
  await route.handler({ method, socket }, res)
  return { status, headers, body }
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
  assert.equal(ctx.tools.definitions.length, 3, 'subagent_zcode, subagent_zcode_cli and zcode_launch')
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
    ['subagent_zcode', 'zcode_launch'],
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
