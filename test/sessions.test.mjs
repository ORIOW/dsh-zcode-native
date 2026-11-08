/**
 * lib/sessions.js — 只读地认领「这条工作目录该用哪条 ZCode 会话」。
 *
 * 数据库用临时文件真造：node:sqlite 在 Node 24 稳定可用，造一个只有两列的表比
 * 手搓假对象更能证明 SQL 与解析都成立。
 *
 * Run: node --test test/sessions.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clearSessionCache, resolveSessionForCwd } from '../lib/sessions.js'

function makeDb(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'zc-sessions-'))
  const dbPath = join(dir, 'db.sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    create table session (
      id text primary key,
      directory text,
      title text,
      time_updated integer,
      time_deleted integer
    );
    create table session_entry (
      id text primary key,
      session_id text,
      type text,
      data text
    );
  `)
  for (const row of rows) {
    db.prepare('insert into session (id, directory, title, time_updated, time_deleted) values (?, ?, ?, ?, ?)')
      .run(row.id, row.directory, row.title ?? '', row.timeUpdated ?? 1, row.deletedAt ?? null)
    if (row.selection) {
      db.prepare('insert into session_entry (id, session_id, type, data) values (?, ?, ?, ?)')
        .run(`${row.id}:sel`, row.id, 'runtime/model_selection', JSON.stringify({ modelSelection: row.selection }))
    }
  }
  db.close()
  return { dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('sessions: the newest session in that directory wins, and its model is parsed', () => {
  clearSessionCache()
  const { dbPath, cleanup } = makeDb([
    { id: 'sess_old', directory: '/tmp/project', title: 'old', timeUpdated: 10, selection: { providerId: 'xiaomi-mimo', modelId: 'mimo-v2.6-flash' } },
    { id: 'sess_new', directory: '/tmp/project', title: 'new', timeUpdated: 20, selection: { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash' } },
    { id: 'sess_other', directory: '/tmp/elsewhere', timeUpdated: 30 },
  ])
  try {
    const found = resolveSessionForCwd('/tmp/project', { dbPath })
    assert.equal(found.id, 'sess_new')
    assert.equal(found.title, 'new')
    assert.deepEqual(found.model, { providerId: 'account:bigmodel-start-plan', modelId: 'GLM-5.3-Flash' })
  } finally {
    cleanup()
  }
})

test('sessions: a trailing slash and a relative path still match', () => {
  clearSessionCache()
  const { dbPath, cleanup } = makeDb([{ id: 'sess_a', directory: '/tmp/project', timeUpdated: 5 }])
  try {
    assert.equal(resolveSessionForCwd('/tmp/project///', { dbPath }).id, 'sess_a')
  } finally {
    cleanup()
  }
})

test('sessions: no session in that directory is null, not a throw', () => {
  clearSessionCache()
  const { dbPath, cleanup } = makeDb([{ id: 'sess_a', directory: '/tmp/project', timeUpdated: 5 }])
  try {
    assert.equal(resolveSessionForCwd('/tmp/nowhere', { dbPath }), null)
  } finally {
    cleanup()
  }
})

test('sessions: a missing database is null, not a throw', () => {
  clearSessionCache()
  assert.equal(resolveSessionForCwd('/tmp/project', { dbPath: '/tmp/definitely-not-here/db.sqlite' }), null)
})

test('sessions: a deleted session is skipped', () => {
  clearSessionCache()
  const { dbPath, cleanup } = makeDb([
    { id: 'sess_gone', directory: '/tmp/project', timeUpdated: 30, deletedAt: 31 },
    { id: 'sess_live', directory: '/tmp/project', timeUpdated: 20 },
  ])
  try {
    assert.equal(resolveSessionForCwd('/tmp/project', { dbPath }).id, 'sess_live')
  } finally {
    cleanup()
  }
})

test('sessions: the answer is cached until the cache expires', () => {
  clearSessionCache()
  const { dbPath, cleanup } = makeDb([{ id: 'sess_a', directory: '/tmp/project', timeUpdated: 5 }])
  try {
    let clock = 0
    const first = resolveSessionForCwd('/tmp/project', { dbPath, now: () => clock, cacheMs: 100 })
    assert.equal(first.id, 'sess_a')
    clock = 50
    assert.equal(resolveSessionForCwd('/tmp/project', { dbPath, now: () => clock, cacheMs: 100 }).id, 'sess_a')
    clock = 101
    assert.equal(resolveSessionForCwd('/tmp/project', { dbPath, now: () => clock, cacheMs: 100 }).id, 'sess_a')
  } finally {
    cleanup()
  }
})

test('sessions: an empty cwd never touches the database', () => {
  clearSessionCache()
  assert.equal(resolveSessionForCwd(''), null)
  assert.equal(resolveSessionForCwd('   '), null)
})
