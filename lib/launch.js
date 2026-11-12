/**
 * dsh-zcode-native — find and start the local ZCode app (host side).
 *
 * The plugin drives ZCode over CDP, which only exists when the app was started
 * with `--remote-debugging-port=<port>`. Until now that was the user's job
 * (README: quit ZCode, relaunch it from a terminal with the flag). On Windows
 * that is the whole experience, which is what issue #1 reports.
 *
 * This module closes that gap:
 *
 *   discover — look for the executable: explicit path, then the per-platform
 *              install locations, then PATH (`where ZCode.exe` / `which zcode`),
 *              then a two-level scan of the folders installers actually use
 *              (%LOCALAPPDATA%\Programs, %LOCALAPPDATA%, %ProgramFiles%).
 *   launch   — spawn it detached with `--remote-debugging-port=<port>`, then
 *              poll http://127.0.0.1:<port>/json/version until it answers.
 *   version  — packaged builds from 3.17.2 refuse `--remote-debugging-port`
 *              before any window appears (measured 3.17.2 macOS / 3.18.0
 *              Windows, 2026-11-12), so launch() reads the installed version
 *              first and fails fast with `version-no-cdp` instead of burning
 *              the launch budget — and a destructive quit — on a build that
 *              cannot open the port.
 *   restart  — an already-running ZCode that has no debug port CANNOT be fixed
 *              by starting a second copy (Electron single-instance focuses the
 *              first one and exits), so the tool has to quit it first. That is
 *              destructive, hence opt-in via `restart: true`.
 *
 * Everything takes injectable deps (platform/env/exists/run/spawn/probe/sleep/
 * now) so the whole decision tree is unit-testable without ZCode installed.
 *
 * @module dsh-zcode-native/launch
 */
import { execFile, spawn as spawnProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir, platform as osPlatform } from 'node:os'
import { posix as pathPosix, win32 as pathWin32 } from 'node:path'

/** Tool name exposed to the model — "start ZCode from the session". */
export const ZCODE_LAUNCH_TOOL_NAME = 'zcode_launch'

/** How long the app may take to open its CDP endpoint (cold start on Windows: ~10s). */
export const DEFAULT_LAUNCH_TIMEOUT_MS = 30000

/**
 * Minimum packaged ZCode version that refuses `--remote-debugging-port` before
 * any window appears. Measured state as of 2026-11-12: 3.17.2 macOS (process
 * comes up, port never does) and 3.18.0 Windows (process exits immediately,
 * stderr "bad option: --remote-debugging-port=9222"). If a future ZCode
 * restores the switch for a newer version, lower or remove this gate.
 */
export const CDP_REFUSING_MIN_VERSION = '3.17.2'

/** Poll interval while waiting for the port. */
const POLL_MS = 300

/** Per-probe timeout; a dead port refuses instantly, a wedged app should not block. */
const PROBE_TIMEOUT_MS = 2000

/** How long a polite quit gets before SIGKILL, and the force phase itself. */
const QUIT_GRACE_MS = 8000
const KILL_GRACE_MS = 3000
/** How much of the app's stderr to keep for a failure message. */
const STDERR_LIMIT = 4096

/** Error with a stable machine code (executable-not-found / already-running-... / launch-timeout). */
export class LaunchError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LaunchError'
    this.code = code
  }
}

/**
 * A plain sleep. Deliberately NOT unref'd: the poll loop is awaited by the
 * caller, and an unref'd timer lets node exit underneath it (observed as
 * "unsettled top-level await", exit 13) when nothing else holds the loop open.
 */
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Path joining for the TARGET platform, not the host one: the Windows candidate
 * list must use backslashes even when it is computed on macOS (tests do exactly
 * that), and `node:path.join` follows the host.
 */
function joinFor(platform) {
  return platform === 'win32' ? pathWin32.join : pathPosix.join
}

/**
 * Candidate executable paths for one platform, most likely first.
 *
 * Pure: takes the environment as data so tests can assert the Windows list on
 * macOS. Windows covers electron-builder (`%LOCALAPPDATA%\Programs\ZCode`) and
 * the older per-user install (`%LOCALAPPDATA%\ZCode`), plus machine-wide.
 *
 * @param {{ platform?: string, env?: Record<string, string|undefined>, home?: string }} [options]
 * @returns {string[]}
 */
