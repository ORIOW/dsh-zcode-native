/**
 * dsh-zcode-native — the headless CLI backend (host side).
 *
 * ZCode 3.17.2 ships a 15 MB bundled script at
 * `<ZCode.app>/Contents/Resources/glm/zcode.cjs` that can answer a prompt
 * without any window:
 *
 *     node <...>/glm/zcode.cjs -p "只回复 OK" --cwd <workspace> --no-color
 *
 * That is the only automation channel left on macOS, because the packaged app
 * refuses `--remote-debugging-port` (see docs/zcode-native/CLAUDE.md history and
 * README "已知限制"), so CDP is gone and this CLI is the replacement backend.
 *
 * This module owns only the process contract:
 *
 *   discover — locate `zcode.cjs`: an explicit path, then the per-platform
 *              locations next to the installed app. The entry is version-bound,
 *              so a missing one is reported with everything that was searched.
 *   run      — spawn it with `-p <prompt> --cwd <workspace> --no-color`, feed it
 *              the builtin provider config through the environment, and settle
 *              on exit code 0. stdout is the answer; stderr is the diagnostic.
 *
 * Deliberate limits (see docs/zcode-native/CLI-PLAN.md):
 *
 *   - the prompt goes through argv, so it must be self-contained text; there is
 *     no stdin channel and no streaming, the answer arrives when the process exits.
 *   - credentials stay the user's business: this module never writes
 *     `~/.zcode/v2/credentials.json` or `provider_config.json`. If the CLI is not
 *     logged in, the error surfaces as-is (`Select a model before sending a message`).
 *   - one process per run, serialised by the caller (the CLI shares its sqlite
 *     db under ~/.zcode/cli/db), never two at once.
 *
 * Every dependency (spawn/exists/platform/env/now) is injectable so the whole
 * contract is unit-testable without ZCode installed.
 *
 * @module dsh-zcode-native/cli
 */
import { spawn as spawnProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir, platform as osPlatform } from 'node:os'
import { posix as pathPosix, win32 as pathWin32 } from 'node:path'

/** How long one CLI answer may take. The CLI retries internally; 10 minutes matched ask(). */
export const DEFAULT_CLI_TIMEOUT_MS = 600000

/** 模块级队列：共享 `~/.zcode/cli/db`，一次只跑一个 CLI 进程。 */
let queue = Promise.resolve()

/** How much of the CLI's stderr to keep for a failure message. */
const STDERR_LIMIT = 4096

/** Error with a stable machine code (cli-not-found / cli-exit / cli-timeout / cli-aborted). */
export class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CliError'
    this.code = code
  }
}

/** Path helpers for the *target* platform — `node:path.join` follows the host instead. */
function joinFor(platform) {
  return platform === 'win32' ? pathWin32.join : pathPosix.join
}

/**
 * Where the bundled CLI lives for a given install root.
 *
 * darwin: <app>/Contents/Resources/glm/zcode.cjs
 * win32:  <app>/resources/glm/zcode.cjs
 */
function cliInApp(appRoot, platform) {
  if (platform === 'win32') {
    return joinFor(platform)(appRoot, 'resources', 'glm', 'zcode.cjs')
  }
  return joinFor(platform)(appRoot, 'Contents', 'Resources', 'glm', 'zcode.cjs')
}

/** Candidate entry points, most likely first, for the platform under test. */
export function candidateCliEntries(options = {}) {
  const platform = options.platform ?? osPlatform()
  const env = options.env ?? process.env
  const home = options.home ?? homedir()
  const join = joinFor(platform)

  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData', 'Local')
    const programs = env.ProgramFiles ?? 'C:\\Program Files'
    return [
      cliInApp(join(local, 'Programs', 'ZCode'), platform),
      cliInApp(join(local, 'ZCode'), platform),
      cliInApp(join(programs, 'ZCode'), platform),
    ]
  }

  if (platform === 'darwin') {
    return [
      cliInApp('/Applications/ZCode.app', platform),
      cliInApp(join(home, 'Applications', 'ZCode.app'), platform),
    ]
  }

  return [cliInApp('/opt/ZCode', platform), cliInApp('/usr/lib/zcode', platform)]
}

/**
 * The provider config the CLI needs in `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`.
 *
 * It sits beside the entry: <root>/Contents/Resources/config/provider/zcode-builtin.json
 * (win32: <root>/resources/config/provider/zcode-builtin.json).
 */
export function builtinProviderConfigPath(entryPath, platform = osPlatform()) {
  const posixish = platform === 'win32' ? pathWin32 : pathPosix
  const resources = posixish.dirname(posixish.dirname(entryPath))
  return posixish.join(resources, 'config', 'provider', 'zcode-builtin.json')
}

/** Synchronous core of discoverCli — runCliPrompt needs the entry before it may await. */
function resolveEntry(options = {}, deps = {}) {
  const platform = options.platform ?? osPlatform()
  const exists = deps.exists ?? existsSync
  const searched = []

  if (options.entryPath) {
    searched.push(options.entryPath)
    if (exists(options.entryPath)) {
      return { entryPath: options.entryPath, source: 'config', searched, platform }
    }
    throw new CliError(
      'cli-not-found',
      `zcode cli: no zcode.cjs at the configured path (searched: ${searched.join(', ')})`,
    )
  }

  for (const candidate of candidateCliEntries({ ...options, platform })) {
    searched.push(candidate)
    if (exists(candidate)) {
      return { entryPath: candidate, source: 'candidate', searched, platform }
    }
  }

  throw new CliError(
    'cli-not-found',
    `zcode cli: could not find zcode.cjs (searched: ${searched.join(', ')})`,
  )
}

