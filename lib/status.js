/**
 * dsh-zcode-native — read-only status collectors (host side).
 *
 * Five independent sources, each failure isolated to its own slot of the
 * snapshot (a dead one degrades its field, never the whole response):
 *
 *   account  ~/.zcode/v2/credentials.json — `enc:v1:` AES-256-GCM envelopes,
 *            key = sha256(ZCODE_CREDENTIAL_SECRET ?? "zcode-credential-fallback:
 *            <platform>:<homedir>:<username>"). Identity only is reported; the
 *            token is used in-memory for the plan call and NEVER returned.
 *   client   CDP snapshot (lib/cdp.js) of the renderer page.
 *   plan     GET https://zcode.z.ai/api/v1/zcode-plan/billing/current
 *            (needs app_version query + x-zcode-app-version/x-platform headers —
 *            measured 401 without them, 200 with).
 *   balance  GET https://zcode.z.ai/api/v1/zcode-plan/billing/balance
 *            (measured: always HTTP 400 {"code":3001,"msg":"parameter error"} on
 *            this machine — reported as-is, never a guessed number).
 *   catalog  ~/.zcode/v2/runtime/provider/<platform>-<arch>/<appVersion>/
 *            endpoint-<hash>/zcode-builtin.json (fs.readdir; missing -> []).
 *
 * @module dsh-zcode-native/status
 */
import { createDecipheriv, createHash } from 'node:crypto'
import { homedir, platform as osPlatform, userInfo } from 'node:os'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { attach } from './cdp.js'

const PREFIX = 'enc:v1:'
const ZCODE_HOME = join(homedir(), '.zcode')
const PLAN_ORIGIN = 'https://zcode.z.ai'
const HTTP_TIMEOUT_MS = 8000

/** The app's own fallback secret — this is how the client itself decrypts offline. */
export function credentialSecret() {
  return (
    process.env.ZCODE_CREDENTIAL_SECRET ??
    `zcode-credential-fallback:${osPlatform()}:${homedir()}:${userInfo().username}`
  )
}

/** Decrypt one `enc:v1:<nonce>.<tag>.<ciphertext>` value; non-encrypted values pass through. */
export function decryptCredential(value, secret = credentialSecret()) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value
  const parts = value.slice(PREFIX.length).split('.')
  if (parts.length !== 3) throw new Error('zcode-native: malformed credential envelope')
  const [nonce, tag, ciphertext] = parts.map((part) => Buffer.from(part, 'base64url'))
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

/**
 * Account facts safe to show. Accepts the raw credentials.json TEXT (any junk is
 * tolerated), returns exactly six fields — never the token itself, only its length.
 */
export function describeAccount(raw) {
  let store
  try {
    store = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return { id: null, username: null, displayName: null, activeProvider: null, hasAccountToken: false, accountTokenLength: 0, error: 'credentials.json is not valid JSON' }
  }
  if (store === null || typeof store !== 'object' || Array.isArray(store)) {
    return { id: null, username: null, displayName: null, activeProvider: null, hasAccountToken: false, accountTokenLength: 0, error: 'credentials.json is not an object' }
  }

  const decode = (name) => {
    try {
      return decryptCredential(store[name])
    } catch {
      return null
    }
  }

  let userInfo = null
  try {
    userInfo = JSON.parse(decode('oauth:bigmodel:user_info') ?? 'null')
  } catch {
    userInfo = null
  }
  if (userInfo === null || typeof userInfo !== 'object') userInfo = null

  const token = decode('zcodejwttoken')
  return {
    id: typeof userInfo?.id === 'string' || typeof userInfo?.id === 'number' ? userInfo.id : null,
    username: typeof userInfo?.username === 'string' ? userInfo.username : null,
    displayName: typeof userInfo?.displayName === 'string' ? userInfo.displayName : null,
    activeProvider: typeof decode('oauth:active_provider') === 'string' ? decode('oauth:active_provider') : null,
    hasAccountToken: typeof token === 'string' && token.length > 0,
    accountTokenLength: typeof token === 'string' ? token.length : 0,
  }
}

/** The decrypted zcodejwttoken for in-memory use ONLY (plan/balance bearer). Never logged. */
export async function readAccountToken(home = ZCODE_HOME) {
  const raw = await readFile(join(home, 'v2', 'credentials.json'), 'utf8')
  const store = JSON.parse(raw)
  if (store === null || typeof store !== 'object') return null
  try {
    const token = decryptCredential(store['zcodejwttoken'])
    return typeof token === 'string' && token.length > 0 ? token : null
  } catch {
    return null
  }
}

