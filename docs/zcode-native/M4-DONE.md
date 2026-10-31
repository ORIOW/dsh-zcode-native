# dsh-zcode-native · M4 完成说明

日期：2026-11-01。范围：把 ZCode 注册成 DSH 的原生子代理后端（`subagent_zcode`），
在宿主里端到端派活成功；并把「取消」从「只结算调用方」修成「真的停下 ZCode 侧生成」。

## 文件清单（行数）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `lib/provider.js` | 193 | `ZcodeSubagentProvider`：`start(request)` → `{ id, result, dispose }`；`result` 永不 reject；父子 signal 汇流 |
| `lib/ask.js`（本轮修改） | 337 | 新增 `expr.clickStop` / `expr.isBusy` 与 `stopGeneration()`；abort / timeout 三条出口都先停再返回 |
| `test/provider.test.mjs` | 212 | provider 契约 12 例（能力、结算映射、abort 传播、dispose 幂等、诊断收敛） |
| `test/ask.test.mjs`（本轮修改） | 302 | 新增 abort 用例；timeout 用例补「也停掉」断言 |

## 1. 注册与派活（宿主内验收）

- 入口是 **`ctx.subagents.registerProvider(provider)` —— 单参数**；`lib/index.js` 在
  `ctx.effect` 里注册，重启后 harness.log 出现 `[zcode-native] loaded`。
- 宿主工具列表里出现 `subagent_zcode`，说明 provider 注册链路通了。
- 派活前跑 `node probe/guard-9222.mjs` 做前置检查，实测输出
  `{"headerText":"make zcdoe plugin编码任务","composerText":"","hasStop":false}`：
  ZCode 停在目标任务、输入框为空、当前没在生成。
- **端到端验收**：`subagent_zcode` 派「读 package.json 只回复 version」，父代理收到的
  完成通知正文恰为 `0.1.0`，与 `package.json` 的 `"version": "0.1.0"` 一致。
  工具返回值（`started subagent zcode-…`）本身不算验收，结算消息才算。

## 2. 取消语义：实测到的缺陷

派活后调 `dispose()`，调用方侧「看起来正确」，ZCode 侧并没有停：

```
dispose() 返回 299ms，stopReason: 'aborted'，output: []
post-dispose 采样 0.3s…9.3s（10 次）：hasStop 全为 true，文本 0 增长
dispose 后约 4 分钟再查：hasStop 仍为 true
```

根因在 `lib/ask.js` 的读循环：`signal?.aborted` 分支直接 `return { status:'aborted' }`，
**没有任何点击 `停止生成` 的动作**，timeout 分支同样只返回不停。后果有两层：被弃的
generation 一直空转烧 token；更重要的是它会让**之后每一次 ask 在 pre-flight 撞 `busy`**，
等于永久卡死。这与项目目标「abort/dispose 能真正停下 ZCode 侧」直接冲突。

## 3. 修复

- `expr.clickStop`：找 `innerText.trim()` 匹配 `^(停止生成|停止)$` 的 button 并 `.click()`，
  没有则返回 `false`；`expr.isBusy` 复用 `busyOf`（`停止生成`/`工作中`）。
- `stopGeneration(cdp, evaluateTimeoutMs, { sleep, now })`：先点停；点了才在
  `STOP_BUDGET_MS = 4000` 预算内按 `STOP_POLL_MS = 250` 轮询 `isBusy`，直到变 `false`。
  全程 `try/catch` 吞错 —— **取消永不 reject、永不超预算**：界面已经变了也不该把
  一次取消变成异常。
- 接线三处：send-wait 的 abort、读循环的 abort、读循环的 deadline（timeout）。
  timeout 也停的理由：超时之后没有人会再读这段输出，而活着的 generation 会让下一次
  ask 撞 `busy` —— 与 abort 是同一缺陷类，按 owner 原则一起修。
- 模块头注释补第 6 步 `release`，把「取消 = 先停 ZCode」写成契约。

## 4. 复验（真实 ZCode 3.17.1，非 mock）

两条路径都是真 CDP 驱动，脚本跑完即弃（`/tmp` 下，不是仓库产物）：

| 路径 | 结算 | dispose/settle 耗时 | 之后 `hasStop` | 紧接着再派活 |
| --- | --- | --- | --- | --- |
| `ask({ signal })` 2.5s 后 abort | `status:'aborted'`，partialText 非空 | 3567ms | 首个 +0.5s 采样即 `idle` | `ok`，`OK`，3315ms |
| `provider.start()` 2.5s 后 `dispose()` | `stopReason:'aborted'`，output 空 | 1058ms | 首个 +0.5s 采样即 `idle` | `ok`，`OK`，4323ms |

