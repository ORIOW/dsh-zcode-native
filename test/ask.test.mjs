/**
 * Unit tests for lib/ask.js — the ask state machine against a FAKE CDP session.
 * No real ZCode is contacted: the fake dispatches on the exported expression
 * identities and simulates the composer/turns model. Clock and sleep are faked
 * too, so timeout paths run instantly.
 *
 * Run: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { ask, expr, AskError } from '../lib/ask.js'

const PROMPT = '请用一句话介绍你自己'

/** A scripted CDP session: records Input.* traffic, simulates the page state. */
function makeFakeCdp(options = {}) {
  const state = {
    composer: options.composer ?? '旧草稿残留',
    turns: options.turns ?? ['PRE-EXISTING TURN'],
    busy: options.busy ?? false,
    sendButton: options.sendButton ?? true,
    sendClicks: 0,
    keyEvents: [],
    insertTexts: [],
    genSamples: 0,
    answerIndex: null,
    disposed: 0,
  }
  const cdp = {
    async evaluate(value) {
      // A detached renderer swallows Runtime.evaluate and never answers — the
      // measured hang this test pins down.
      if (options.hang) return new Promise(() => {})
      if (value === expr.probe) return { busy: state.busy, hasComposer: true, turns: state.turns.length }
      if (value === expr.focus) return true
      if (value === expr.composerText) return state.composer
      if (value === expr.clickSend) {
        if (!state.sendButton) return false
        state.sendClicks += 1
        options.onSend?.(state)
        return true
      }
      if (value === expr.turnCount) return state.turns.length
      if (typeof value === 'string' && value.includes('group/assistant-row')) {
        const index = Number(/turns\[(\d+)\]/.exec(value)?.[1] ?? -1)
        options.onSample?.(state)
        const turn = state.turns[index]
        return { present: turn !== undefined, text: turn ?? '', busy: state.busy }
      }
      throw new Error(`fake cdp: unexpected evaluate(${value.slice(0, 50)}…)`)
    },
    async send(method, params) {
      if (method === 'Input.dispatchKeyEvent') {
        state.keyEvents.push(params)
        // The fake honours Cmd+A + Backspace unless the test says the clear failed.
        if (!options.ignoreKeyEvents && params.key === 'Backspace') state.composer = ''
        return {}
      }
      if (method === 'Input.insertText') {
        state.insertTexts.push(params.text)
        state.composer = options.mutateInsert ? `${params.text}（被篡改）` : params.text
        return {}
      }
      throw new Error(`fake cdp: unexpected method ${method}`)
    },
    dispose() {
      state.disposed += 1
    },
  }
  return { cdp, state }
}

/** onSend hook: begin a "generation" — busy for busySamples samples, streaming text, then final. */
function startGeneration(overrides = {}) {
  return (state) => {
    state.busy = true
    state.answerIndex = state.turns.length
    state.turns.push('')
    for (let i = 0; i < (overrides.extraTurns ?? 0); i += 1) state.turns.push('TRAP-LAST-TURN')
    state.genSamples = 0
    state.busySamples = overrides.busySamples ?? 2
    state.finalAnswer = overrides.answer ?? 'MOCK FINAL ANSWER'
  }
}

/** onSample hook: stream text into our turn while busy, land the final answer when done. */
function streamSamples(state) {
  if (state.answerIndex === null) return
  state.genSamples += 1
  if (state.busy) {
    state.turns[state.answerIndex] = `chunk-${state.genSamples}`
    if (state.genSamples >= state.busySamples) {
      state.busy = false
      state.turns[state.answerIndex] = state.finalAnswer
    }
  }
}

/** Fake clock: sleep() advances it synchronously so deadlines are reachable fast. */
function makeClock() {
  let now = 0
  return { now: () => now, sleep: async (ms) => { now += ms } }
}