/** Normalize a billing/current body. Malformed input -> { authenticated:false, error }, never throws. */
export function parsePlan(raw) {
  let parsed
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return { authenticated: false, error: 'billing/current returned a non-JSON body' }
  }
  const plans = parsed?.data?.plans
  if (!Array.isArray(plans)) {
    return { authenticated: false, error: 'billing/current response has no plans array' }
  }
  return {
    authenticated: true,
    plans: plans.map((plan) => ({
      planId: plan?.plan_id ?? null,
      name: plan?.name ?? null,
      status: plan?.status ?? null,
      startsAt: plan?.starts_at ?? null,
      endsAt: plan?.ends_at ?? null,
      entitlements: Array.isArray(plan?.entitlements)
        ? plan.entitlements.map((entitlement) => ({ showName: entitlement?.show_name ?? null }))
        : [],
    })),
  }
}

/**
 * Normalize a billing/balance body. The measured reality on this machine is
 * HTTP 400 {"code":3001,"msg":"parameter error"} — that becomes
 * { available:false, reason:'HTTP 400 code=3001 msg=parameter error' }.
 * Numbers are reported only from an actual code:0 response, never invented.
 */
export function parseBalance(raw, httpStatus) {
  let parsed
  try {
    parsed = typeof raw === 'string' && raw.length > 0 ? JSON.parse(raw) : null
  } catch {
    parsed = null
  }
  const balances = parsed?.data?.balances
  if (parsed?.code === 0 && Array.isArray(balances)) {
    return {
      available: true,
      balances: balances.map((bucket) => ({
        showName: bucket?.show_name ?? null,
        remainingUnits: bucket?.remaining_units ?? bucket?.available_units ?? null,
        unitType: bucket?.unit_type ?? null,
      })),
    }
  }
  const detail =
    parsed?.code !== undefined
      ? `code=${parsed.code} msg=${parsed?.msg ?? ''}`
      : `body=${typeof raw === 'string' ? raw.slice(0, 120) : 'none'}`
  return { available: false, reason: `HTTP ${httpStatus ?? '?'} ${detail}` }
}

/** Normalize one zcode-builtin.json. Malformed / wrong shape -> [], never throws. */
export function parseCatalog(raw) {
  let parsed
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
  } catch {
    return []
  }
  const rules = parsed?.config?.providerConfigRules?.templateRules
  if (!Array.isArray(rules)) return []
  const templates = []
  for (const rule of rules) {
    if (typeof rule?.templateId !== 'string') continue
    const modelIds = rule?.config?.builtinModelIds
    templates.push({
      templateId: rule.templateId,
      builtinModelCount: Array.isArray(modelIds) ? modelIds.length : 0,
    })
  }
  return templates
}

function platformArchName() {
  const arch = process.arch === 'arm64' ? 'aarch64' : process.arch
  return `${osPlatform()}-${arch}`
}

/**
 * Read every endpoint-<hash>/zcode-builtin.json under
 * <home>/v2/runtime/provider/<platform-arch>/<appVersion>/. All version dirs are
 * scanned with readdir; anything unreadable is skipped, so a missing tree -> [].
 */
export async function readCatalog(home = ZCODE_HOME, platformArch = platformArchName()) {
  const base = join(home, 'v2', 'runtime', 'provider', platformArch)
  let versions
  try {
    versions = await readdir(base)
  } catch {
    return []
  }
  const templates = []
  for (const versionDir of versions) {
    let endpoints
    try {
      endpoints = await readdir(join(base, versionDir))
    } catch {
      continue
    }
    for (const entry of endpoints) {
      if (!entry.startsWith('endpoint-')) continue
      try {
        const raw = await readFile(join(base, versionDir, entry, 'zcode-builtin.json'), 'utf8')
        templates.push(...parseCatalog(raw))
      } catch {
        continue
      }
    }
  }
  return templates
}

async function fetchText(url, headers, timeoutMs = HTTP_TIMEOUT_MS, fetchImpl = fetch) {
  const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
  const text = await response.text()
  return { ok: response.ok, status: response.status, text }
}

