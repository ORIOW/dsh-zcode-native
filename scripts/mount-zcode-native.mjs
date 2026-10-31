#!/usr/bin/env node
/**
 * 把 dsh-zcode-native 挂进 DSH profile（M0 挂载步骤）。
 *
 * 为什么需要单独一个脚本：本会话沙箱是 workspace-write，DSH_HOME 不可写
 * （实测 `touch $DSH_HOME/skills/.probe` → Operation not permitted），
 * 所以挂载必须在提权下执行。
 *
 * 做的事（幂等，可重复跑）：
 *   1. 备份 profiles/web/package.json 与 cordis.patch.yml
 *   2. package.json 的 dependencies 加 "dsh-zcode-native": "link:<WORKSPACE>"
 *   3. package.json 的 dsh.profile.bundles 追加 "dsh-zcode-native"
 *   4. 调内置 pnpm install（$DSH_HOME/.desktop-bin/pnpm）
 *   5. 建 node_modules/dsh-zcode-native symlink 并校验 realpath
 *   6. cordis.patch.yml 追加 insert 块（已存在则跳过）
 *
 * 用法：
 *   node mount-zcode-native.mjs            # 干跑，只打印将要做什么
 *   node mount-zcode-native.mjs --apply    # 真执行
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, symlinkSync, unlinkSync, realpathSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'

const APPLY = process.argv.includes('--apply')
// 仓库根 = 本脚本所在目录的上一级；可用 ZCODE_NATIVE_REPO 覆盖（检出位置不在 scripts/ 旁边时）。
const WORKSPACE = process.env.ZCODE_NATIVE_REPO ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_NAME = 'dsh-zcode-native'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), 'Library', 'Application Support', 'dsh-desktop', 'harness')
const PROFILE = join(DSH_HOME, 'profiles', 'web')
const PKG_JSON = join(PROFILE, 'package.json')
const PATCH_YML = join(PROFILE, 'cordis.patch.yml')
const NM_LINK = join(PROFILE, 'node_modules', PKG_NAME)
const PNPM = join(DSH_HOME, '.desktop-bin', 'pnpm')
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')

const log = (m) => console.log(`${APPLY ? '' : '[dry-run] '}${m}`)

/** Fail loudly rather than half-applying. */
function must(cond, message) {
  if (!cond) { console.error(`ABORT: ${message}`); process.exit(1) }
}

must(existsSync(WORKSPACE), `workspace not found: ${WORKSPACE}`)
must(existsSync(join(WORKSPACE, 'package.json')), 'workspace has no package.json')
must(existsSync(PKG_JSON), `profile package.json not found: ${PKG_JSON}`)

const wsPkg = JSON.parse(readFileSync(join(WORKSPACE, 'package.json'), 'utf8'))
must(wsPkg.name === PKG_NAME, `workspace package name is "${wsPkg.name}", expected "${PKG_NAME}"`)

// ── 1. profile package.json ───────────────────────────────────────────────
const profile = JSON.parse(readFileSync(PKG_JSON, 'utf8'))
const depSpec = `link:${WORKSPACE}`
const alreadyDep = profile.dependencies?.[PKG_NAME] === depSpec
const bundles = profile.dsh?.profile?.bundles ?? []
const alreadyBundle = bundles.includes(PKG_NAME)

log(`dependencies["${PKG_NAME}"] = ${depSpec}  (currently: ${profile.dependencies?.[PKG_NAME] ?? 'absent'})`)
log(`dsh.profile.bundles includes "${PKG_NAME}": ${alreadyBundle}  (bundles count: ${bundles.length})`)

if (!alreadyDep || !alreadyBundle) {
  if (APPLY) {
    copyFileSync(PKG_JSON, `${PKG_JSON}.bak-zcodenative-${STAMP}`)
    profile.dependencies = { ...(profile.dependencies ?? {}), [PKG_NAME]: depSpec }
    if (!alreadyBundle) {
      profile.dsh = profile.dsh ?? {}
      profile.dsh.profile = profile.dsh.profile ?? {}
      profile.dsh.profile.bundles = [...bundles, PKG_NAME]
    }
    writeFileSync(PKG_JSON, `${JSON.stringify(profile, null, 2)}\n`)
    log('profile package.json updated')
  }
}

