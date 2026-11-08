import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * ZCode 的会话库。它同时被桌面端和内置 CLI 使用，`session` 表记着每个会话在哪个
 * 目录里干活，`session_entry` 里那条 `runtime/model_selection` 记着这个会话用哪个
 * provider/model。CLI 的模型选择只认这条记录（配置文件与 flag 都改不动主回合，
 * 2026-11-08 实测），所以「这次派活该用哪个模型」等价于「该 resume 哪条会话」。
 *
 * 这里只读：不写库、不造会话、不碰凭据。
 */
export const DEFAULT_DB_PATH = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')

const CACHE_MS = 30_000
const cache = new Map()

function parseSelection(data) {
  if (typeof data !== 'string' || data.length === 0) return null
  try {
    const parsed = JSON.parse(data)
    const selection = parsed?.modelSelection ?? parsed
    const providerId = typeof selection?.providerId === 'string' ? selection.providerId : ''
    const modelId = typeof selection?.modelId === 'string' ? selection.modelId : ''
    if (!providerId && !modelId) return null
    return { providerId, modelId }
  } catch {
    return null
  }
}

function sameDirectory(left, right) {
  try {
    return resolve(left) === resolve(right)
  } catch {
    return false
  }
}

function readRows(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    return db
      .prepare(
        `select s.id as id,
                s.directory as directory,
                s.title as title,
                s.time_updated as time_updated,
                (select e.data from session_entry e
                   where e.session_id = s.id and e.type = 'runtime/model_selection'
                   limit 1) as selection
           from session s
          where s.time_deleted is null
          order by s.time_updated desc
          limit 200`,
      )
      .all()
  } finally {
    db.close()
  }
}

/**
 * 找出「在这个目录里干活」的最近一条 ZCode 会话。
 *
 * @param {string} cwd - 派活的工作目录（DSH 交过来的）。
 * @param {{ dbPath?: string, exists?: Function, now?: Function, cacheMs?: number }} [options]
 * @returns {{ id: string, title: string, directory: string, updatedAt: number,
 *   model: { providerId: string, modelId: string } | null } | null}
 *   没有库、没有匹配、或读库失败都返回 null（调用方按「不带 --resume」继续）。
 */
export function resolveSessionForCwd(cwd, options = {}) {
  const dbPath = options.dbPath ?? DEFAULT_DB_PATH
  const exists = options.exists ?? existsSync
  const now = options.now ?? (() => Date.now())
  const cacheMs = options.cacheMs ?? CACHE_MS

  if (typeof cwd !== 'string' || cwd.trim().length === 0) return null

  let key
  try {
    key = resolve(cwd)
  } catch {
    return null
  }

  const cached = cache.get(key)
  if (cached && now() - cached.at < cacheMs) return cached.value

  let value = null
  try {
    if (exists(dbPath)) {
      const rows = readRows(dbPath)
      const match = rows.find((row) => sameDirectory(row.directory, cwd))
      if (match) {
        value = {
          id: match.id,
          title: typeof match.title === 'string' ? match.title : '',
          directory: match.directory,
          updatedAt: Number(match.time_updated) || 0,
          model: parseSelection(match.selection),
        }
      }
    }
  } catch {
    value = null
  }

  cache.set(key, { at: now(), value })
  return value
}

/** 供测试或配置变更后清空缓存。 */
export function clearSessionCache() {
  cache.clear()
}