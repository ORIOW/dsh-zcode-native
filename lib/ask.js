/**
 * dsh-zcode-native — ask state machine (host side).
 *
 * Drives the ZCode GUI composer over CDP: clear → type → verify → send → wait
 * for the new turn → read the answer. Every step below is measured behaviour of
 * the ZCode renderer, not invention:
 *
 *   1. pre-check   — busy (`停止生成`/`工作中` button present) → `busy`, never
 *                    preempt; remember the turn count `before`.
 *   2. clear       — execCommand does NOT clear the contenteditable (measured);
 *                    Cmd+A / Backspace must go through Input.dispatchKeyEvent
 *                    (macOS modifiers=4, others Ctrl=2), then assert the
 *                    composer is empty or fail `clear-failed` — residue would
 *                    concatenate into a dirty prompt.
 *   3. type+verify — Input.insertText, then read back and require EXACT
 *                    equality with the prompt, else `verify-failed`. Never send
 *                    an unverified prompt.
 *   4. send        — click the button whose innerText.trim() === '发送', then
 *                    poll up to 20s for the turn count to pass `before`;
 *                    otherwise `no-new-turn` — no new turn means nothing was
 *                    sent, so the "last turn" must not be read.
 *   5. read        — sample turns[before] BY INDEX (not the last turn), taking
 *                    the LAST `[class~="group/assistant-row"]` inside it
 *                    (`class~=` exact-token match: `class*=` also hits
 *                    `group-hover/assistant-turn:opacity-100`). Done when the
 *                    stop button has appeared and disappeared and the text is
 *                    unchanged across 2 samples 1000ms apart. On timeout return
 *                    { status:'timeout', partialText } and NEVER resend.
 *   6. release     — abort or timeout first clicks `停止生成` and waits (bounded,
 *                    best effort) for the button to disappear. Measured
 *                    2026-11-01: settling the caller alone left ZCode generating
 *                    for minutes and wedged every later ask on `busy`.
 *
 * All asks are serialized through a module-level queue: ZCode has ONE composer,
 * so a second caller waits instead of racing.
 *
 * @module dsh-zcode-native/ask
 */
import { attach } from './cdp.js'

/** Error with a stable machine code (busy / clear-failed / verify-failed / ...). */
export class AskError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AskError'
    this.code = code
  }
}

const BUSY_LABELS = ['停止生成', '工作中']
/** Button labels that cancel the running generation (`停止` is the short form). */
const STOP_LABELS = ['停止生成', '停止']
/** How long a cancel may spend convincing ZCode to stop before giving up. */
const STOP_BUDGET_MS = 4000
/** Poll interval while waiting for the stop button to disappear. */
const STOP_POLL_MS = 250
const SELECTOR_COMPOSER = '[contenteditable="true"]'
const TOKEN_TURN = 'group/assistant-turn'
const TOKEN_ROW = 'group/assistant-row'

/** Busy check used by both the pre-check and the samples. */
const busyOf = `Array.from(document.querySelectorAll('button')).map((button) => (button.innerText || '').trim())`

// The page-side expressions. Exported so tests can dispatch the fake CDP on
// identity instead of scraping expression text.
export const expr = {
  /** { busy, hasComposer, turns } — the pre-flight probe. */
  probe: `(() => {
  const texts = ${busyOf}
  const composer = document.querySelector('${SELECTOR_COMPOSER}')
  return {
    busy: texts.includes('${BUSY_LABELS[0]}') || texts.includes('${BUSY_LABELS[1]}'),
    hasComposer: !!composer,
    turns: document.querySelectorAll('[class~="${TOKEN_TURN}"]').length,
  }
})()`,
  /** Focus the composer; false when there is none. */
  focus: `(() => {
  const composer = document.querySelector('${SELECTOR_COMPOSER}')
  if (!composer) return false
  composer.focus()
  return true
})()`,
  /** Current composer text, trimmed; null without a composer. */
  composerText: `(() => {
  const composer = document.querySelector('${SELECTOR_COMPOSER}')
  return composer ? composer.innerText.trim() : null
})()`,
  /** Click the 发送 button; false when there is none. */
  clickSend: `(() => {
  const button = Array.from(document.querySelectorAll('button')).find((button) => (button.innerText || '').trim() === '发送')
  if (!button) return false
  button.click()
  return true
})()`,
  /** Turn count only. */
  turnCount: `document.querySelectorAll('[class~="${TOKEN_TURN}"]').length`,
  /** Click the cancel button; false when nothing is generating. */
  clickStop: `(() => {
  const button = Array.from(document.querySelectorAll('button')).find((button) => /^(${STOP_LABELS.join('|')})$/.test((button.innerText || '').trim()))
  if (!button) return false
  button.click()
  return true
})()`,
  /** Is ZCode still generating right now? */
  isBusy: `(() => {
  const texts = ${busyOf}
  return texts.includes('${BUSY_LABELS[0]}') || texts.includes('${BUSY_LABELS[1]}')
})()`,
  /**
   * Sample OUR turn by index — never the last one — returning
   * { present, text, busy } where text is the LAST assistant-row inside it.
   */
  sample: (index) => `(() => {
  const turns = document.querySelectorAll('[class~="${TOKEN_TURN}"]')
  const turn = turns[${index}]
  if (!turn) return { present: false }
  const rows = turn.querySelectorAll('[class~="${TOKEN_ROW}"]')
  const row = rows.length > 0 ? rows[rows.length - 1] : null
  const texts = ${busyOf}
  return {
    present: true,
    text: row ? row.innerText.trim() : '',
    busy: texts.includes('${BUSY_LABELS[0]}') || texts.includes('${BUSY_LABELS[1]}'),
  }
})()`,
}

