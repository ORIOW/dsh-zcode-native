# dsh-zcode-native · M3 完成说明

日期：2026-10-25。范围：派活闭环 —— POST /ask 把 prompt 送进 ZCode GUI 并取回答案。全部单测 mock，未真调 ZCode；端到端验证由人工用真实 CDP 执行。

## 文件清单（行数）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `lib/ask.js`（新增） | 242 | ask 状态机 + 模块级串行队列 + 导出的页面表达式（expr）与 AskError |
| `lib/index.js`（改造） | 143 | 新增 POST `/plugins/dsh-zcode-native/ask`（exact），Config 增加 askTimeoutMs=600000 |
| `lib/cdp.js`（加法改动） | 196 | CdpSession 增加公开 `send(method, params)`（ask 需要 `Input.dispatchKeyEvent` / `Input.insertText`，原 evaluate 只走 Runtime.evaluate）；已有 evaluate/snapshot/dispose 未动 |
| `test/ask.test.mjs`（新增） | 233 | 8 例全 mock |
| `test/host-route.test.mjs`（最小必要修改，见下） | 133 | 拷贝清单加 ask.js；路由数断言 1→2 |

## ask 状态机（六步，实测契约）

1. **前置检查**：CDP probe —— `停止生成`/`工作中` 按钮存在 → `AskError('busy')`，不抢占；记录 `before = [class~="group/assistant-turn"]` 数量。
2. **清空输入框**：focus 后用 `Input.dispatchKeyEvent` 发 Cmd+A（darwin modifiers=4，其余 Ctrl=2）+ Backspace（execCommand 实测无效）；随后断言 `innerText.trim() === ''`，残留 → `clear-failed`。
3. **写入并逐字校验**：`Input.insertText` 写入 prompt，回读必须与 prompt 完全相等，否则 `verify-failed`，绝不发送。
4. **发送**：找 `innerText.trim() === '发送'` 的 button 并 `.click()`；轮询最多 20s（newTurnTimeoutMs）等回合数 > before，否则 `no-new-turn`（没有新回合 = 没发出去，绝不读"最后一个回合"）。
5. **取答**：按索引取 `turns[before]`（不是最后一个），答案 = 该回合内最后一个 `[class~="group/assistant-row"]` 的 `innerText.trim()`；全部用 `class~=` 精确 token 匹配（`class*=` 会命中 `group-hover/assistant-turn:opacity-100`）。完成判据：停止生成出现过后消失 + 文本连续 2 次采样（间隔 1000ms）不变；**修正**：若生成在两次采样之间就结束（从未捕到停止按钮），以"该回合可见 ≥2s 且文本稳定"补位，否则快速回答会一直挂到超时。超时（askTimeoutMs，默认 600000ms）返回 `{ status:'timeout', partialText, elapsedMs }`，绝不重发。
6. **串行化**：模块级 promise 队列，同一时刻只有一个 ask 在驱动唯一的输入框；后续调用排队等待。

## 路由（POST /plugins/dsh-zcode-native/ask）

- 只允许 POST（405）；只允许 loopback（复用 isLoopback，403）
- 请求体 JSON `{ prompt }`，上限 64 KiB，超限 413 + `req.destroy()`
- prompt 非空字符串否则 400
- 成功/超时返回 200 + `{ status:'ok'|'timeout', answer?/partialText?, elapsedMs }`；AskError 返回 200 + `{ status:'error', error:'<code>: <msg>' }`（调用方读稳定错误码）
- 响应头 `cache-control: no-store`（复用 send）

## mock 掉的真实依赖

- **CDP 会话**：`deps.attachCdp` 注入假 cdp —— evaluate 按 `expr.probe/focus/composerText/clickSend/turnCount` **恒等匹配**分发，sample 表达式按 `group/assistant-row` 识别并用正则取回索引；send 记录 `Input.dispatchKeyEvent`/`Input.insertText` 并驱动假 composer/回合状态（可脚本化：清空失败、篡改插入、不增回合、流式生成、永不完成）。
- **时钟**：`deps.now`/`deps.sleep` 假时钟（sleep 同步推进），超时/轮询路径瞬时跑完。
- **串行化测试**：第一次 ask 的 attachCdp 挂在可控 gate 上，断言第二次调用不 attach；release 后断言 attach#2 发生在 done#1 之后。

## 测试结果（node --test test/*.mjs）

```
tests 32  pass 32  fail 0
```

新增 8 例：busy 不抢占 / clear-failed 不发送 / verify-failed 不发送 / no-new-turn（点击恰好 1 次）/ 正常路径按索引取答（埋了 TRAP-LAST-TURN 陷阱回合）/ timeout 带 partialText 且不重发（sendClicks===1）/ 串行化顺序 / 空 prompt 400。

## 对既有测试的必要修改（报告）

任务要求不改 test/，但 host-route.test.mjs 与本任务天然冲突两处，做了最小修改：
1. 临时目录拷贝清单加 `ask.js`（index.js 新 import 了它，不拷则模块加载直接失败）；
2. `routes.length === 1` 断言改为 2 并补充 /ask 路径断言（任务要求加第二条路由）。其余 18 条断言原样保留、全部通过。

> **2026-11-01 修订**：第 5 步「按索引取 `turns[before]`（不是最后一个）」已被证伪——
> ZCode 会在新回合生成期间卸载旧回合，渲染数在 3–5 间浮动，索引地址会越界。现行实现改为
> 读**最后一个 turn**，见 `docs/zcode-native/M4-DONE.md` 第 7 节。