export function candidateExecutables(options = {}) {
  const platform = options.platform ?? osPlatform()
  const env = options.env ?? process.env
  const home = options.home ?? homedir()

  const join = joinFor(platform)

  if (platform === 'darwin') {
    return [
      '/Applications/ZCode.app/Contents/MacOS/ZCode',
      join(home, 'Applications/ZCode.app/Contents/MacOS/ZCode'),
    ]
  }

  if (platform === 'win32') {
    const roots = []
    const local = env.LOCALAPPDATA
    const roaming = env.APPDATA
    if (local) {
      roots.push(join(local, 'Programs', 'ZCode'), join(local, 'ZCode'), join(local, 'Programs', 'zcode'))
    }
    if (roaming) roots.push(join(roaming, 'ZCode'))
    if (env.ProgramFiles) roots.push(join(env.ProgramFiles, 'ZCode'))
    if (env['ProgramFiles(x86)']) roots.push(join(env['ProgramFiles(x86)'], 'ZCode'))
    return roots.map((root) => join(root, 'ZCode.exe'))
  }

  return [
    '/opt/ZCode/zcode',
    '/usr/bin/zcode',
    '/usr/local/bin/zcode',
    join(home, '.local', 'bin', 'zcode'),
  ]
}

/** execFile as a promise; rejects on non-zero exit. */
function runCommand(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 5000, windowsHide: true, ...options }, (error, stdout, stderr) => {
      if (error) reject(error)
      else resolve({ stdout, stderr })
    })
  })
}

/**
 * PATH lookup: `where ZCode.exe` on Windows, `which zcode` elsewhere.
 * Returns the first hit that actually exists on disk, else null.
 */
async function lookupOnPath(deps) {
  const platform = deps.platform ?? osPlatform()
  const run = deps.run ?? runCommand
  const exists = deps.exists ?? ((path) => existsSync(path))
  const file = platform === 'win32' ? 'where' : 'which'
  const args = platform === 'win32' ? ['ZCode.exe'] : ['zcode']
  try {
    const { stdout } = await run(file, args, {})
    const hit = String(stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && exists(line))
    return hit ?? null
  } catch {
    return null
  }
}

/**
 * Two-level scan of the folders Windows installers use, for builds whose
 * executable is not at the exact path the candidate list predicts
 * (e.g. `%LOCALAPPDATA%\Programs\ZCode\app-3.17.1\ZCode.exe`).
 */
async function scanWindowsInstalls(deps) {
  const platform = deps.platform ?? osPlatform()
  const env = deps.env ?? process.env
  const join = joinFor(platform)
  const listDir = deps.listDir ?? ((dir) => readdir(dir, { withFileTypes: true }))
  const exists = deps.exists ?? ((path) => existsSync(path))
  const roots = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'),
    env.LOCALAPPDATA,
    env.ProgramFiles,
    env['ProgramFiles(x86)'],
  ].filter(Boolean)

  for (const root of roots) {
    let entries
    try {
      entries = await listDir(root)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (typeof entry?.isDirectory === 'function' ? !entry.isDirectory() : entry?.isDirectory !== true) continue
      if (!/zcode/i.test(String(entry.name))) continue
      const direct = join(root, entry.name, 'ZCode.exe')
      if (await exists(direct)) return direct
      let inner
      try {
        inner = await listDir(join(root, entry.name))
      } catch {
        continue
      }
      for (const child of inner) {
        if (typeof child?.isDirectory === 'function' ? !child.isDirectory() : child?.isDirectory !== true) continue
        if (!/^(app-)?/i.test(String(child.name))) continue
        const nested = join(root, entry.name, child.name, 'ZCode.exe')
        if (await exists(nested)) return nested
      }
    }
  }
  return null
}

