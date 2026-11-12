/**
 * Unit tests for lib/launch.js — finding and starting the local ZCode app.
 *
 * Nothing here touches a real filesystem, process table or network: every dep
 * (exists / listDir / run / spawn / fetch / sleep / now) is a fake, so the whole
 * platform matrix runs on any OS in milliseconds.
 *
 * Run: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LaunchError,
  candidateExecutables,
  compareVersions,
  discoverExecutable,
  launch,
  probeAppVersion,
  probeDebugPort,
  versionAtLeast,
} from '../lib/launch.js'

const WIN_ENV = {
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
  APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
  ProgramFiles: 'C:\\Program Files',
}

/** A clock that only moves when the code under test sleeps. */
function makeClock() {
  let time = 0
  return {
    now: () => time,
    sleep: async (ms) => {
      time += ms
    },
    advance: (ms) => {
      time += ms
    },
  }
}

/**
 * Defaults describe a machine where ZCode IS installed at the folder the
 * Windows candidate list predicts, and where nothing answers on CDP yet.
 */
function makeDeps(overrides = {}) {
  const clock = makeClock()
  const wins = 'C:\\Users\\me\\AppData\\Local\\Programs\\ZCode\\ZCode.exe'
  const deps = {
    platform: 'win32',
    env: WIN_ENV,
    home: 'C:\\Users\\me',
    exists: async (path) => path === wins,
    listDir: async () => [],
    run: async () => ({ stdout: '' }),
    spawn: () => ({ pid: 4242, unref() {} }),
    fetch: async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:9222')
    },
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  }
  return { deps, clock, wins }
}

test('candidate list: Windows starts at %LOCALAPPDATA%\\Programs\\ZCode', () => {
  const list = candidateExecutables({ platform: 'win32', env: WIN_ENV, home: 'C:\\Users\\me' })
  assert.equal(list[0], 'C:\\Users\\me\\AppData\\Local\\Programs\\ZCode\\ZCode.exe')
  // Machine-wide installs are still found, just later.
  assert.ok(list.includes('C:\\Program Files\\ZCode\\ZCode.exe'))
  assert.ok(list.every((entry) => entry.endsWith('ZCode.exe')))
})

test('candidate list: macOS points at the app bundle binary', () => {
  const list = candidateExecutables({ platform: 'darwin', env: {}, home: '/Users/me' })
  assert.deepEqual(list, [
    '/Applications/ZCode.app/Contents/MacOS/ZCode',
    '/Users/me/Applications/ZCode.app/Contents/MacOS/ZCode',
  ])
})

test('discover: an explicit path wins, and a wrong one fails loudly', async () => {
  const { deps } = makeDeps({ exists: async (path) => path === 'D:\\Apps\\ZCode\\ZCode.exe' })
  const found = await discoverExecutable({ executablePath: 'D:\\Apps\\ZCode\\ZCode.exe' }, deps)
  assert.equal(found.executablePath, 'D:\\Apps\\ZCode\\ZCode.exe')
  assert.equal(found.source, 'explicit')

  const missing = await discoverExecutable({ executablePath: 'D:\\Nope\\ZCode.exe' }, deps)
    .then(() => null, (error) => error)
  assert.ok(missing instanceof LaunchError)
  assert.equal(missing.code, 'executable-not-found')
  assert.match(missing.message, /D:\\Nope\\ZCode\.exe/)
})

test('discover: falls back to `where ZCode.exe` when the candidates miss', async () => {
  const calls = []
  const { deps } = makeDeps({
    exists: async () => false,
    run: async (file, args) => {
      calls.push([file, ...args])
      return { stdout: 'C:\\Elsewhere\\ZCode.exe\r\n' }
    },
  })
  // The `where` hit must exist for the discovery to accept it.
  const withHit = { ...deps, exists: async (path) => path === 'C:\\Elsewhere\\ZCode.exe' }
  const found = await discoverExecutable({}, withHit)
  assert.equal(found.executablePath, 'C:\\Elsewhere\\ZCode.exe')
  assert.equal(found.source, 'path')
  assert.deepEqual(calls, [['where', 'ZCode.exe']])
  assert.ok(found.searched.includes('where ZCode.exe'))
})

