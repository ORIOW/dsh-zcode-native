/**
 * Unit tests for lib/status.js — the parts that do NOT need the network.
 * Run: node --test test/
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  credentialSecret,
  decryptCredential,
  describeAccount,
  parseBalance,
  parseCatalog,
  parsePlan,
  collectStatus,
} from '../lib/status.js'

/** Encrypt a value into the app's own `enc:v1:` envelope so tests stay machine-independent. */
function encrypt(value) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(credentialSecret()).digest(), nonce)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return `enc:v1:${nonce.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${ciphertext.toString('base64url')}`
}

test('describeAccount tolerates malformed JSON input without throwing', () => {
  for (const junk of ['', 'not json {', '{"zcodejwttoken":', '[]', 'null', '123']) {
    const account = describeAccount(junk)
    assert.equal(typeof account, 'object')
    assert.equal(account.hasAccountToken, false)
    assert.equal(account.accountTokenLength, 0)
    assert.equal(account.id, null)
    assert.equal(account.username, null)
  }
})

test('describeAccount survives missing fields', () => {
  const account = describeAccount(JSON.stringify({}))
  assert.deepEqual(
    Object.keys(account).sort(),
    ['accountTokenLength', 'activeProvider', 'displayName', 'hasAccountToken', 'id', 'username'].sort(),
  )
  assert.equal(account.hasAccountToken, false)
})

test('describeAccount decrypts enc:v1 values and NEVER emits the token', () => {
  const TOKEN = 'plain-jwt-value-SHOULD-NOT-LEAK-0123456789'
  const userJson = JSON.stringify({ id: 'u-1', username: 'alice', displayName: 'Alice' })
  const raw = JSON.stringify({
    zcodejttoken_placeholder: 'ignored',
    zcodejwttoken: encrypt(TOKEN),
    'oauth:bigmodel:user_info': encrypt(userJson),
    'oauth:active_provider': encrypt('bigmodel'),
  })
  const account = describeAccount(raw)

  assert.equal(account.id, 'u-1')
  assert.equal(account.username, 'alice')
  assert.equal(account.displayName, 'Alice')
  assert.equal(account.activeProvider, 'bigmodel')
  assert.equal(account.hasAccountToken, true)
  assert.equal(account.accountTokenLength, TOKEN.length)
  assert.equal(JSON.stringify(account).includes(TOKEN), false, 'token text leaked into account output')
})

test('decryptCredential round-trips and rejects a tampered envelope', () => {
  const value = 'hello roundtrip'
  const encrypted = encrypt(value)
  assert.equal(decryptCredential(encrypted, credentialSecret()), value)
  assert.equal(decryptCredential('plain-value', credentialSecret()), 'plain-value')
  assert.throws(() => decryptCredential('enc:v1:broken', credentialSecret()))
})

test('parseCatalog: malformed input -> [], valid input -> mapped template ids + counts', () => {
  assert.deepEqual(parseCatalog('{broken'), [])
  assert.deepEqual(parseCatalog('{"config":{}}'), [])
  assert.deepEqual(parseCatalog('{"config":{"providerConfigRules":{"templateRules":"nope"}}}'), [])

  const good = JSON.stringify({
    config: {
      providerConfigRules: {
        templateRules: [
          { templateId: 'zai-api', config: { builtinModelIds: ['GLM-5.3', 'GLM-5.3-Flash'] } },
          { templateId: 'no-models' },
          { templateId: 'bad-models', config: { builtinModelIds: 'not-an-array' } },
          { templateIdIsMissing: true },
        ],
      },
    },
  })
  assert.deepEqual(parseCatalog(good), [
    { templateId: 'zai-api', builtinModelCount: 2 },
    { templateId: 'no-models', builtinModelCount: 0 },
    { templateId: 'bad-models', builtinModelCount: 0 },
  ])
})

test('parseBalance: the measured 3001 body yields available:false with the REAL reason, no numbers', () => {
  const result = parseBalance('{"code":3001,"msg":"parameter error","logid":"x"}', 400)
  assert.equal(result.available, false)
  assert.match(result.reason, /HTTP 400/)
  assert.match(result.reason, /3001/)
  assert.match(result.reason, /parameter error/)
  assert.equal('balances' in result, false, 'must not invent balance numbers')
})

