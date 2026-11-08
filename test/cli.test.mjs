/**
 * Unit tests for lib/cli.js — the headless backend that runs ZCode's own CLI.
 *
 * The CLI is a 15 MB bundled script at <app>/Contents/Resources/glm/zcode.cjs;
 * the plugin spawns it with `-p` and reads stdout. Everything here is faked:
 * spawn / exists / platform / env are injected, so nothing runs a real process.
 *
 * Run: node --test test/cli.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CliError, candidateCliEntries, discoverCli, parseCliAnswer, runCliPrompt, stripAnsi } from '../lib/cli.js'

const MAC_ENTRY = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'
const MAC_BUILTIN = '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json'

/**
 * A child process stand-in: emits stdout/stderr data then a close code.
 * The behaviour is decided by the test, so each case states only what matters.
 */
function fakeSpawn(behave) {
  const calls = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.killed = null
    child.kill = (signal) => {
      child.killed = signal
      return true
    }
    calls.push({ command, args, options, child })
    queueMicrotask(() => behave(child, { command, args, options }))
    return child
  }
  return { spawn, calls }
}

/** Answers "does this path exist" from a literal set. */
function fakeExists(paths) {
  const set = new Set(paths)
  return (path) => set.has(path)
}

test('cli: the entry next to the macOS app bundle is found without any config', async () => {
  const found = await discoverCli(
    { platform: 'darwin' },
    { exists: fakeExists([MAC_ENTRY]), env: {}, home: '/Users/me' },
  )
  assert.equal(found.entryPath, MAC_ENTRY)
  assert.equal(found.source, 'candidate')
})

test('cli: an explicit entry wins, and a wrong one fails with cli-not-found', async () => {
  const hit = await discoverCli(
    { platform: 'darwin', entryPath: '/opt/zcode/zcode.cjs' },
    { exists: fakeExists(['/opt/zcode/zcode.cjs']), env: {}, home: '/Users/me' },
  )
  assert.equal(hit.entryPath, '/opt/zcode/zcode.cjs')
  assert.equal(hit.source, 'config')

  await assert.rejects(
    () =>
      discoverCli(
        { platform: 'darwin', entryPath: '/opt/zcode/zcode.cjs' },
        { exists: fakeExists([MAC_ENTRY]), env: {}, home: '/Users/me' },
      ),
    (error) => error instanceof CliError && error.code === 'cli-not-found',
  )
})

test('cli: a clean run resolves with the trimmed stdout', async () => {
  const { spawn, calls } = fakeSpawn((child) => {
    child.stdout.emit('data', 'OK\n')
    child.emit('close', 0)
  })

  const outcome = await runCliPrompt(
    { entryPath: MAC_ENTRY, cwd: '/tmp/work', timeoutMs: 5000 },
    '只回复 OK',
    { spawn, exists: fakeExists([MAC_ENTRY, MAC_BUILTIN]), env: { PATH: '/usr/bin' }, now: () => 0 },
  )

  assert.equal(outcome.status, 'ok')
  assert.equal(outcome.text, 'OK')

  const [{ command, args, options }] = calls
  assert.equal(command, 'node')
  assert.deepEqual(args, [
    MAC_ENTRY,
    '-p',
    '只回复 OK',
    '--cwd',
    '/tmp/work',
    '--no-color',
  ])
  assert.equal(options.cwd, '/tmp/work')
  assert.equal(options.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, MAC_BUILTIN)
})

test('cli: a nonzero exit is a cli-exit error carrying the stderr tail', async () => {
  const { spawn } = fakeSpawn((child) => {
    child.stderr.emit('data', 'ProviderBusinessError: [1113] 余额不足\n')
    child.emit('close', 1)
  })

  await assert.rejects(
    () =>
      runCliPrompt(
        { entryPath: MAC_ENTRY, cwd: '/tmp/work', timeoutMs: 5000 },
        'hi',
        { spawn, exists: fakeExists([MAC_ENTRY]), env: {}, now: () => 0 },
      ),
    (error) => {
      assert.equal(error.code, 'cli-exit')
      assert.match(error.message, /\[1113\]/)
      assert.match(error.message, /exit code 1/)
      return true
    },
  )
})

test('cli: a run that never exits is killed and reported as cli-timeout', async () => {
  const { spawn, calls } = fakeSpawn(() => {
    /* never emits close */
  })

  await assert.rejects(
    () =>
      runCliPrompt(
        { entryPath: MAC_ENTRY, cwd: '/tmp/work', timeoutMs: 40 },
        'hi',
        { spawn, exists: fakeExists([MAC_ENTRY]), env: {}, now: () => 0 },
      ),
    (error) => {
      assert.equal(error.code, 'cli-timeout')
      assert.match(error.message, /40000ms|40ms/)
      return true
    },
  )
  assert.equal(calls[0].child.killed, 'SIGTERM')
})

test('cli: an abort kills the child and resolves as cli-aborted', async () => {
  const controller = new AbortController()
  const { spawn, calls } = fakeSpawn(() => {
    /* still running when the caller aborts */
  })

  const pending = runCliPrompt(
    { entryPath: MAC_ENTRY, cwd: '/tmp/work', timeoutMs: 5000, signal: controller.signal },
    'hi',
    { spawn, exists: fakeExists([MAC_ENTRY]), env: {}, now: () => 0 },
  )
  controller.abort()

  await assert.rejects(pending, (error) => {
    assert.equal(error.code, 'cli-aborted')
    return true
  })
  assert.equal(calls[0].child.killed, 'SIGTERM')
})

test('cli: candidate entries cover both bundle roots and stay absolute', () => {
  const mac = candidateCliEntries({ platform: 'darwin', env: {}, home: '/Users/me' })
  assert.ok(mac.includes(MAC_ENTRY))
  assert.ok(mac.includes('/Users/me/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'))

  const win = candidateCliEntries({
    platform: 'win32',
    env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
    home: 'C:\\Users\\me',
  })
  for (const entry of win) {
    assert.ok(entry.endsWith('zcode.cjs'), entry)
    assert.ok(/^[A-Z]:\\/.test(entry), entry)
  }
  assert.ok(
    win.some((entry) => entry === 'C:\\Users\\me\\AppData\\Local\\Programs\\ZCode\\resources\\glm\\zcode.cjs'),
    win.join('\n'),
  )
})

test('parse: colour sequences and carriage returns never reach the parent agent', () => {
  assert.equal(stripAnsi('\u001b[32mOK\u001b[0m'), 'OK')
  assert.deepEqual(parseCliAnswer('\u001b[1;32mOK\u001b[0m\r\n'), { text: 'OK', empty: false })
})

test('parse: surrounding blank lines collapse, inner ones survive', () => {
  assert.deepEqual(parseCliAnswer('\n\n  first  \n\nsecond\n\n'), { text: 'first  \n\nsecond', empty: false })
})

test('parse: exit code 0 with nothing on stdout is flagged, not silently accepted', () => {
  assert.deepEqual(parseCliAnswer('\u001b[0m  \r\n\n'), { text: '', empty: true })
})