「紧接着再派活成功」是关键断言：它证明没有留下 `busy` 死锁，而修复前必然卡死。

## 5. 测试

```
node --test test/host-route.test.mjs test/ask.test.mjs test/status.test.mjs \
  test/client-envelope.test.mjs test/provider.test.mjs
# tests 50 / pass 50 / fail 0
```

新增用例 `abort: asking ZCode to stop is part of cancelling, not just settling`：
断言 `status==='aborted'`、`stopClicks===1`、`busy===false`、`disposed===1`；
timeout 用例补 `stopClicks===1` 与 `busy===false`。假 CDP 的 `clickStop` 会真的把
`busy` 置 false，所以「只结算不停」这个旧行为无法再通过测试。

## 6. 待做

- **宿主需重启一次**才能加载修复后的 `lib/ask.js`（host 半身不热重载）。重启后可在
  宿主内派长任务再取消，复验「子代理在父代理侧消失 + ZCode 停止生成」。

## 7. 第二轮修复（2026-11-01 00:32）：新回合检测不能再按索引/计数

重启后宿主内第一次派活就失败：`zcode: no-new-turn: no new assistant turn within
20000ms — the prompt was not sent`，而手工发送链路（focus → insertText → 点击发送）
在同一时刻是通的；直接调 `ask()` 也以 `ok / 0.1.0 / 4314ms` 正常返回。

真实原因出在「怎么认出新回合」。旧实现把点击前的 `turns` 计数记成 `before`，发送后用
`turnsAfter > before` 判定已发送，再用 `turns[before]` 作为读答案的地址。而实测 ZCode
渲染出的 assistant-turn 数量在同一段对话里会在 **3–5 之间浮动**（生成中 / 被点停后都会
少渲染，本机连采 8 次空闲态才稳定在 5）。于是：

- 计数回落时，`turnsAfter > before` 永远假 → 报 `no-new-turn`（宿主内见到的失败）；
- `turns[before]` 越界 → `present:false`，读循环空转到 `askTimeoutMs`（默认 600000ms），
  期间占住 `lib/ask.js` 的模块级 `queue`，并让宿主子代理池的三个激活槽位一直被占满
  （`subagent limit reached (active child limit: 3)`）。

修法（`lib/ask.js`）：不再用索引/计数当地址。

- `expr.probe` 额外返回 `lastText`（点击前最后一个 turn 的文本，作基线）；
- `expr.lastTurn` 返回最后一个 turn 的 `{ present, turns, text, busy }`；
- 发送判定改为「busy 出现 / 计数增长 / 最后一个 turn 的文本离开基线」三者之一；
- 读答案改为读最后一个 turn，并在「没捕到 busy 且文本仍等于基线且计数没涨」时明确跳过
  （防止把点击前那条答案当成本次答案）。

测试 51/51。新增用例 `a shrinking turn list must not read as "not sent" or hang the
read`：假 CDP 在发送时移除最早一个 turn（计数不增长，模拟真实卸载），旧实现会报
`no-new-turn`，新实现仍拿到 `REAL-ANSWER`。

真机复核（未重启宿主，直接用磁盘上的新 `lib/ask.js` 调 `ask()`）：
`pre: {"busy":false,"hasComposer":true,"turns":5,"lastText":"0.1.0"}` →
`{"status":"ok","answer":"0.1.0","elapsedMs":4314}`。

宿主仍需再重启一次，这次修复才会在 `subagent_zcode` 链路里生效。

## 8. 第四处修正：会话身份（ZCode 被切到别的项目）

用户在 ZCode 里**同时开着多个项目的会话**，而 composer 永远属于当前可见的那一个。
实测（2026-11-01）：prompt 插进去的瞬间用户切到了另一个工作区的会话，于是这条 child
的答案是「本项目根目录（工作区）是空的，不存在 package.json」——对一个确实有
`package.json` 的工作区。插件这边看不到任何异常：pre-flight 通过、发送通过、读到了
一个稳定文本，`ask()` 以 `ok` 结算。

修法（`lib/ask.js`）：

- 新增 `headerOf` 表达式，取拖拽区里那个项目名标题（`app-region:drag`、高 40–60、
  宽 > 600 的那个 div）——这是 ZCode 唯一稳定暴露的会话身份；
- `expr.probe` 与 `expr.lastTurn` 都带上 `header`；
- 新增 `assertSameSession(headerBefore, observed)`：发送前记下 header，发送后每次采样
  都比对，不一致立刻抛 `AskError('session-changed')`，不再读别的项目的 turn，也不
  再空转到 `askTimeoutMs` 把宿主槽位占死；
- **不点** `停止生成`：切换之后那个按钮属于用户在另一个会话里的活儿，不该由插件点。