test('discover: a two-level scan finds builds the candidate list cannot predict', async () => {
  const nested = 'C:\\Users\\me\\AppData\\Local\\Programs\\ZCode\\app-3.17.1\\ZCode.exe'
  const { deps } = makeDeps({
    exists: async (path) => path === nested,
    listDir: async (dir) => {
      if (dir === 'C:\\Users\\me\\AppData\\Local\\Programs') {
        return [{ name: 'ZCode', isDirectory: () => true }, { name: 'Other', isDirectory: () => true }]
      }
      if (dir === 'C:\\Users\\me\\AppData\\Local\\Programs\\ZCode') {
        return [{ name: 'app-3.17.1', isDirectory: () => true }]
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    },
  })
  const found = await discoverExecutable({}, deps)
  assert.equal(found.executablePath, nested)
  assert.equal(found.source, 'scan')
})

test('discover: nothing anywhere reports every place it looked', async () => {
  const { deps } = makeDeps({ exists: async () => false })
  const found = await discoverExecutable({}, deps)
  assert.equal(found.executablePath, null)
  assert.ok(found.searched.includes('where ZCode.exe'))
  assert.ok(found.searched.some((entry) => entry.includes('scan')))
})

test('probe: a refused port is data, not an exception', async () => {
  const refused = await probeDebugPort(9222, {
    fetch: async () => {
      throw new Error('ECONNREFUSED')
    },
  })
  assert.equal(refused.reachable, false)
  assert.match(refused.reason, /ECONNREFUSED/)

  const alive = await probeDebugPort(9222, {
    fetch: async () => ({ ok: true, json: async () => ({ Browser: 'ZCode/3.17.1' }) }),
  })
  assert.equal(alive.reachable, true)
  assert.equal(alive.browser, 'ZCode/3.17.1')
})

test('launch: an already-wired ZCode is reused, not started twice', async () => {
  let spawned = 0
  const probeRuns = []
  const { deps } = makeDeps({
    fetch: async () => ({ ok: true, json: async () => ({ Browser: 'ZCode/3.17.1', webSocketDebuggerUrl: 'ws://x' }) }),
    spawn: () => {
      spawned += 1
      return { pid: 1, unref() {} }
    },
    run: async (file, args) => {
      probeRuns.push([file, ...(args ?? [])])
      return { stdout: '3.18.0' }
    },
  })
  const outcome = await launch({ port: 9222 }, deps)
  assert.equal(outcome.alreadyRunning, true)
  assert.equal(outcome.launched, false)
  assert.equal(outcome.browser, 'ZCode/3.17.1')
  assert.equal(spawned, 0)
  assert.equal(probeRuns.length, 0, 'a reachable port short-circuits before the version probe')
})

test('launch: a running ZCode without the port is refused unless restart is explicit', async () => {
  let spawned = 0
  let quit = 0
  const { deps } = makeDeps({
    listRunning: async () => [{ pid: 100 }],
    spawn: () => {
      spawned += 1
      return { pid: 1, unref() {} }
    },
    quit: async () => {
      quit += 1
    },
  })
  const error = await launch({ port: 9222 }, deps).then(() => null, (failure) => failure)
  assert.ok(error instanceof LaunchError)
  assert.equal(error.code, 'already-running-without-debug-port')
  assert.match(error.message, /pid 100/)
  assert.match(error.message, /restart:true/)
  assert.equal(spawned, 0)
  assert.equal(quit, 0)
})

test('launch: restart quits the old instance, then starts the app with the port', async () => {
  const { deps, clock } = makeDeps({ listRunning: async () => [{ pid: 100 }] })
  const spawnedArgs = []
  const quits = []
  const probes = [
    { reachable: false, reason: 'ECONNREFUSED' },
    { reachable: false, reason: 'ECONNREFUSED' },
    { reachable: true, browser: 'ZCode/3.17.1' },
  ]
  const merged = {
    ...deps,
    spawn: (file, args) => {
      spawnedArgs.push([file, ...args])
      return { pid: 4242, unref() {} }
    },
    quit: async (processes) => {
      quits.push(processes)
    },
    fetch: async () => {
      const next = probes.shift() ?? { reachable: true, browser: 'ZCode/3.17.1' }
      if (!next.reachable) throw new Error(next.reason)
      return { ok: true, json: async () => ({ Browser: next.browser }) }
    },
  }
  // probeDebugPort is called with (port, deps) — deps must carry the fake fetch.
  const outcome = await launch({ port: 9222, restart: true }, merged)
  assert.equal(outcome.launched, true)
  assert.equal(outcome.restarted, true)
  assert.equal(outcome.pid, 4242)
  assert.equal(outcome.browser, 'ZCode/3.17.1')
  assert.equal(quits.length, 1)
  assert.deepEqual(quits[0], [{ pid: 100 }])
  assert.equal(spawnedArgs.length, 1)
  assert.equal(spawnedArgs[0][0], 'C:\\Users\\me\\AppData\\Local\\Programs\\ZCode\\ZCode.exe')
  assert.deepEqual(spawnedArgs[0].slice(1), ['--remote-debugging-port=9222'])
  assert.ok(clock.now() > 0, 'the wait should have advanced the clock')
})

test('launch: macOS spawns the bundle binary directly, so argv reaches the app', async () => {
  let fetchCalls = 0
  const spawnedArgs = []
  const { deps } = makeDeps({
    platform: 'darwin',
    env: {},
    home: '/Users/me',
    exists: async (path) => path === '/Applications/ZCode.app/Contents/MacOS/ZCode',
    listRunning: async () => [],
    spawn: (file, args) => {
      spawnedArgs.push([file, ...args])
      return { pid: 7, unref() {} }
    },
    // First probe (the "is it already wired?" check) must miss, then the app opens.
    fetch: async () => {
      if (fetchCalls++ === 0) throw new Error('ECONNREFUSED 127.0.0.1:9333')
      return { ok: true, json: async () => ({ Browser: 'ZCode/3.17.1' }) }
    },
  })
  const outcome = await launch({ port: 9333, timeoutMs: 1000 }, deps)
  assert.equal(outcome.launched, true)
  assert.equal(spawnedArgs.length, 1)
  // `open --args` dropped the switch on ZCode 3.17.2 — the binary is spawned directly.
  assert.deepEqual(spawnedArgs[0], ['/Applications/ZCode.app/Contents/MacOS/ZCode', '--remote-debugging-port=9333'])
  assert.equal(outcome.pid, 7)
})

test('launch: a port that never opens fails with the elapsed budget, not a hang', async () => {
  const { deps, clock } = makeDeps({ timeoutMs: 1500 })
  const error = await launch({ port: 9222, timeoutMs: 1500 }, deps).then(() => null, (failure) => failure)
  assert.ok(error instanceof LaunchError)
  assert.equal(error.code, 'launch-timeout')
  assert.match(error.message, /127\.0\.0\.1:9222 within 1500ms/)
  assert.ok(clock.now() >= 1500, 'the poll loop must respect its deadline')
})

test('launch: a build that refuses the switch says so, instead of only timing out', async () => {
  const listeners = {}
  const stderr = {
    setEncoding() {},
    on(event, handler) {
      listeners[event] = handler
      return this
    },
  }
  const { deps } = makeDeps({
    spawn: () => {
      // ZCode 3.17.2 on macOS rejects the switch outright; that line is the whole
      // diagnosis, so it has to reach the error message.
      queueMicrotask(() => listeners.data?.('ZCode: bad option: --remote-debugging-port=9222\n'))
      return { pid: 4242, unref() {}, stderr }
    },
  })
  const error = await launch({ port: 9222, timeoutMs: 600 }, deps).then(() => null, (failure) => failure)
  assert.ok(error instanceof LaunchError)
  assert.equal(error.code, 'launch-timeout')
  assert.match(error.message, /bad option: --remote-debugging-port=9222/)
})

test('launch: no executable anywhere is an actionable error, not a spawn attempt', async () => {
  let spawned = 0
  const { deps } = makeDeps({
    exists: async () => false,
    spawn: () => {
      spawned += 1
      return { pid: 1, unref() {} }
    },
  })
  const error = await launch({ port: 9222 }, deps).then(() => null, (failure) => failure)
  assert.ok(error instanceof LaunchError)
  assert.equal(error.code, 'executable-not-found')
  assert.match(error.message, /executablePath/)
  assert.match(error.message, /where ZCode\.exe/)
  assert.equal(spawned, 0)
})

test('launch: a non-integer port is rejected before touching the machine', async () => {
  let probed = 0
  const { deps } = makeDeps({
    fetch: async () => {
      probed += 1
      return { ok: true, json: async () => ({}) }
    },
  })
  const error = await launch({ port: 9.5 }, deps).then(() => null, (failure) => failure)
  assert.equal(error.code, 'bad-port')
  assert.equal(probed, 0)
})

test('versions: dotted segments compare numerically, missing segments count as 0', () => {
  assert.equal(compareVersions('3.17.2', '3.17.2'), 0)
  assert.equal(compareVersions('3.17.1', '3.17.2'), -1)
  assert.equal(compareVersions('3.18.0.10300', '3.17.2'), 1)
  assert.equal(compareVersions('3.17', '3.17.0'), 0)
  assert.equal(compareVersions('3.9.9', '3.17.2'), -1) // 9 < 17 numerically, not lexically
  assert.equal(compareVersions('3.17.10', '3.17.2'), 1) // 10 > 2 numerically, not lexically
  assert.equal(compareVersions('3.17.2', '3.17.10'), -1)
  assert.equal(versionAtLeast('3.17.2', '3.17.2'), true)
  assert.equal(versionAtLeast('3.17.1', '3.17.2'), false)
  assert.equal(versionAtLeast('3.18.0.10300', '3.17.2'), true)
})

test('probeAppVersion: Windows reads the file version resource via powershell', async () => {
  const calls = []
  const version = await probeAppVersion('C:\\Program Files\\ZCode\\ZCode.exe', {
    platform: 'win32',
    run: async (file, args) => {
      calls.push([file, ...args])
      return { stdout: '3.18.0.10300\r\n' }
    },
  })
  assert.equal(version, '3.18.0.10300')
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'powershell')
  assert.equal(calls[0][1], '-NoProfile')
  // The path must be embedded INSIDE the -Command string (single-quoted), not
  // passed as a trailing argument: PowerShell concatenates trailing arguments
  // into the command text, so a separate path argument is a parser error.
  assert.equal(calls[0][2], '-Command')
  assert.equal(calls[0][3], "(Get-Item -LiteralPath 'C:\\Program Files\\ZCode\\ZCode.exe').VersionInfo.FileVersion")
})

