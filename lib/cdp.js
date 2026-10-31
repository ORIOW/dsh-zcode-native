/**
 * dsh-zcode-native — CDP client (host side).
 *
 * Talks to the ZCode renderer over the Chrome DevTools Protocol on
 * 127.0.0.1:<debugPort>. Read paths only use Runtime.evaluate; ask.js drives
 * the composer through Input.* commands via send(). The host part of the URL
 * is hardcoded to 127.0.0.1 — the port is the only thing config can influence.
 *
 * Node >= 22 ships a global WebSocket, so no dependency is needed here.
 *
 * @module dsh-zcode-native/cdp
 */

/** Default per-request / connect timeout. */
const DEFAULT_TIMEOUT_MS = 5000

/**
 * One snapshot of the renderer page, read without touching anything.
 * Buttons are flattened to their aria-label/title/text; the composer is the
 * first textarea / contenteditable / role=textbox on the page.
 */
const SNAPSHOT_EXPRESSION = `(() => {
  const buttons = Array.from(document.querySelectorAll('button'))
    .map((button) => (button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent || '').trim())
    .filter((text) => text.length > 0)
  const field = document.querySelector('textarea, [contenteditable="true"], [role="textbox"]')
  return {
    title: document.title,
    appVersion: navigator.userAgent,
    buttons,
    composerText: field ? (field.value !== undefined && field.value !== null ? field.value : (field.textContent || '')) : '',
    hasStopButton: buttons.some((text) => /^(stop|停止)$/i.test(text)),
  }
})()`

/**
 * Connect to the ZCode renderer page via CDP.
 *
 * @param {number} port - debug port from config; must be an integer 1-65535.
 *   The request target is always http://127.0.0.1:<port>/json/list — arbitrary
 *   URLs are not accepted.
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ evaluate: (expression: string) => Promise<any>, snapshot: () => Promise<object>, dispose: () => void }>}
 */
export async function attach(port, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`zcode-native: invalid CDP port ${JSON.stringify(port)}`)
  }
  // Host is hardcoded; only the validated integer port is interpolated.
  const base = `http://127.0.0.1:${port}`

  let targets
  try {
    const response = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    targets = await response.json()
  } catch (error) {
    throw new Error(`zcode-native: CDP ${base}/json/list unreachable (${error.message})`)
  }
  if (!Array.isArray(targets)) {
    throw new Error('zcode-native: /json/list did not return a target list')
  }
  const page = targets.find(
    (target) => target?.type === 'page' && String(target.url).includes('renderer/index.html'),
  )
  if (!page) {
    throw new Error(
      `zcode-native: no renderer/index.html page among ${targets.length} CDP target(s) on port ${port}`,
    )
  }
  const wsUrl = page.webSocketDebuggerUrl
  if (typeof wsUrl !== 'string' || wsUrl.length === 0) {
    throw new Error('zcode-native: renderer target has no webSocketDebuggerUrl')
  }
  return new CdpSession(wsUrl, timeoutMs)
}

class CdpSession {
  /** @type {WebSocket|null} */
  #ws = null
  /** @type {Promise<void>} */
  #ready
  /** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
  #pending = new Map()
  #nextId = 1
  #closed = false
  #timeoutMs

  constructor(wsUrl, timeoutMs) {
    this.#timeoutMs = timeoutMs
    const ws = new WebSocket(wsUrl)
    this.#ws = ws
    this.#ready = new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true })
      ws.addEventListener('error', () => reject(new Error('zcode-native: CDP websocket failed to connect')), { once: true })
    })
    ws.addEventListener('message', (event) => this.#onMessage(event))
    ws.addEventListener('close', () => this.#failAll(new Error('zcode-native: CDP websocket closed')))
    ws.addEventListener('error', () => this.#failAll(new Error('zcode-native: CDP websocket error')))
  }

  #onMessage(event) {
    let message
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    const entry = typeof message?.id === 'number' ? this.#pending.get(message.id) : undefined
    if (!entry) return
    this.#pending.delete(message.id)
    clearTimeout(entry.timer)
    entry.resolve(message)
  }

  #failAll(error) {
    for (const entry of this.#pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.#pending.clear()
  }

  async #call(method, params) {
    await this.#ready
    if (this.#closed) throw new Error('zcode-native: CDP session disposed')
    const ws = this.#ws
    if (!ws || ws.readyState !== 1) throw new Error('zcode-native: CDP websocket is not open')

    const id = this.#nextId++
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`zcode-native: CDP ${method} timed out after ${this.#timeoutMs}ms`))
      }, this.#timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
    })
    ws.send(JSON.stringify({ id, method, params }))
    return promise
  }

  /**
   * Evaluate an expression in the page and return its value.
   * @throws when the page raises or the response carries exceptionDetails.
   */
  async evaluate(expression) {
    const message = await this.#call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })
    if (message?.error) {
      throw new Error(`zcode-native: CDP rejected Runtime.evaluate (${message.error.message ?? 'unknown'})`)
    }
    const details = message?.result?.exceptionDetails
    if (details) {
      const text = details.exception?.description ?? details.text ?? 'unknown exception'
      throw new Error(`zcode-native: evaluate failed in page: ${text.split('\n')[0]}`)
    }
    return message?.result?.result?.value
  }

  /** Read-only page snapshot: { title, appVersion, buttons, composerText, hasStopButton }. */
  async snapshot() {
    const value = await this.evaluate(SNAPSHOT_EXPRESSION)
    if (value === null || typeof value !== 'object') {
      throw new Error('zcode-native: snapshot returned no object (returnByValue mismatch?)')
    }
    return value
  }

  /**
   * Raw CDP command, for protocol domains beyond Runtime (ask.js uses
   * Input.dispatchKeyEvent / Input.insertText to drive the composer — measured:
   * execCommand cannot clear the contenteditable). Prefer evaluate() for JS.
   */
  send(method, params) {
    return this.#call(method, params)
  }

  /** Close the socket. Idempotent; safe to call from multiple paths. */
  dispose() {
    if (this.#closed) return
    this.#closed = true
    this.#failAll(new Error('zcode-native: CDP session disposed'))
    const ws = this.#ws
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
      try {
        ws.close(1000, 'dispose')
      } catch {
        /* already closing */
      }
    }
    this.#ws = null
  }
}