/**
 * Find the ZCode executable without starting anything.
 *
 * @param {{ executablePath?: string }} [options] explicit path wins and must exist.
 * @param {{ platform?: string, env?: object, home?: string, exists?: Function,
 *           listDir?: Function, run?: Function }} [deps]
 * @returns {Promise<{ executablePath: string|null, searched: string[], source: string|null }>}
 * @throws {LaunchError} `executable-not-found` when the explicit path is missing.
 */
export async function discoverExecutable(options = {}, deps = {}) {
  const platform = deps.platform ?? osPlatform()
  const env = deps.env ?? process.env
  const home = deps.home ?? homedir()
  const exists = deps.exists ?? ((path) => existsSync(path))

  const explicit = typeof options.executablePath === 'string' && options.executablePath.length > 0
    ? options.executablePath
    : null
  if (explicit) {
    if (await exists(explicit)) return { executablePath: explicit, searched: [explicit], source: 'explicit' }
    throw new LaunchError('executable-not-found', `the executablePath given does not exist: ${explicit}`)
  }

  const candidates = candidateExecutables({ platform, env, home })
  for (const candidate of candidates) {
    if (await exists(candidate)) return { executablePath: candidate, searched: candidates, source: 'candidate' }
  }

  const searched = [...candidates]
  const lookupLabel = platform === 'win32' ? 'where ZCode.exe' : 'which zcode'
  searched.push(lookupLabel)
  const onPath = await lookupOnPath({ ...deps, platform, exists })
  if (onPath) return { executablePath: onPath, searched, source: 'path' }

  if (platform === 'win32') {
    searched.push('%LOCALAPPDATA%\\Programs\\*\\ZCode.exe (two-level scan)')
    const scanned = await scanWindowsInstalls({ ...deps, platform, env, exists })
    if (scanned) return { executablePath: scanned, searched, source: 'scan' }
  }

  return { executablePath: null, searched, source: null }
}

/**
 * One read-only question: does CDP answer on this port, and which build?
 * Never throws — a dead port is the expected case, not an exception.
 *
 * @param {number} port
 * @param {{ fetch?: Function, probeTimeoutMs?: number }} [deps]
 * @returns {Promise<{ reachable: boolean, browser?: string|null, webSocketDebuggerUrl?: string|null, reason?: string }>}
 */
export async function probeDebugPort(port, deps = {}) {
  const fetchImpl = deps.fetch ?? fetch
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`, {
      signal: AbortSignal.timeout(deps.probeTimeoutMs ?? PROBE_TIMEOUT_MS),
    })
    if (!response.ok) return { reachable: false, reason: `HTTP ${response.status}` }
    const info = await response.json()
    return {
      reachable: true,
      browser: typeof info?.Browser === 'string' ? info.Browser : null,
      webSocketDebuggerUrl: typeof info?.webSocketDebuggerUrl === 'string' ? info.webSocketDebuggerUrl : null,
    }
  } catch (error) {
    return { reachable: false, reason: error?.message ?? String(error) }
  }
}

/**
 * Compare dotted version strings segment by segment: missing segments count as
 * 0 (so "3.17" equals "3.17.0"), non-numeric segments as 0. Returns -1, 0, 1.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
export function compareVersions(a, b) {
  const segments = (value) => String(value ?? '')
    .split('.')
    .map((part) => {
      const n = Number.parseInt(part, 10)
      return Number.isInteger(n) && n >= 0 ? n : 0
    })
  const left = segments(a)
  const right = segments(b)
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i += 1) {
    const x = left[i] ?? 0
    const y = right[i] ?? 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** True when `version` is the same as or newer than `minimum`. */
export function versionAtLeast(version, minimum) {
  return compareVersions(version, minimum) >= 0
}

/**
 * Read the installed ZCode version WITHOUT starting the app.
 *
 * Windows reads the PE version resource via PowerShell (FileVersion, e.g.
 * "3.18.0.10300"); macOS reads CFBundleShortVersionString from the bundle's
 * Info.plist; Linux asks the binary for `--version`. Read-only and fail-safe:
 * any failure — missing powershell/defaults, unreadable resource, no version
 * string in the output — yields null, and launch() keeps the legacy
 * spawn-and-wait behavior.
 *
 * @param {string} executablePath
 * @param {{ platform?: string, run?: Function }} [deps]
 * @returns {Promise<string|null>}
 */
export async function probeAppVersion(executablePath, deps = {}) {
  const platform = deps.platform ?? osPlatform()
  const run = deps.run ?? runCommand
  const join = joinFor(platform)
  let stdout
  try {
    if (platform === 'win32') {
      // The path goes INSIDE the -Command string: PowerShell concatenates any
      // trailing arguments into the command text (it does not fill $args), so
      // passing the path as a separate argument is a parser error. Single
      // quotes are PowerShell's string delimiter; '' is their escape.
      const quoted = `'${String(executablePath).replace(/'/g, "''")}'`
      ;({ stdout } = await run(
        'powershell',
        ['-NoProfile', '-Command', `(Get-Item -LiteralPath ${quoted}).VersionInfo.FileVersion`],
        {},
      ))
    } else if (platform === 'darwin') {
      const plist = join(executablePath, '..', '..', 'Info.plist')
      ;({ stdout } = await run('defaults', ['read', plist, 'CFBundleShortVersionString'], {}))
    } else {
      ;({ stdout } = await run(executablePath, ['--version'], {}))
    }
  } catch {
    return null
  }
  const output = String(stdout ?? '')
  // The linux `--version` output is not contractually pinned, so prefer the
  // first line that actually says "version": an earlier dotted number (a
  // date, a build id) must not be mistaken for the app version. Bare
  // version output (the win32/darwin case) has no such line and falls back
  // to the first match, which is the whole output there.
  let match = null
  for (const line of output.split(/\r?\n/)) {
    if (!/version/i.test(line)) continue
    match = line.match(/\d+(?:\.\d+)+/)
    if (match) break
  }
  if (!match) match = output.match(/\d+(?:\.\d+)+/)
  return match ? match[0] : null
}