test('probeAppVersion: a single quote in the path is escaped for PowerShell', async () => {
  const calls = []
  const version = await probeAppVersion("C:\\Program Files\\ZCode's\\ZCode.exe", {
    platform: 'win32',
    run: async (file, args) => {
      calls.push([file, ...args])
      return { stdout: '3.18.0\r\n' }
    },
  })
  assert.equal(version, '3.18.0')
  assert.ok(calls[0][3].includes("ZCode''s"), 'single quotes must be doubled inside the -Command string')
})

test('probeAppVersion: macOS reads CFBundleShortVersionString from the bundle Info.plist', async () => {
  const calls = []
  const version = await probeAppVersion('/Applications/ZCode.app/Contents/MacOS/ZCode', {
    platform: 'darwin',
    run: async (file, args) => {
      calls.push([file, ...args])
      return { stdout: '3.17.2\n' }
    },
  })
  assert.equal(version, '3.17.2')
  assert.deepEqual(calls[0], ['defaults', 'read', '/Applications/ZCode.app/Contents/Info.plist', 'CFBundleShortVersionString'])
})

test('probeAppVersion: linux pins the version to a line that says version', async () => {
  const calls = []
  const decoy = await probeAppVersion('/opt/ZCode/zcode', {
    platform: 'linux',
    run: async (file, args) => {
      calls.push([file, ...(args ?? [])])
      return { stdout: 'Built 2026.11.12\nVersion 3.18.0.10300\n' }
    },
  })
  assert.equal(decoy, '3.18.0.10300', 'an earlier dotted number (a date) must not win')
  assert.deepEqual(calls[0], ['/opt/ZCode/zcode', '--version'])
  const bare = await probeAppVersion('/opt/ZCode/zcode', {
    platform: 'linux',
    run: async () => ({ stdout: '3.17.1\n' }),
  })
  assert.equal(bare, '3.17.1', 'bare version output still parses via the fallback')
})