test('parseBalance: malformed body and non-zero codes also degrade without numbers', () => {
  assert.equal(parseBalance('<!DOCTYPE html>', 404).available, false)
  assert.equal(parseBalance('', 500).available, false)
  assert.equal(parseBalance('{"code":7,"msg":"internal"}', 200).available, false)
})

test('parseBalance: a real code:0 response maps balances', () => {
  const result = parseBalance(JSON.stringify({
    code: 0,
    data: { balances: [{ show_name: 'GLM', remaining_units: 12, unit_type: 'token' }] },
  }), 200)
  assert.equal(result.available, true)
  assert.deepEqual(result.balances, [{ showName: 'GLM', remainingUnits: 12, unitType: 'token' }])
})

test('parsePlan: malformed -> authenticated:false; valid -> camelCase mapping', () => {
  const bad = parsePlan('nope')
  assert.equal(bad.authenticated, false)
  assert.ok(bad.error)

  const good = parsePlan(JSON.stringify({
    code: 0,
    data: {
      plans: [{
        plan_id: 'zcode-v3-start-plan-1024',
        name: 'ZCode 1024 Dev Day',
        status: 'active',
        starts_at: 1,
        ends_at: 2,
        entitlements: [{ show_name: 'GLM-5.3-Flash' }],
      }],
    },
  }))
  assert.equal(good.authenticated, true)
  assert.deepEqual(good.plans, [{
    planId: 'zcode-v3-start-plan-1024',
    name: 'ZCode 1024 Dev Day',
    status: 'active',
    startsAt: 1,
    endsAt: 2,
    entitlements: [{ showName: 'GLM-5.3-Flash' }],
  }])
})

test('collectStatus: token never leaks end-to-end, each slot stays independent', async () => {
  const TOKEN = 'END-TO-END-TOKEN-DO-NOT-LEAK-9876543210'
  const home = mkdtempSync(join(tmpdir(), 'zcode-native-test-'))
  mkdirSync(join(home, 'v2'), { recursive: true })
  writeFileSync(
    join(home, 'v2', 'credentials.json'),
    JSON.stringify({ zcodejwttoken: TOKEN, 'oauth:bigmodel:user_info': encrypt('{"id":"u-9","username":"bob"}') }),
  )

  const stubFetch = async (url) => {
    if (String(url).includes('billing/current')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { plans: [{ plan_id: 'p1', name: 'Plan One', status: 'active', entitlements: [] }] } }) }
    }
    if (String(url).includes('billing/balance')) {
      return { ok: false, status: 400, text: async () => '{"code":3001,"msg":"parameter error"}' }
    }
    throw new Error(`unexpected url ${url}`)
  }
  const stubAttach = async () => ({
    snapshot: async () => ({ title: 'ZCode', appVersion: 'Mozilla/5.0 ZCode/3.16.3', buttons: ['stop'], composerText: '', hasStopButton: true }),
    dispose() {},
  })

  const snapshot = await collectStatus(
    { debugPort: 9333, cacheMs: 15000 },
    { home, fetch: stubFetch, attachCdp: stubAttach },
  )

  assert.equal(snapshot.account.hasAccountToken, true)
  assert.equal(snapshot.account.accountTokenLength, TOKEN.length)
  assert.equal(snapshot.account.username, 'bob')
  assert.equal(snapshot.client.reachable, true)
  assert.equal(snapshot.client.appVersion, '3.16.3')
  assert.equal(snapshot.plan.authenticated, true)
  assert.equal(snapshot.plan.plans[0].planId, 'p1')
  assert.equal(snapshot.balance.available, false)
  assert.match(snapshot.balance.reason, /3001/)
  assert.deepEqual(snapshot.catalog, [])

  const dumped = JSON.stringify(snapshot)
  assert.equal(dumped.includes(TOKEN), false, 'the real token leaked into the status JSON')
})

test('collectStatus: a missing home degrades every slot instead of throwing', async () => {
  const snapshot = await collectStatus(
    { debugPort: 9333, cacheMs: 15000 },
    { home: join(tmpdir(), 'zcode-native-nope-does-not-exist'), fetch: async () => { throw new Error('offline') }, attachCdp: async () => { throw new Error('no cdp') } },
  )
  assert.equal(snapshot.client.reachable, false)
  assert.ok(snapshot.client.reason)
  assert.equal(snapshot.plan.authenticated, false)
  assert.equal(snapshot.balance.available, false)
  assert.deepEqual(snapshot.catalog, [])
})