/**
 * Which ZCode processes are running? Used only to decide whether a launch can
 * work and whether `restart` has something to quit.
 *
 * @param {{ platform?: string, run?: Function }} [deps]
 * @returns {Promise<Array<{ pid: number|null, command?: string, name?: string }>>}
 */
export async function listRunning(deps = {}) {
  const platform = deps.platform ?? osPlatform()
  const run = deps.run ?? runCommand
  try {
    if (platform === 'win32') {
      const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq ZCode.exe', '/FO', 'CSV', '/NH'], {})
      return String(stdout ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /^"ZCode\.exe"/i.test(line))
        .map((line) => {
          const cells = line.split('","').map((cell) => cell.replace(/^"|"$/g, ''))
          const pid = Number.parseInt(cells[1], 10)
          return { pid: Number.isInteger(pid) ? pid : null, name: 'ZCode.exe' }
        })
    }
    const pattern = platform === 'darwin' ? 'ZCode' : 'zcode'
    const { stdout } = await run('pgrep', ['-fl', pattern], {})
    return String(stdout ?? '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => {
        const space = line.indexOf(' ')
        const pid = Number.parseInt(space === -1 ? line : line.slice(0, space), 10)
        return { pid: Number.isInteger(pid) ? pid : null, command: space === -1 ? '' : line.slice(space + 1) }
      })
      .filter((entry) => {
        if (entry.command === '') return true
        if (platform !== 'darwin') return /zcode/i.test(entry.command)
        // macOS argv[0] is often the bare "ZCode" (Electron rewrites it), so accept
        // both that and the full bundle path — but never a Helper, a crashpad
        // handler or the zcode-cli sidecar.
        if (/Helper|Frameworks|crashpad/i.test(entry.command)) return false
        if (/^ZCode(\s|$)/.test(entry.command)) return true
        return /\/ZCode\.app\/Contents\/MacOS\/ZCode(\s|$)/.test(entry.command)
      })
  } catch {
    return []
  }
}

/** Wait until `list()` reports nothing, or the grace period runs out. */
async function waitForExit(list, deadlineMs, deps) {
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? (() => Date.now())
  const deadline = now() + deadlineMs
  while (now() < deadline) {
    if ((await list()).length === 0) return true
    await sleep(POLL_MS)
  }
  return (await list()).length === 0
}