async function runWithFake(options, config, fakeOverrides) {
  const { cdp, state } = makeFakeCdp({ ...options, ...fakeOverrides })
  const clock = makeClock()
  const outcome = await ask(config, options.prompt ?? PROMPT, {
    attachCdp: async () => cdp,
    sleep: clock.sleep,
    now: clock.now,
  }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
  return { outcome, state }
}

test('busy pre-check: a running generation is never preempted', async () => {
  const { outcome, state } = await runWithFake(
    { onSend: startGeneration(), onSample: streamSamples, busy: true },
    { debugPort: 9333 },
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'busy')
  assert.equal(state.sendClicks, 0, 'must not click 发送 while busy')
})

test('clear-failed: residue in the composer aborts before typing', async () => {
  const { outcome, state } = await runWithFake(
    { ignoreKeyEvents: true, onSend: startGeneration(), onSample: streamSamples },
    { debugPort: 9333 },
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'clear-failed')
  assert.equal(state.insertTexts.length, 0, 'must not type over residue')
  assert.equal(state.sendClicks, 0, 'must not click 发送')
})

test('verify-failed: a mutated composer is never sent', async () => {
  const { outcome, state } = await runWithFake(
    { mutateInsert: true, onSend: startGeneration(), onSample: streamSamples },
    { debugPort: 9333 },
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'verify-failed')
  assert.equal(state.sendClicks, 0, 'must not click 发送')
})

test('no-new-turn: turn count never grows after the click', async () => {
  const { outcome, state } = await runWithFake(
    { onSend: () => {} },
    { debugPort: 9333, newTurnTimeoutMs: 1000 },
  )
  assert.equal(outcome.ok, false)
  assert.equal(outcome.error.code, 'no-new-turn')
  assert.equal(state.sendClicks, 1, 'the click itself did happen')
})

test('normal path: the answer is read from turns[before], not the last turn', async () => {
  const { outcome, state } = await runWithFake(
    { onSend: startGeneration({ extraTurns: 1, answer: 'REAL-ANSWER' }), onSample: streamSamples },
    { debugPort: 9333 },
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.value.status, 'ok')
  assert.equal(outcome.value.answer, 'REAL-ANSWER', 'must sample turns[before], not turns[length-1] (TRAP-LAST-TURN)')
  assert.equal(typeof outcome.value.elapsedMs, 'number')
  assert.equal(state.disposed, 1, 'the CDP session is disposed exactly once')
})

test('timeout: returns partialText, never resends', async () => {
  const { outcome, state } = await runWithFake(
    { onSend: startGeneration({ busySamples: 1e9 }), onSample: streamSamples },
    { debugPort: 9333, askTimeoutMs: 10000 },
  )
  assert.equal(outcome.ok, true)
  assert.equal(outcome.value.status, 'timeout')
  assert.match(outcome.value.partialText, /^chunk-\d+$/, 'partialText is the last streamed text')
  assert.ok(outcome.value.elapsedMs >= 10000, `elapsed ${outcome.value.elapsedMs} must reach the deadline`)
  assert.equal(state.sendClicks, 1, 'must not click 发送 a second time')
})

test('serialization: a concurrent ask waits for the running one to finish', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const events = []
  let attachCalls = 0
  const { cdp, state } = makeFakeCdp({ onSend: startGeneration({ busySamples: 1 }), onSample: streamSamples })
  const clock = makeClock()
  const deps = {
    attachCdp: async () => {
      attachCalls += 1
      events.push(`attach#${attachCalls}`)
      if (attachCalls === 1) await gate
      return cdp
    },
    sleep: clock.sleep,
    now: clock.now,
  }

  const first = ask({ debugPort: 9333 }, '第一个问题', deps)
  first.then(() => events.push('done#1'), () => events.push('done#1'))
  const second = ask({ debugPort: 9333 }, '第二个问题', deps)

  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(attachCalls, 1, 'the second ask must not attach while the first is running')

  release()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(attachCalls, 2)
  assert.equal(firstResult.status, 'ok')
  assert.equal(secondResult.status, 'ok')
  assert.deepEqual(state.insertTexts, ['第一个问题', '第二个问题'])
  assert.ok(
    events.indexOf('attach#2') > events.indexOf('done#1'),
    `second attach must follow first completion: ${events.join(',')}`,
  )
})

test('ask rejects an empty prompt without touching CDP state', async () => {
  const { cdp, state } = makeFakeCdp({ onSend: startGeneration(), onSample: streamSamples })
  const clock = makeClock()
  const outcome = await ask({ debugPort: 9333 }, '', {
    attachCdp: async () => cdp,
    sleep: clock.sleep,
    now: clock.now,
  }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
  assert.equal(outcome.ok, false)
  assert.ok(outcome.error instanceof AskError)
  assert.equal(outcome.error.code, 'bad-prompt')
  assert.equal(state.sendClicks, 0)
})

test('a hung CDP evaluate fails as cdp-timeout instead of waiting forever', async () => {
  const { cdp, state } = makeFakeCdp({ hang: true })
  const clock = makeClock()
  const startedAt = Date.now()
  const outcome = await ask({ debugPort: 9333, evaluateTimeoutMs: 50 }, PROMPT, {
    attachCdp: async () => cdp,
    sleep: clock.sleep,
    now: clock.now,
  }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  )
  const wallClock = Date.now() - startedAt
  assert.equal(outcome.ok, false)
  assert.ok(outcome.error instanceof AskError)
  assert.equal(outcome.error.code, 'cdp-timeout')
  // The real timer, not the fake clock: the guard must fire on its own.
  assert.ok(wallClock < 5000, `cdp-timeout must fire promptly, took ${wallClock}ms`)
  assert.equal(state.disposed, 1, 'the CDP session must still be released after a timeout')
})