测试 52/52。新增用例 `a session switch mid-ask fails fast instead of reading another
project`：分别在「发送瞬间切换」和「读答案过程中切换」两种时序下断言
`session-changed`、且 `stopClicks === 0`。

真机复核：`expr.probe` 在真实页面上返回
`{"busy":false,"hasComposer":true,"turns":3,... ,"header":"读取 package.json 的 version 字段"}`
——当前 ZCode 停在**另一个会话**，其工作区是
`/Users/dengjiawei/.zcode/workspace/draft-de9961b6-.../`（空目录），所以那条 `ok` 回答
讲的是「工作区为空」。这正好印证了本节的问题。

派活前请确认 ZCode 停在目标任务的那个会话上（`node probe/guard-9222.mjs` 的
`headerText` 就是它），并在 child 跑完之前不要切走。这是**用户侧的使用前提**，插件无法
推断「你想问哪个项目」；它能做的是发现中途被切走时立刻失败，而不是拿错答案当结果。

## 9. 宿主内终验（2026-11-01 01:07 加载的版本）

加载确认：harness.log 新的 `[zcode-native] loaded` = `2026-10-31T17:07:39.285Z`（本地
01:07:39），晚于 `lib/ask.js` 的 mtime `2026-11-01T00:49:28`。`probe/guard-9222.mjs`
报 `headerText` = `make zcdoe plugin编码任务`、`composerText` 空、`hasStop:false`。

派活（验收标准是父代理收到的结算文本，不是工具返回值）：

| 顺序 | child | 结算文本 | 说明 |
| --- | --- | --- | --- |
| 1 | `zcode-73c661a4` | `0.1.0` | 与 `package.json` 的 `"version": "0.1.0"` 一致 |
| 2 | `zcode-09c00351` | `0.1.0` | 连续派活，未出现槽位耗尽 |
| 3 | `zcode-54401fd7` | `1 … 5000` 完整 | 长流没有被提前判成"已完成" |

第 1 次派活时真实撞上了缺陷 3 的场景：派出后 DOM 是 7 个 assistant-turn、新的那个还是
空的、`busy:true`；结算后变成 6 个——最早的回合被 ZCode 卸载了。旧实现要么在这里报假
`no-new-turn`，要么按 `turns[before]` 读到一个已经消失的索引然后空转到 600 秒；新实现
读最后一个 turn，一次拿到 `0.1.0`。

发现一个问题：**外部后端子代理在 DSH 界面里没有可点的"停止"**（`subagent_zcode` 的
child 只显示已完成状态），所以宿主内无法用 UI 触发一次真实取消。取消语义因此按宿主
实际走的路径验证——`provider.start()` → 2.5s → `dispose()`，这正是 `ZcodeSubagentProvider`
被中止时宿主调用的那个方法：

```
result: {"stopReason":"aborted","disposeMs":1060,"output":0}
post-dispose busy samples: idle        # 0.5s 后 ZCode 侧已空闲
next ask: {"status":"ok","answer":"OK","elapsedMs":3320}
```

`dispose()` 1.06s 返回（其中含点 `停止生成` 与轮询），ZCode 侧在 0.5s 内 `hasStop` 变
false，紧接着的 `ask()` 正常完成——修复前这里是"4 分钟后 `hasStop` 仍为 true、下一次派活
撞 `busy`"。

M4 的四个验收点至此都有证据：派活结算、连续派活、真实输出不丢、取消真的停下 ZCode。

## 10. 可观测性：ask 生命周期日志

在这之前插件只打一行 `[zcode-native] loaded`，M4 排查全靠手写 DOM 探针：一次卡住的派活
（读循环空转到 600s、占住宿主激活槽位）在日志里完全没有痕迹。现在每次派活留两行：

```
[zcode-native] ask start port=9222 promptChars=42 waitedMs=0
[zcode-native] ask settled status=ok elapsedMs=4311 answerChars=5
```

- `waitedMs` 是排队时间，不是等 ZCode 的时间——它变大就说明前一条派活卡住了，这正是这次
  两次「不明原因的失败」的形态。
- 失败：`ask failed code=<busy|no-new-turn|session-changed|…> elapsedMs=… detail="…"`。
- 取消：额外一行 `ask release clicked=<bool> idle=<bool> elapsedMs=…`；`idle=false` 意味着
  点了 `停止生成` 但 ZCode 侧还在生成。
- prompt 与答案正文**永不进日志**，只记长度；`test/ask.test.mjs` 里有专门断言
  （`the prompt text must not be logged`）。
- 日志 sink 可替换（`setAskLogSink`），测试用它收集而不是污染 stdout。

测试 54/54。