test('probeAppVersion: unreadable metadata is null, never an exception', async () => {
  const broken = await probeAppVersion('C:\\ZCode.exe', {
    platform: 'win32',
    run: async () => {
      throw new Error('spawn powershell ENOENT')
    },
  })
  assert.equal(broken, null)
  const noVersion = await probeAppVersion('C:\\ZCode.exe', {
    platform: 'win32',
    run: async () => ({ stdout: '' }),
  })
  assert.equal(noVersion, null)
})

test('launch: a CDP-refusing version fails fast — no spawn, no quit, no budget burned', async () => {
  let spawned = 0
  let quit = 0
  const { deps, clock } = makeDeps({
    listRunning: async () => [{ pid: 100 }],
    spawn: () => {
      spawned += 1
      return { pid: 1, unref() {} }
    },
    quit: async () => {
      quit += 1
    },
    run: async (file) => (file === 'powershell' ? { stdout: '3.18.0.10300\r\n' } : { stdout: '' }),
  })
  const error = await launch({ port: 9222, restart: true }, deps).then(() => null, (failure) => failure)
  assert.ok(error instanceof LaunchError)
  assert.equal(error.code, 'version-no-cdp')
  assert.match(error.message, /3\.18\.0\.10300/)
  assert.match(error.message, /subagent_zcode_cli/)
  assert.match(error.message, /3\.17\.1/)
  assert.equal(spawned, 0, 'must not spawn a build that cannot open the port')
  assert.equal(quit, 0, 'must not destroy the running instance before knowing the port cannot open')
  assert.equal(clock.now(), 0, 'must not burn the launch budget')
})

