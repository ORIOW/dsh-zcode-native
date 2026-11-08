/**
 * Unit tests for lib/checklist.js — 第三条路（自动通道不可用时的人工清单）。
 *
 * 断言的是「这份文本真的能用」这一点：正文来自工作区技能 `.dsh/skills/
 * zcode-dispatch-checklist/`（去 frontmatter 的副本），里面那几个选择器与判据
 * 是踩过坑才写下的，被截断或被改写就等于把坑重新挖一遍。
 *
 * Run: node --test test/checklist.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CHECKLIST_HINT,
  DISPATCH_CHECKLIST,
  ZCODE_CHECKLIST_TOOL_NAME,
  checklistFor,
} from '../lib/checklist.js'

test('checklist: 正文是技能原文，不是摘要', () => {
  assert.match(DISPATCH_CHECKLIST, /^# ZCode 派活前的人工前置检查 \+ DOM 项目守卫/)
  assert.ok(!DISPATCH_CHECKLIST.startsWith('---'), 'frontmatter 必须已经去掉')

  // 这几条是踩过坑的判据，缺一条清单就失去意义。
  const markers = [
    'app-region:drag',            // 48px 标题条的识别方式
    'class~="group/assistant-turn"', // 必须用 class~= 而不是 class*=
    'turns[before]',              // 取本轮答案，不是最后一个回合
    '--remote-debugging-port=9222',
    'execCommand',                // 清 composer 的已知无效做法
    'no-new-turn',                // 发送未成功的判据
  ]
  for (const marker of markers) assert.ok(DISPATCH_CHECKLIST.includes(marker), `missing: ${marker}`)
  assert.ok(DISPATCH_CHECKLIST.length > 4000, '正文应完整（技能原文约 7.8KB）')
})

test('checklist: 工具名与提示语稳定', () => {
  assert.equal(ZCODE_CHECKLIST_TOOL_NAME, 'zcode_dispatch_checklist')
  assert.match(CHECKLIST_HINT, /zcode_dispatch_checklist/)
  assert.ok(CHECKLIST_HINT.trim().length > 20)
})

test('checklist: 抬头写清触发原因、试过的后端与那次诊断', () => {
  const guide = checklistFor({
    reason: ' CDP 端口 9222 拒绝连接 ',
    backend: 'zcode',
    diagnostic: 'zcode: zcode-not-running: ECONNREFUSED',
  })
  assert.match(guide, /^# ZCode 派活人工清单/)
  assert.match(guide, /触发原因：CDP 端口 9222 拒绝连接/)
  assert.match(guide, /先试过的后端：zcode/)
  assert.match(guide, /那次的诊断：zcode: zcode-not-running: ECONNREFUSED/)
  assert.ok(guide.includes(DISPATCH_CHECKLIST), '整份技能正文必须跟在抬头后面')
})

test('checklist: 不给上下文时仍然给出完整流程', () => {
  const guide = checklistFor()
  assert.match(guide, /^# ZCode 派活人工清单/)
  assert.doesNotMatch(guide, /触发原因/)
  assert.ok(guide.includes(DISPATCH_CHECKLIST))
  assert.ok(guide.endsWith('\n'), '结尾留一个换行，贴进回复不会黏下一段')
})

test('checklist: 把姊妹插件的工具名映射成本插件的，别让模型去找不存在的工具', () => {
  const guide = checklistFor()
  assert.match(guide, /`subagent_zcode`/)
  assert.match(guide, /`subagent_zcode_cli`/)
  assert.match(guide, /`zcode_launch`/)
  assert.match(guide, /`zcode_ask` 对应 `subagent_zcode`/)
  assert.match(guide, /`\/plugins\/dsh-zcode-native\/status`/)
})