/**
 * Quit a running ZCode. Polite first (macOS `quit`, SIGTERM elsewhere), then
 * forceful. Windows uses taskkill /T /F straight away: an Electron app that
 * ignores WM_CLOSE would otherwise keep the single-instance lock and the
 * relaunch would silently focus it again.
 *
 * @param {Array<{ pid: number|null }>} processes
 * @param {{ platform?: string, run?: Function, sleep?: Function, now?: Function,
 *           listRunning?: Function }} [deps]
 */
export async function quitRunning(processes, deps = {}) {
  const platform = deps.platform ?? osPlatform()
  const run = deps.run ?? runCommand
  const list = deps.listRunning ?? (() => listRunning(deps))
  const pids = processes.map((process) => process?.pid).filter((pid) => Number.isInteger(pid))

  if (platform === 'win32') {
    for (const pid of pids) {
      try {
        await run('taskkill', ['/PID', String(pid), '/T', '/F'], {})
      } catch {
        /* already gone */
      }
    }
  } else if (platform === 'darwin') {
    try {
      await run('osascript', ['-e', 'tell application "ZCode" to quit'], {})
    } catch {
      /* not scriptable: fall through to signals */
    }
    if (!(await waitForExit(list, QUIT_GRACE_MS, deps))) {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGTERM')
        } catch {
          /* already gone */
        }
      }
      await waitForExit(list, KILL_GRACE_MS, deps)
    }
  } else {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* already gone */
      }
    }
    await waitForExit(list, QUIT_GRACE_MS, deps)
  }

  // Whatever survived the polite phase goes now.
  const survivors = await list()
  for (const entry of survivors) {
    if (!Number.isInteger(entry?.pid)) continue
    try {
      process.kill(entry.pid, 'SIGKILL')
    } catch {
      /* already gone */
    }
  }
  if (survivors.length > 0) await waitForExit(list, KILL_GRACE_MS, deps)
}

/**
 * Spawn the app detached so it outlives this host process.
 *
 * The binary is spawned directly on every platform, including macOS. `open -a …
 * --args --remote-debugging-port=…` was measured on ZCode 3.17.2 to come up with
 * the switch dropped (no CDP listener), and it also yields no pid to report —
 * a direct binary spawn passes argv verbatim and gives the caller a real handle.
 */
function spawnDetached(executablePath, args, deps = {}) {
  const spawnImpl = deps.spawn ?? spawnProcess
  const child = spawnImpl(executablePath, args, {
    detached: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  })
  child?.unref?.()
  // A packaged app that refuses the switch says so on stderr ("bad option: ...").
  // Keep the tail so the failure names the reason instead of just timing out.
  const collector = collectStderr(child?.stderr)
  return { pid: Number.isInteger(child?.pid) ? child.pid : null, via: 'spawn', stderrTail: collector }
}

/** Keep at most STDERR_LIMIT characters of a child's stderr; never throw. */
function collectStderr(stream, limit = STDERR_LIMIT) {
  let text = ''
  try {
    stream?.setEncoding?.('utf8')
    stream?.on?.('data', (chunk) => {
      if (text.length < limit) text += String(chunk).slice(0, limit - text.length)
    })
    stream?.on?.('error', () => {})
  } catch {
    // A fake stream without the EventEmitter surface is fine: no tail to report.
  }
  return () => text.trim()
}

/**
 * Make ZCode reachable over CDP, starting it when needed.
 *
 * @param {{ port?: number, executablePath?: string, restart?: boolean, timeoutMs?: number }} [options]
 * @param {{ platform?: string, env?: object, home?: string, exists?: Function, listDir?: Function,
 *           run?: Function, spawn?: Function, fetch?: Function, sleep?: Function, now?: Function,
 *           probe?: Function, discover?: Function, listRunning?: Function, quit?: Function }} [deps]
 * @returns {Promise<{ launched: boolean, alreadyRunning: boolean, restarted: boolean, port: number,
 *   executablePath: string|null, pid: number|null, browser: string|null, elapsedMs?: number }>}
 * @throws {LaunchError} bad-port / already-running-without-debug-port /
 *   executable-not-found / version-no-cdp / launch-timeout
 */