// ── 2. pnpm install ───────────────────────────────────────────────────────
// `link:` dependencies need no network: pnpm just symlinks them. But a full
// `pnpm install` also re-resolves every OTHER dependency in the profile, and
// this machine has at least one git dependency (`aegis` → github:GanyuanRan/
// Aegis#<sha>) that fails without GitHub SSH access:
//
//   git fetch --depth 1 origin a95fa4bf... → git@github.com: Permission denied (publickey)
//
// That failure is unrelated to this plugin and must not abort the mount. We
// only need our own link, so install with `--no-frozen-lockfile` OFF and treat
// a non-zero exit as a WARNING when the symlink step below can still succeed.
let installOk = false
if (APPLY) {
  must(existsSync(PNPM), `bundled pnpm not found: ${PNPM}`)
  log(`running: ${PNPM} install`)
  const r = spawnSync(PNPM, ['install'], { cwd: PROFILE, encoding: 'utf8', stdio: 'inherit' })
  installOk = r.status === 0
  if (!installOk) {
    console.warn(
      `\nWARNING: pnpm install exited ${r.status}.\n` +
      `  Most common cause on this machine: the pre-existing git dependency\n` +
      `  "aegis" (github:GanyuanRan/Aegis#a95fa4bf...) cannot be fetched without\n` +
      `  GitHub SSH access. That is NOT caused by ${PKG_NAME}.\n` +
      `  Continuing: a link: dependency is satisfied by a plain symlink, which\n` +
      `  step 3 creates and verifies. Existing node_modules is left untouched.\n`,
    )
  }
}

// ── 3. node_modules symlink ───────────────────────────────────────────────
// pnpm's `link:` protocol normally creates this symlink itself, so after a
// successful install this step is usually an idempotent no-op. It is kept for
// two reasons: it is the fallback when install fails (see above), and the
// realpath comparison catches the silent failure mode where the symlink still
// points at an OLD workspace path after the project moved.
let linkOk = false
try {
  if (existsSync(NM_LINK)) linkOk = realpathSync(NM_LINK) === realpathSync(WORKSPACE)
} catch { linkOk = false }
log(`node_modules/${PKG_NAME} -> ${WORKSPACE}  (already correct: ${linkOk})`)

if (!linkOk) {
  if (APPLY) {
    mkdirSync(join(PROFILE, 'node_modules'), { recursive: true })
    try { unlinkSync(NM_LINK) } catch { /* nothing to remove */ }
    symlinkSync(WORKSPACE, NM_LINK, 'dir')
    must(realpathSync(NM_LINK) === realpathSync(WORKSPACE), 'symlink realpath mismatch after creation')
    log('symlink created and verified')
  }
}

// ── 4. profile cordis.patch.yml insert block ──────────────────────────────
const patch = readFileSync(PATCH_YML, 'utf8')
const hasBlock = /id:\s*zcode-native\b/.test(patch)
log(`cordis.patch.yml already has zcode-native insert: ${hasBlock}`)

if (!hasBlock) {
  if (APPLY) {
    copyFileSync(PATCH_YML, `${PATCH_YML}.bak-zcodenative-${STAMP}`)
    const block = [
      '',
      '# dsh-zcode-native — 自研 ZCode 接入（M0 骨架）',
      '- insert:',
      `    - id: zcode-native`,
      `      name: ${PKG_NAME}`,
      '      config:',
      '        debugPort: 9222',
      '        cacheMs: 15000',
      '',
    ].join('\n')
    writeFileSync(PATCH_YML, `${patch.replace(/\s*$/, '\n')}${block}`)
    log('profile cordis.patch.yml updated')
  }
}

console.log(APPLY ? '\nAPPLIED. 重启 DSH Desktop 后验证设置卡。' : '\nDRY RUN complete. 加 --apply 真执行。')