const SELECT_ALL_KEY = { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 }
const BACKSPACE_KEY = { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 }
/** CDP modifiers: Alt=1, Ctrl=2, Meta/Command=4 (macOS uses Cmd+A). */
const selectModifiers = () => (process.platform === 'darwin' ? 4 : 2)

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * One CDP call must never hang forever. A detached renderer target can swallow a
 * Runtime.evaluate and never answer, and the read loop's own deadline check
 * never runs while it is awaiting — measured: a dispatch sat 13+ minutes past a
 * finished generation. Racing every evaluate against a timer turns that silent
 * hang into `cdp-timeout`.
 */
async function evaluateWithTimeout(cdp, expression, timeoutMs) {
  let timer
  try {
    return await Promise.race([
      cdp.evaluate(expression),
      new Promise((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new AskError('cdp-timeout', `CDP evaluate got no answer within ${timeoutMs}ms — the debug target may be detached`)),
          timeoutMs,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Stop ZCode's in-flight generation after ask() gives up on it.
 *
 * Measured 2026-11-01: settling the caller alone leaves ZCode generating. After
 * `provider.dispose()` returned `stopReason:'aborted'` in 299ms, the 停止生成
 * button stayed present for the whole 10s observation window, and the abandoned
 * turn was still streaming 4 minutes later (and every later ask() would then
 * fail the `busy` pre-check forever). Cancel must release the app, not just the
 * caller.
 *
 * Best effort by contract: a cancel must never reject or outlive its budget, so
 * every failure here is swallowed and reported as `false`.
 *
 * @returns {Promise<boolean>} true only when the stop button was clicked AND the
 *   generation visibly ended within [STOP_BUDGET_MS].
 */
async function stopGeneration(cdp, evaluateTimeoutMs, { sleep, now }) {
  const wait = sleep ?? defaultSleep
  const clock = now ?? (() => Date.now())
  const deadline = clock() + STOP_BUDGET_MS
  try {
    if ((await evaluateWithTimeout(cdp, expr.clickStop, evaluateTimeoutMs)) !== true) return false
    while (clock() < deadline) {
      await wait(STOP_POLL_MS)
      if ((await evaluateWithTimeout(cdp, expr.isBusy, evaluateTimeoutMs)) !== true) return true
    }
    return false
  } catch {
    return false
  }
}

async function runAsk(config, prompt, deps) {
  const { attachCdp, sleep, now } = deps
  const startedAt = now()
  const askTimeoutMs = config?.askTimeoutMs ?? 600000
  const newTurnTimeoutMs = config?.newTurnTimeoutMs ?? 20000
  const evaluateTimeoutMs = config?.evaluateTimeoutMs ?? 15000
  // 取消来自子代理 manager 的 start 信号或本 provider 的 dispose。中止不抛错，
  // 而是以 status:'aborted' 结算——调用方要能区分「取消」与「失败」。
  const signal = config?.signal ?? deps.signal

  if (typeof prompt !== 'string' || prompt.length === 0) {
    throw new AskError('bad-prompt', 'prompt must be a non-empty string')
  }
  if (signal?.aborted) return { status: 'aborted', elapsedMs: 0 }

  const cdp = await attachCdp(config?.debugPort ?? 9222)
  try {
    // ---- 1. pre-flight: never preempt a running generation ----------------
    const probe = await evaluateWithTimeout(cdp, expr.probe, evaluateTimeoutMs)
    if (probe?.busy) {
      throw new AskError('busy', 'ZCode is generating (停止生成/工作中 button present) — not preempting')
    }
    const before = probe?.turns
    if (!Number.isInteger(before)) {
      throw new AskError('probe-failed', 'could not read the assistant turn count')
    }

    // ---- 2. clear the composer via synthetic keys --------------------------
    if ((await evaluateWithTimeout(cdp, expr.focus, evaluateTimeoutMs)) !== true) {
      throw new AskError('no-composer', 'no contenteditable composer found in the page')
    }
    const modifiers = selectModifiers()
    await cdp.send('Input.dispatchKeyEvent', { ...SELECT_ALL_KEY, modifiers })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, modifiers })
    await cdp.send('Input.dispatchKeyEvent', { ...BACKSPACE_KEY })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 })
    const cleared = await evaluateWithTimeout(cdp, expr.composerText, evaluateTimeoutMs)
    if (cleared !== '') {
      throw new AskError('clear-failed', `composer not empty after Cmd+A/Backspace (${JSON.stringify(cleared)})`)
    }

    // ---- 3. type the prompt and verify it verbatim --------------------------
    await cdp.send('Input.insertText', { text: prompt })
    const typed = await evaluateWithTimeout(cdp, expr.composerText, evaluateTimeoutMs)
    if (typed !== prompt) {
      throw new AskError('verify-failed', `composer content does not match the prompt (${JSON.stringify(typed)})`)
    }

    // ---- 4. send, then require proof a new turn appeared --------------------
    if ((await evaluateWithTimeout(cdp, expr.clickSend, evaluateTimeoutMs)) !== true) {
      throw new AskError('no-send-button', 'no 发送 button found')
    }
    const sendDeadline = now() + newTurnTimeoutMs
    let turnsAfter = before
    while (now() < sendDeadline) {
      if (signal?.aborted) {
        // The prompt may already be away; release the app before settling.
        await stopGeneration(cdp, evaluateTimeoutMs, { sleep, now })
        return { status: 'aborted', elapsedMs: now() - startedAt }
      }
      await sleep(250)
      turnsAfter = await evaluateWithTimeout(cdp, expr.turnCount, evaluateTimeoutMs)
      if (Number.isInteger(turnsAfter) && turnsAfter > before) break
    }
    if (!(Number.isInteger(turnsAfter) && turnsAfter > before)) {
      throw new AskError('no-new-turn', `no new assistant turn within ${newTurnTimeoutMs}ms — the prompt was not sent`)
    }

    // ---- 5. read turns[before] until generation completes ------------------
    const deadline = now() + askTimeoutMs
    let sawStop = false
    let turnSeenAt = null
    let previousText = null
    let lastText = ''
    while (true) {
      if (signal?.aborted) {
        await stopGeneration(cdp, evaluateTimeoutMs, { sleep, now })
        return { status: 'aborted', partialText: lastText, elapsedMs: now() - startedAt }
      }
      if (now() >= deadline) {
        // A timed-out turn is still generating; nobody will read more of it and
        // a live generation would block the next ask() on the `busy` pre-check.
        await stopGeneration(cdp, evaluateTimeoutMs, { sleep, now })
        return { status: 'timeout', partialText: lastText, elapsedMs: now() - startedAt }
      }
      const sample = await evaluateWithTimeout(cdp, expr.sample(before), evaluateTimeoutMs)
      if (!sample?.present) {
        await sleep(1000)
        continue
      }
      if (turnSeenAt === null) turnSeenAt = now()
      if (sample.text) lastText = sample.text
      if (sample.busy) {
        sawStop = true
        previousText = null
        await sleep(1000)
        continue
      }
      // Stable across two samples 1000ms apart. Normally the stop button must
      // have appeared and disappeared first; a generation that finished between
      // two samples (stop never caught) still completes after a 2s grace so a
      // fast answer cannot hang until the timeout.
      if (sample.text && sample.text === previousText && (sawStop || now() - turnSeenAt >= 2000)) {
        return { status: 'ok', answer: sample.text, elapsedMs: now() - startedAt }
      }
      previousText = sample.text
      await sleep(1000)
    }
  } finally {
    try {
      cdp.dispose()
    } catch {
      /* already closed */
    }
  }
}

let queue = Promise.resolve()

/**
 * Ask ZCode a question and wait for the answer. Serialized: concurrent callers
 * queue up instead of fighting over the single composer.
 *
 * @param {{ debugPort?: number, askTimeoutMs?: number, newTurnTimeoutMs?: number }} config
 * @param {string} prompt
 * @param {{ attachCdp?: Function, sleep?: (ms: number) => Promise<void>, now?: () => number }} [deps]
 *   injectable for tests; defaults hit the real CDP and clock.
 * @returns {Promise<{ status: 'ok', answer: string, elapsedMs: number } |
 *                     { status: 'timeout', partialText: string, elapsedMs: number }>}
 * @throws {AskError} busy / no-composer / clear-failed / verify-failed /
 *   no-send-button / no-new-turn / bad-prompt
 */
export function ask(config, prompt, deps = {}) {
  const resolved = {
    attachCdp: deps.attachCdp ?? attach,
    sleep: deps.sleep ?? defaultSleep,
    now: deps.now ?? (() => Date.now()),
  }
  const run = queue.then(() => runAsk(config, prompt, resolved))
  // The queue must survive rejections — the next ask starts either way.
  queue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}
