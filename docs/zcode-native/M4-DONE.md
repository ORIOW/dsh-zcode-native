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
