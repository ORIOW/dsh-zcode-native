/**
 * M2 client-envelope checks for lib/client.js.
 *
 * The client half is injected as a CLASSIC script (no type="module"), so the
 * tests here assert the envelope contract with node:vm instead of importing
 * the file — importing would either fail on the top-level
 * `window.__ModuleLoader__` reference or, worse, pass silently after a
 * transpiler rewrote the ESM syntax the host would choke on.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const PACKAGE_ID = 'dsh-zcode-native'
const TAB_ID = 'zcode-native'
const STORAGE_KEY = 'dsh-zcode-native:sidebar'

function makeReactStub() {
  return {
    createElement: (tag, props, ...children) => ({ tag, props, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
}

/** vm sandbox with a recording __ModuleLoader__ and a react-only require. */
function makeSandbox({ pref = null } = {}) {
  const loads = []
  const window = {
    __ModuleLoader__: { load: (definition) => loads.push(definition) },
    localStorage: { getItem: () => pref, setItem: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  }
  const sandbox = { window, console }
  sandbox.require = (id) => {
    if (id === 'react') return makeReactStub()
    throw new Error(`unexpected require(${id})`)
  }
  vm.createContext(sandbox)
  return { sandbox, loads }
}

function run(loads, sandbox) {
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  assert.equal(loads.length, 1, 'exactly one __ModuleLoader__.load call')
  return loads[0].factory(sandbox.require)
}

/** Recording ctx mock; ctx.effect runs the setup eagerly like cordis does. */
function makeCtx() {
  const injected = []
  const registered = []
  const tabRegistrations = []
  const ctx = {
    slots: {
      inject: (name, factory) => {
        injected.push({ name, factory })
        return () => {}
      },
      register: (spec, component) => {
        registered.push({ spec, component })
        return () => {}
      },
    },
    sidebarRightTabs: {
      register: (spec) => {
        tabRegistrations.push(spec)
        return () => {}
      },
    },
    effect: (setup) => setup(),
    logger: { info: () => {} },
  }
  return { ctx, injected, registered, tabRegistrations }
}

test('client.js contains no ESM syntax (classic script)', () => {
  assert.doesNotMatch(source, /^\s*(?:import|export)\b/m)
})

test('__ModuleLoader__.load is called exactly once with the package id', () => {
  const { sandbox, loads } = makeSandbox()
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  assert.equal(loads.length, 1)
  assert.equal(loads[0].id, PACKAGE_ID)
})

test('exports: inject = [slots, sidebarRightTabs], apply is a function', () => {
  const { sandbox, loads } = makeSandbox()
  const mod = run(loads, sandbox)
  // mod.inject is an Array from the vm realm; copy it for cross-realm deepEqual.
  assert.deepEqual(Array.from(mod.inject), ['slots', 'sidebarRightTabs'])
  assert.equal(typeof mod.apply, 'function')
})

test('apply (default pref) registers the tab; all three keys match TAB_ID', () => {
  const { sandbox, loads } = makeSandbox()
  const mod = run(loads, sandbox)
  const { ctx, injected, registered, tabRegistrations } = makeCtx()

  mod.apply(ctx)

  assert.equal(tabRegistrations.length, 1, 'sidebarRightTabs.register called once')
  assert.equal(tabRegistrations[0].id, TAB_ID)
  assert.equal(tabRegistrations[0].kind, 'zcode-native')
  assert.notEqual(tabRegistrations[0].kind, 'plan')
  assert.notEqual(tabRegistrations[0].kind, 'files')

  for (const { factory } of injected) factory()

  const panes = registered.filter((entry) => entry.spec.name === 'sidebar.right.pane.tab')
  const titles = registered.filter((entry) => entry.spec.name === 'sidebar.right.pane.tab.title')
  assert.equal(panes.length, 1)
  assert.equal(titles.length, 1)
  assert.equal(panes[0].spec.key, TAB_ID)
  assert.equal(titles[0].spec.key, TAB_ID)
  assert.equal(typeof panes[0].component, 'function')
  assert.equal(typeof titles[0].component, 'function')

  assert.ok(registered.some((entry) => entry.spec.name === 'settings.section'), 'settings card present')
})

test('pref=off: tab NOT registered, settings card still registered', () => {
  const { sandbox, loads } = makeSandbox({ pref: 'off' })
  const mod = run(loads, sandbox)
  const { ctx, injected, registered, tabRegistrations } = makeCtx()

  mod.apply(ctx)
  for (const { factory } of injected) factory()

  assert.equal(tabRegistrations.length, 0)
  assert.equal(registered.filter((entry) => entry.spec.name.startsWith('sidebar.right.pane')).length, 0)
  assert.ok(registered.some((entry) => entry.spec.name === 'settings.section'), 'card must survive the off state')
})

test('storage event with pref=off disposes all three registrations in reverse order, on re-registers', () => {
  // Sandbox with MUTABLE storage so the storage-listener path can be driven.
  let pref = null
  const loads = []
  const windowListeners = []
  const window = {
    __ModuleLoader__: { load: (definition) => loads.push(definition) },
    localStorage: { getItem: () => pref, setItem: (key, value) => { pref = value } },
    addEventListener: (type, fn) => windowListeners.push([type, fn]),
    removeEventListener: () => {},
  }
  const sandbox = { window, console }
  sandbox.require = (id) => (id === 'react' ? makeReactStub() : undefined)
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' })
  const mod = loads[0].factory(sandbox.require)

  const disposed = []
  const tabRegistrations = []
  const ctx = {
    slots: {
      inject: (name, factory) => {
        factory() // the real host runs the factory eagerly; its disposer is the inject's return
        return () => disposed.push(`inject:${name}`)
      },
      register: () => () => disposed.push('register:???'),
    },
    sidebarRightTabs: {
      register: (spec) => {
        tabRegistrations.push(spec)
        return () => disposed.push(`tab:${spec.id}`)
      },
    },
    effect: (setup) => setup(),
  }

  mod.apply(ctx)
  assert.equal(tabRegistrations.length, 1, 'default pref (absent) is ON')

  const storageListener = windowListeners.find(([type]) => type === 'storage')
  assert.ok(storageListener, 'a storage listener must be attached')

  pref = 'off'
  storageListener[1]({ key: STORAGE_KEY })
  assert.deepEqual(disposed, [
    'inject:sidebar.right.pane.tab.title',
    'inject:sidebar.right.pane.tab',
    'tab:zcode-native',
  ], 'dispose must run in reverse registration order and cover all three')

  pref = 'on'
  storageListener[1]({ key: STORAGE_KEY })
  assert.equal(tabRegistrations.length, 2, 'toggling back on re-registers the tab')
})