/** billing/current with the bearer. Failures -> { authenticated:false, error }. */
export async function collectPlan(token, appVersion, deps = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    return { authenticated: false, error: 'no account token in the credential store' }
  }
  const query = new URLSearchParams({ app_version: appVersion, platform: osPlatform() })
  try {
    const { ok, status, text } = await fetchText(
      `${PLAN_ORIGIN}/api/v1/zcode-plan/billing/current?${query}`,
      {
        authorization: `Bearer ${token}`,
        'x-zcode-app-version': appVersion,
        'x-platform': osPlatform(),
      },
      deps.timeoutMs,
      deps.fetch,
    )
    if (!ok) return { authenticated: false, error: `billing/current HTTP ${status}: ${text.slice(0, 120)}` }
    return parsePlan(text)
  } catch (error) {
    return { authenticated: false, error: `billing/current ${error.name === 'TimeoutError' ? 'timed out' : error.message}` }
  }
}

/** billing/balance with the bearer. Failures -> { available:false, reason } with the REAL error. */
export async function collectBalance(token, appVersion, deps = {}) {
  if (typeof token !== 'string' || token.length === 0) {
    return { available: false, reason: 'no account token in the credential store' }
  }
  const query = new URLSearchParams({ app_version: appVersion })
  try {
    const { status, text } = await fetchText(
      `${PLAN_ORIGIN}/api/v1/zcode-plan/billing/balance?${query}`,
      {
        authorization: `Bearer ${token}`,
        'x-zcode-app-version': appVersion,
        'x-platform': osPlatform(),
      },
      deps.timeoutMs,
      deps.fetch,
    )
    return parseBalance(text, status)
  } catch (error) {
    return { available: false, reason: `billing/balance ${error.name === 'TimeoutError' ? 'timed out' : error.message}` }
  }
}

/**
 * One status snapshot. Every slot fails alone: account / client / plan / balance /
 * catalog each run in their own try-catch and degrade to { error } (or the slot's
 * own unavailable shape) without affecting the others.
 *
 * @param {{ debugPort?: number, cacheMs?: number }} config
 * @param {{ home?: string, fetch?: Function, attachCdp?: Function, timeoutMs?: number }} [deps]
 *   injectable for tests; defaults hit the real machine.
 */
export async function collectStatus(config, deps = {}) {
  const resolved = {
    debugPort: config?.debugPort ?? 9222,
    cacheMs: config?.cacheMs ?? 15000,
  }
  const home = deps.home ?? ZCODE_HOME

  const credentialsJob = (async () => {
    try {
      const raw = await readFile(join(home, 'v2', 'credentials.json'), 'utf8')
      return describeAccount(raw)
    } catch (error) {
      return { id: null, username: null, displayName: null, activeProvider: null, hasAccountToken: false, accountTokenLength: 0, error: `credentials: ${error.code ?? error.message}` }
    }
  })()

  const tokenJob = (async () => {
    try {
      return await readAccountToken(home)
    } catch {
      return null
    }
  })()

  const clientJob = (async () => {
    let cdp = null
    try {
      cdp = await (deps.attachCdp ?? attach)(resolved.debugPort)
      const snap = await cdp.snapshot()
      return {
        reachable: true,
        browser: snap.appVersion ?? null,
        appVersion: /ZCode\/([\d.]+)/.exec(String(snap.appVersion ?? ''))?.[1] ?? null,
        pageTitle: snap.title ?? null,
      }
    } catch (error) {
      return { reachable: false, reason: error.message }
    } finally {
      try {
        cdp?.dispose()
      } catch {
        /* already disposed */
      }
    }
  })()

  const catalogJob = (async () => {
    try {
      return await readCatalog(home)
    } catch (error) {
      return { error: `catalog: ${error.message}` }
    }
  })()

  // plan/balance need the token and want the client's appVersion, so they start
  // once those resolve; everything else is already running concurrently.
  const [credentials, , client, catalog] = await Promise.all([credentialsJob, tokenJob, clientJob, catalogJob])
  const token = await tokenJob
  const appVersion = client.appVersion ?? '0.0.0'

  const snapshot = {
    at: new Date().toISOString(),
    config: { debugPort: resolved.debugPort, cacheMs: resolved.cacheMs },
    account: credentials,
    client,
    plan: await collectPlan(token, appVersion, { fetch: deps.fetch, timeoutMs: deps.timeoutMs }),
    balance: await collectBalance(token, appVersion, { fetch: deps.fetch, timeoutMs: deps.timeoutMs }),
    catalog,
  }
  return snapshot
}