test('launch: a version below the CDP-refusing threshold still takes the spawn path', async () => {
  let fetchCalls = 0
  const { deps } = makeDeps({
    run: async (file) => (file === 'powershell' ? { stdout: '3.17.1\r\n' } : { stdout: '' }),
    fetch: async () => {
      if (fetchCalls++ === 0) throw new Error('ECONNREFUSED 127.0.0.1:9222')
      return { ok: true, json: async () => ({ Browser: 'ZCode/3.17.1' }) }
    },
  })
  const outcome = await launch({ port: 9222, timeoutMs: 1000 }, deps)
  assert.equal(outcome.launched, true)
  assert.equal(outcome.browser, 'ZCode/3.17.1')
})

test('launch: an unreadable version falls back to the legacy spawn-and-wait path', async () => {
  let fetchCalls = 0
  const { deps } = makeDeps({
    run: async () => {
      throw new Error('powershell unavailable')
    },
    fetch: async () => {
      if (fetchCalls++ === 0) throw new Error('ECONNREFUSED 127.0.0.1:9222')
      return { ok: true, json: async () => ({ Browser: 'ZCode/3.17.1' }) }
    },
  })
  const outcome = await launch({ port: 9222, timeoutMs: 1000 }, deps)
  assert.equal(outcome.launched, true)
})