/** Find the bundled CLI without running it. */
/** ANSI 颜色/光标序列。CLI 在 TTY 下会上色，管道模式下通常不上，但别赌。 */
const ANSI_SEQUENCE = /\u001b\[[0-9;?]*[A-Za-z]/g

/**
 * 去掉 ANSI 控制序列与回车符。
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function stripAnsi(raw) {
  return String(raw ?? '').replace(ANSI_SEQUENCE, '')
}

/**
 * stdout → 可投递的答案文本。
 *
 * `-p` 模式下 stdout 就是答案本身：没有 JSON 包装、没有事件流，唯一的加工是
 * 去掉颜色与行尾空白。`empty` 单独标出来，因为「退出码 0 但什么都没打印」是
 * 真实存在的形态（CLI 把结论写进了 stderr），不能当成功答案投给父代理。
 *
 * @param {unknown} raw - 子进程 stdout。
 * @returns {{ text: string, empty: boolean }}
 */
export function parseCliAnswer(raw) {
  const text = stripAnsi(raw).replace(/\r\n/g, '\n').trim()
  return { text, empty: text.length === 0 }
}

export async function discoverCli(options = {}, deps = {}) {
  const resolved = resolveEntry(options, deps)
  return { entryPath: resolved.entryPath, source: resolved.source, searched: resolved.searched }
}

/**
 * 串行化的 CLI 派活入口。
 *
 * 所有 CLI 调用共享 `~/.zcode/cli/db`，并发跑会互相踩（步骤 1 的复核要求单飞）。
 * 队列和 ask() 一样按模块存活：前一次不会因为失败把后面堵死。
 *
 * @param {object} config - 透传给 runCliOnce。
 * @param {string} prompt - 自包含的任务文本。
 * @param {object} [deps] - 透传给 runCliOnce。
 * @returns {Promise<{status:'ok', text:string, exitCode:0, elapsedMs:number}>}
 */
export function runCliPrompt(config, prompt, deps) {
  const run = queue.then(() => runCliOnce(config, prompt, deps))
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
/**
 * Ask ZCode one question through its own CLI.
 *
 * @param {object} config - `{ entryPath?, cwd, timeoutMs?, signal?, platform?, env? }`
 * @param {string} prompt - self-contained text; it travels through argv
 * @param {object} deps - `{ spawn?, exists?, env?, now? }`
 * @returns {Promise<{status:'ok', text:string, exitCode:0, elapsedMs:number}>}
 */
async function runCliOnce(config = {}, prompt, deps = {}) {
  const spawn = deps.spawn ?? spawnProcess
  const exists = deps.exists ?? existsSync
  const now = deps.now ?? (() => Date.now())
  const startedAt = now()

  const text = typeof prompt === 'string' ? prompt.trim() : ''
  if (!text) {
    throw new CliError('cli-empty-prompt', 'zcode cli: the delegated prompt was empty')
  }

  const platform = config.platform ?? osPlatform()
  const { entryPath } = resolveEntry({ ...config, platform }, { exists })

  const cwd = config.cwd ?? process.cwd()
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : DEFAULT_CLI_TIMEOUT_MS

  // The CLI refuses to start without a provider config; it does not look next to
  // itself when invoked through a symlink, so the path is handed over explicitly.
  const env = { ...(deps.env ?? process.env) }
  const builtin = builtinProviderConfigPath(entryPath, platform)
  if (exists(builtin)) {
    env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE = builtin
  }

  const args = [entryPath, '-p', text, '--cwd', cwd, '--no-color']

  return await new Promise((resolve, reject) => {
    let settled = false
    let stderr = ''
    let stdout = ''

    const child = spawn('node', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const kill = () => {
      if (child.killed) return
      try {
        child.kill('SIGTERM')
      } catch {
        /* the process is already gone */
      }
    }

    const finish = (fn) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (config.signal) config.signal.removeEventListener?.('abort', onAbort)
      fn()
    }

    const fail = (code, message) => finish(() => reject(new CliError(code, message)))

    const onAbort = () => {
      kill()
      fail('cli-aborted', 'zcode cli: aborted by the caller')
    }

    const timer = setTimeout(() => {
      kill()
      const tail = stderr.trim()
      fail(
        'cli-timeout',
        `zcode cli: no answer within ${timeoutMs}ms${tail ? ` — the cli said: ${tail}` : ''}`,
      )
    }, timeoutMs)

    if (config.signal) {
      if (config.signal.aborted) {
        onAbort()
        return
      }
      config.signal.addEventListener?.('abort', onAbort, { once: true })
    }

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < STDERR_LIMIT) stderr += String(chunk)
    })

    child.on('error', (error) => {
      fail('cli-spawn', `zcode cli: could not start node (${error?.message ?? error})`)
    })

    child.on('close', (code, signal) => {
      if (settled) return
      if (code === 0) {
        finish(() => resolve({ status: 'ok', text: parseCliAnswer(stdout).text, exitCode: 0, elapsedMs: now() - startedAt }))
        return
      }
      const tail = stderr.trim()
      const how = signal ? `killed by ${signal}` : `exit code ${code}`
      fail('cli-exit', `zcode cli: ${how}${tail ? ` — the cli said: ${tail}` : ''}`)
    })
  })
}