export async function launch(options = {}, deps = {}) {
  const port = options.port ?? 9222
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LaunchError('bad-port', `invalid CDP port ${JSON.stringify(port)}`)
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS
  const restart = options.restart === true
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? (() => Date.now())
  const probe = deps.probe ?? ((target) => probeDebugPort(target, deps))
  const list = deps.listRunning ?? (() => listRunning(deps))

  const already = await probe(port)
  if (already.reachable) {
    return {
      launched: false,
      alreadyRunning: true,
      restarted: false,
      port,
      executablePath: null,
      pid: null,
      browser: already.browser ?? null,
    }
  }

  const running = await list()
  if (running.length > 0 && !restart) {
    const pids = running.map((entry) => entry?.pid).filter((pid) => Number.isInteger(pid)).join(', ')
    throw new LaunchError(
      'already-running-without-debug-port',
      `ZCode is already running (pid ${pids || '?'}) but nothing answers on 127.0.0.1:${port} — it was started without `
      + '--remote-debugging-port, and Electron focuses the existing instance instead of opening the port. '
      + 'Quit ZCode and try again, or pass restart:true to quit and relaunch it (unsaved work in ZCode is lost). '
      + 'If this ZCode is 3.17.2 or newer, restarting will not open the port either (version-no-cdp): '
      + 'use the CLI backend (subagent_zcode_cli) or roll the app back to 3.17.1.',
    )
  }

  const discovery = await (deps.discover ?? ((opts) => discoverExecutable(opts, deps)))({
    executablePath: options.executablePath,
  })
  if (!discovery?.executablePath) {
    throw new LaunchError(
      'executable-not-found',
      'could not find the ZCode executable. Looked at: '
      + `${(discovery?.searched ?? []).join(' | ') || 'nothing'}. `
      + 'Pass executablePath — for example C:\\Program Files\\ZCode\\ZCode.exe.',
    )
  }

  // Packaged builds from CDP_REFUSING_MIN_VERSION refuse the debug-port switch
  // before any window appears, so no launch strategy can open CDP for them.
  // Fail fast — BEFORE the destructive quit and the full poll budget — and
  // point at the backend that works for that version. An unreadable version
  // (null) keeps the legacy spawn-and-wait behavior.
  const version = await probeAppVersion(discovery.executablePath, deps)
  if (version && versionAtLeast(version, CDP_REFUSING_MIN_VERSION)) {
    throw new LaunchError(
      'version-no-cdp',
      `ZCode ${version} at ${discovery.executablePath} is a packaged build that refuses `
      + `--remote-debugging-port (measured on 3.17.2 macOS and 3.18.0 Windows, 2026-11-12): the port never `
      + 'opens for this version, no matter how the app is started. Use the CLI backend (subagent_zcode_cli) '
      + 'if this ZCode install is logged in, or roll the app back to ZCode 3.17.1 for CDP.',
    )
  }

  let restarted = false
  if (running.length > 0) {
    const quit = deps.quit ?? ((processes) => quitRunning(processes, deps))
    await quit(running)
    restarted = true
  }

  const child = spawnDetached(discovery.executablePath, [`--remote-debugging-port=${port}`], deps)
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  let lastReason = 'the port never answered'
  while (now() < deadline) {
    await sleep(POLL_MS)
    const current = await probe(port)
    if (current.reachable) {
      return {
        launched: true,
        alreadyRunning: false,
        restarted,
        port,
        executablePath: discovery.executablePath,
        pid: child?.pid ?? null,
        browser: current.browser ?? null,
        elapsedMs: now() - startedAt,
      }
    }
    lastReason = current.reason ?? lastReason
  }

  const said = child?.stderrTail?.() ?? ''
  const hint = said ? ` The app said: ${said}` : ''
  throw new LaunchError(
    'launch-timeout',
    `started ${discovery.executablePath} (pid ${child?.pid ?? '?'}) but CDP never answered on `
    + `127.0.0.1:${port} within ${timeoutMs}ms (${lastReason}). The app may have refused the switch or a `
    + `different instance took over; check that ZCode was fully quit before the launch.${hint}`,
  )
}