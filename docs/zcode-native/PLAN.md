# dsh-zcode-native · 需求 + 计划合并稿（自研路线）

- 版本：v1（2026-10-25 18:05 +08:00）
- 工作区：`<repo>`
- 宿主：DSH Desktop **0.2.1-rc.2**，profile `web`，`DSH_HOME=$DSH_HOME`
- 目标客户端：ZCode `dev.zcode.app` **v3.16.3**（`/Applications/ZCode.app`），CDP 调试端口 9333
- 依据材料：`$TMPDIR/zcode-dsh-handoff-20261025.md`（10-25 交接）、`zcode-assets-20261025/handoff-zcode-bridge-20261025.md`（10-25 桥接治理交接）、`zcode-assets-20261025/tmp/zcode-src/`（社区插件 19 文件副本）、本轮实测（见 §2）

---

## 1. 路线决策

**坚持自研。** 社区插件 `dsh-zcode-connect`（`ZhaoAndy821/dsh-zcode-connector`）保留为**参考实现 + 运行期回退**，但不再作为最终形态；新插件命名为 **`dsh-zcode-native`**，在工作区内从零实现。

自研的三条硬理由（均有实测依据）：

1. **社区桥的取答路径在 macOS 上结构性失效**。`bridge/zcode-bridge.mjs` 的 `readMainTurnAnswer()` 只读 `~/.zcode/cli/rollout/model-io-sess_*.jsonl`；本机该目录**不存在**（`~/.zcode/cli` 只有 `db/ log/ plugins/`），`~/.zcode/cli/db/db.sqlite` 的 `session/message/part` 三张表**全为 0 行**。⇒ `zcode_ask` 必然等满 240s 超时。这已不是"Windows 版偶发超时"，而是"取答通道根本不存在"。
2. **社区插件的设置卡是死码**。它注册 `settings.plugin.item`，该 slot 在 0.2.1-rc.2 宿主里 **count = 0**（不存在）；正确席位是 `settings.section`（count = 33）。用户永远看不到它的设置页。
3. **方法 3a（原生子代理）社区插件完全没做**，且宿主已提供正规扩展点：`ctx.subagents.registerProvider(name, provider)`，`SubagentProvider` 契约含 `start()` / `prepareContinuable()` / `capabilities` / `inheritsParentContext`。自研可以直接注册一个 `zcode` provider，走 **CDP 驱动**而不是 `zcode.cjs --prompt` CLI。

**方法 3a 改走 CDP，不走 CLI。** 本轮实测 CLI 无头路径不可用（§2.6）：缺 provider 配置时报"无法定位 CLI ZCode Built-in Provider Config"；补齐后报 `Select a model before sending a message`，且 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 注入 `defaultModelSelection`（providerId 试过 `glm/bigmodel/zai/zcode/zhipu`，config 内嵌与根级两种写法）**全部无效**。CLI 路线降级为"可选探测"，不作交付依赖。

---

## 2. 已验证事实（本轮实测，2026-10-25 17:50–18:05）

| # | 事实 | 取证方式 |
|---|---|---|
| 2.1 | 社区插件当前**在线**：`/plugins/dsh-zcode-connect/status` 返回完整 JSON（cdp/account/grant/capabilities/runs/notes/installed 八段），`/panel` 200 且 22387 字节 | `curl 127.0.0.1:43129` |
| 2.2 | CDP 9333 可达，页面 `out/renderer/index.html`，`ZCode/3.16.3 Electron/41.0.3`；桥 9444 `healthz` = `{"ok":true,"inflight":0,"cdpPort":9333}`，监听在 DSH Desktop 进程树内 | `curl /json/version`、`/healthz`、`lsof` |
| 2.3 | 套餐：`zcode-v3-start-plan-1024`「ZCode 1024 Dev Day」**active**，`endsAt=1792976400` = **2026-10-26 09:00**；额度 GLM-5.3-Flash 300,000,000 + GLM-5.3 200,000,000 token | status JSON |
| 2.4 | `balance` 端点固定 400 `{"code":3001,"msg":"parameter error"}`，`balancesSource=unavailable` ⇒ **余额只能从 client 侧读，不能查 API** | status JSON |
| 2.5 | `capabilities.channels = []`（catalog 读到了 21 个 template，但"当前已加载通道"解析为空）；`installed` 三项全空 | status JSON |
| 2.6 | CLI 无头不可用（三条证据链见 §1） | `zcode.cjs --prompt` 实测 6 次 |
| 2.7 | **CDP 读 DOM 可行**：`Runtime.evaluate` 一次拿到 `body.innerText`（184 字符）、25 个按钮文案、`[contenteditable]` 计数=1。当前界面：模型标签 `GLM-5.3-Flash 最高`、按钮含 `发送/选择项目/新建任务/设置`，工作区 `~/.zcode/workspace/default` | 自写 `cdp-read.mjs` |
| 2.8 | `~/.zcode/cli/rollout` **不存在**；`~/.zcode/v2/tasks-index.sqlite` 的 `tasks` 仅 2 行且 `title=''`、`workspace_path=~/.zcode/workspace/default`；`task_groups/projects/project_roots` 均 0 行 | sqlite 只读 |
| 2.9 | 宿主 `SubagentProvider` 契约：`{name, capabilities{agentOptions,agentPreset,outputSchema,depthLimit}, inheritsParentContext, agentRunDefaults?, start?, prepareContinuable?}`；注册 API `ctx.subagents.registerProvider(name, provider)`（重复注册抛 `DUPLICATE_PROVIDER`） | asar 字节扫描 |
| 2.10 | `tool-subagent` 配置字段：`provider`(required) / `toolName` / `agentPreset` / `allowedAgentPresets` / `maxDepth` / `agentOptions` ⇒ 自研 provider 只要注册成功，配一行 `tool-subagent` 就能得到 `subagent_zcode` 工具 | asar 字节扫描 |
| 2.11 | 宿主 slot 计数：`sidebar.right.pane.tab`=70、`sidebar.right.pane.tab.title`、`settings.section`=33、`settings.plugin.item`=**0** | asar 字节扫描 |
| 2.12 | `zcode.cjs` 支持：`--prompt / --json / --cwd / --mode(build|edit|plan|yolo|guarded) / --resume / -c / --surface / --attach / --disallowed-tools / --workflow-mode / app-server / doctor` | `--help` |

### 2.13 · 派活通道已端到端打通（本轮实测 3 次，2026-10-25 18:01–18:06）

用户已解除"禁止主动调用"硬规则。三次真实 ask 全部成功，**取答走 CDP DOM，不走 rollout**：

| 次序 | prompt | 结果 | 耗时 |
|---|---|---|---|
| 1 | 只回复两个字：可用 | `可用` | ~3 s |
| 2 | 用一句话说明你当前打开的工作目录路径是什么 | `当前打开的工作目录是 ~/.zcode/workspace/default。` | ~2 s |
| 3 | 只回复三个字：通道通 | `通道通` | 6.05 s（含稳定采样） |

**确认的 DOM 契约（自研版必须照这个写）**：

| 元素 | 选择器 | 备注 |
|---|---|---|
| 输入框 | `[contenteditable="true"]`（全页仅 1 个，646×40） | `execCommand('selectAll')` + `('delete')` 可清空；`Input.insertText` 可逐字写入 |
| 发送按钮 | `button` 且 `innerText.trim() === '发送'` | 生成中该按钮文案变为「停止生成」，`.disabled` 变化不可靠 |
| 回合容器 | `[class~="group/assistant-turn"]` | **必须用 `class~=` 精确 token 匹配** |
| 答案节点 | `[class~="group/assistant-row"]`（回合内最后一个） | `innerText` 即答案纯文本 |

**踩坑（已修正，写入自研实现约束）**：用 `[class*="assistant-turn"]` 子串匹配会**同时命中工具栏** `group-hover/assistant-turn:opacity-100`（其 class 里也含该子串），导致"取最后一条"取到工具栏、`innerText` 为「复制 赞 踩 分叉 18:01」。第 2 次 ask 因此误报 `ok:false`，而 ZCode 侧任务其实成功——**这正好复现了社区桥"超时≠失败"的同类误判**。判据必须用 `class~=` 精确 token。

**完成判定（实测有效）**：`停止生成/工作中` 出现 → 消失，且最后一条 `assistant-row` 文本连续 2 次采样（1000 ms 间隔）不变。首次 ask 从点击到稳定约 3 s；批量短答可预期 2–7 s，远快于社区桥宣称的 240 s 超时。

**输入校验必要**：发送前回读 composer 与原文逐字比对（本轮 3/3 命中），不匹配即中止、不发送。

**探针脚本已入库**：`probe/ask-cdp.mjs`（完整 ask 流程，可复用）、`probe/inspect.mjs`（只读 DOM 状态）。

---

## 3. 需求（合并后，按优先级）

### P0 · 必须

- **R1 状态与额度看板**：侧边栏 tab + 设置页卡片，显示 账号 / plan 名称与到期时间 / 剩余额度 / 客户端版本与 CDP 状态 / 桥状态 / 最近活动。余额缺失时必须显式显示"不可用（端点 3001）"而不是 0。
- **R2 派活通道（ask）**：把一段自包含 prompt 送进 ZCode 并**取回答案**。取答必须走 **CDP DOM**（§2.7 已验证），不得依赖 `~/.zcode/cli/rollout`（§2.8 证明不存在）。
- **R3 完成判定**：不得用"固定超时"当完成信号。判据优先级：①发送按钮从"停止生成"回到"发送" ②答案文本连续 N 次采样稳定 ③ZCode 应用日志（`~/.zcode/v2/logs/YYYY-MM-DD.log`）出现本轮结束事件。超时必须返回"未完成 + 当前已抓到的文本"，不能返回空。
- **R4 原生子代理**：注册 `zcode` SubagentProvider（`start()` 一次性执行 + 返回 `SubagentRun`），配 `tool-subagent` 暴露 `subagent_zcode`；`inheritsParentContext=false`（每次新对话，prompt 必须自包含）。能力位如实声明：`agentOptions:false, agentPreset:false, outputSchema:false, depthLimit:false`。
- **R5 工具治理**：`install_mcp`（可写任意 command 到 `~/.zcode/cli/config.json`，安全审计定为 High）**默认不暴露**；如要保留，必须走白名单 + 显式开关。社区版 8 工具全开的状态不继承。

### P1 · 应该

- **R6 设置页用正确席位**：`settings.section`，不再用不存在的 `settings.plugin.item`。
- **R7 只读优先**：状态类调用免费、可高频；派活类串行、计费、必须用户显式触发（不自动重试、不自动重发）。
- **R8 单通道**：自研后**不再同时**挂 MCP server 与原生工具。优先原生（RPC + subagent），MCP 仅在"外部客户端也要用"时再补。

### P2 · 可选

- **R9 会话续接**：`--resume sess_...` / `-c` 语义在 CDP 路线下等价于"不点新建任务"，需先验证桥是否可安全复用同一对话。
- **R10 派活前置检查**：项目目录、完全访问权限、通知开启——沿用 `zcode-dispatch-checklist` 的四步前置，做成插件内的软提示。

### 明确不做

- 不伪造 `X-Aliyun-Captcha-Verify-Param` 直连 `zcode.z.ai/api/v1/zcode-plan/anthropic`（3007 已实测）。
- 不改 ZCode 二进制、不注入证书、不代理其流量。
- 不把账号 token 回显、写日志或放进任何响应。
- ~~不在未获用户明确指示时自动调用派活通道~~ → **2026-10-25 18:00 用户已解除该硬规则**。新约束：派活必须由模型显式发起、串行、不自动重试；每次 ask 前回读校验 composer；仍禁止无意义重复派活（额度有限且 10-26 09:00 到期）。

---

## 4. 架构

```
DSH Desktop (profile web)
└── dsh-zcode-native
    ├── host 半边  lib/index.js
    │   ├── ctx.subagents.registerProvider('zcode', provider)   ← R4
    │   ├── loopback 路由 /plugins/dsh-zcode-native/{status,panel,ask}
    │   └── cdp.js   CDP 连接、DOM 快照、输入与发送、取答          ← R2/R3
    ├── client 半边 lib/client.js
    │   ├── sidebar.right.pane.tab   看板 tab                     ← R1
    │   └── settings.section         设置卡（正确席位）             ← R6
    └── cordis.patch.yml
```

与社区版的三个结构性差异：

| 维度 | 社区版 | 自研版 |
|---|---|---|
| 取答 | 读 `~/.zcode/cli/rollout`（本机不存在） | CDP DOM 快照 + 稳定性判定（**已实测 3/3 成功**） |
| 选择器 | — | `[class~="group/assistant-turn"]` 精确 token（子串匹配会命中工具栏） |
| 进程 | 额外常驻 `zcode-bridge.mjs`（9444） | 无独立桥进程，host 内直连 CDP |
| 子代理 | 无 | `ctx.subagents.registerProvider` 原生接入 |
| 典型耗时 | 240 s 超时（结构性） | 2–7 s 拿回答案 |

---

## 5. 里程碑

| 里程碑 | 内容 | 完成判据 |
|---|---|---|
| **M0** 骨架可加载 | `package.json`（`exports` 含 `./cordis.patch.yml`）、`cordis.patch.yml`、`lib/index.js`（`console.log` 打点）、`lib/client.js`（`settings.section` 一张空卡） | GUI 里**肉眼**看到设置卡 = 整条装配链反证通过（日志不可作判据） |
| **M1** 只读状态 | `lib/cdp.js` 连 9333 + `lib/status.js` 采集（账号/plan/余额/版本/桥）；`/status` 路由返回 JSON | `curl /status` 字段与社区版一致或更全；余额不可用显式标注 |
| **M2** 看板 | 侧边栏 tab 渲染 M1 数据，含到期倒计时与"余额不可用"文案 | 侧边栏 tab 出现且数字正确 |
| **M3** 派活闭环 | `lib/ask.js`：清空输入框 → 逐字校验 → 发送 → 稳定性取答 → 返回文本；`/ask` 路由 | 一次真实 ask 拿回正确答案（不再是空/超时）；**不重发** |
| **M4** 原生子代理 | `lib/provider.js` 实现 `SubagentProvider.start()`；patch 里加一行 `tool-subagent` | DSH 里 `subagent_zcode` 工具可用，一次委派成功返回 |
| **M5** 退役社区版 | 移除 `dsh-zcode-connect` 依赖/bundle/symlink 与 MCP `zcode` 条目；补迁移说明 | 重启后无 zcode 相关告警，自研插件全功能在线 |

---

## 6. 待办（可直接执行）

见 §6.1–6.5 分组。编号用于任务板认领。

### 6.1 T0 · 决策与边界（已完成 1 项）

- ~~**T0-1** 确认"派活通道默认禁用"的规则是否解除~~ → **已完成 2026-10-25 18:00，用户明确解除**。三次真实 ask 已跑通（§2.13），M3 的验收前置条件不再阻塞。

### 6.2 T1 · 骨架（M0）

- **T1-1** 建 `package.json`：`name: dsh-zcode-native`、`type: module`、`exports` 必须含 `"." / "./client" / "./cordis.patch.yml" / "./package.json"`、`dsh.bundle.patch`、`dsh.client.inject`（`dsh-client-runtime` / `dsh-client-ui-slots` / `dsh-client-ui-settings` / `dsh-client-ui-sidebar-right`）、peer 只声明 `@deepseek-ai/cordis` `@deepseek-ai/schemastery` `react`。
- **T1-2** `cordis.patch.yml`：单条 `insert`，`id: zcode-native`，config 字段 `debugPort(9333)` / `cacheMs(15000)` / `askTimeoutMs(240000)` / `enabledTools`。
- **T1-3** `lib/index.js`：`export const name` / `export const inject = []` / `export const Config`（schemastery）/ `apply(ctx, config)`，用 **`console.log('[zcode-native] loaded')`** 打点（`ctx.logger.info` 不进 harness.log）。
- **T1-4** `lib/client.js`：`ctx.slots.inject('settings.section', ...)` 注册一张空卡，`label` 用函数形式。
- **T1-5** 挂载：`profiles/web/package.json` 加 `"dsh-zcode-native": "link:<工作区>"` + `dsh.profile.bundles` 追加；`pnpm install`（用 `$DSH_HOME/.desktop-bin/pnpm`）；**手动建** `profiles/web/node_modules/dsh-zcode-native` symlink；`cordis.patch.yml` 加 insert 块。
- **T1-6** 重启 DSH Desktop，肉眼确认设置卡出现（这是 M0 唯一有效判据）。

### 6.3 T2 · 只读采集（M1/M2）

- **T2-1** `lib/cdp.js`：`attach()`（`/json/list` 选 `renderer/index.html`）、`evaluate(expr)`、`snapshot()`、`dispose()`；只连 `127.0.0.1`。
- **T2-2** `lib/status.js`：复用社区版已验证的采集口径（`~/.zcode/v2/credentials.json` 取账号 id/username，`~/.zcode/v2/setting.json` 取 provider 家族，`~/.zcode/v2/runtime/provider/<plat>/<ver>/endpoint-*/zcode-builtin.json` 取 catalog，plan/billing 走 `zcode.z.ai` 单点）。**token 只作 Bearer，不回显/不落日志/不进响应**。
- **T2-3** 余额：端点 3001 时返回 `{available:false, reason:'3001 parameter error'}`，不猜 0。
- **T2-4** `/status` 路由：`kind:'exact'`、loopback 校验、`cache-control: no-store`。
- **T2-5** `lib/panel.js` 或 client 侧 tab：侧边栏 tab 渲染账号/plan/到期倒计时/额度/客户端版本/桥状态。
- **T2-6** 单测：`status` 的纯函数部分（畸形 JSON、缺字段、token 泄漏断言）零依赖可裸跑。

### 6.4 T3 · 派活（M3）— **选择器与流程已实测，照 §2.13 抄**

- **T3-1** `lib/ask.js` 输入链路：`[contenteditable="true"]`.focus() → `execCommand('selectAll')` + `execCommand('delete')` → `Input.insertText` → **逐字回读校验**（实测 3/3 通过；不匹配即中止不发送）。
- **T3-2** 发送：`button` 且 `innerText.trim() === '发送'`，`.click()`。发送前确认模型标签（当前 `GLM-5.3-Flash 最高`）在 Start Plan entitlement 内。
- **T3-3** 取答：`[class~="group/assistant-turn"]` 取最后一回合 → 其内最后一个 `[class~="group/assistant-row"]`.innerText。**必须 `class~=` 精确 token**；`class*=` 会命中工具栏 `group-hover/assistant-turn:opacity-100`（已踩坑）。完成判据：`停止生成/工作中` 出现后消失 + 文本连续 2 次采样（1000 ms）不变。
- **T3-4** 完成信号兜底：读 `~/.zcode/v2/logs/<today>.log`；**不要**读 `~/.zcode/cli/rollout`（不存在）。
- **T3-5** 超时语义：返回 `{status:'timeout', partialText, elapsedMs}`，**绝不重发**。注意：取答失败 ≠ 任务失败（第 2 次 ask 就是选择器 bug 导致误报，ZCode 侧实际已成功）。
- **T3-6** 串行化：进程内队列，同一时刻只允许一个 ask（ZCode 只有一个输入框）。
- **T3-7** `/ask` 路由：POST + JSON body，`maxBodyBytes` 64 KiB，`method !== endpoint` → `gateway/bad-request`。
- **T3-8** 参考实现：`probe/ask-cdp.mjs`（已跑通，含输入校验、发送、稳定性取答、回合计数），直接搬进 `lib/ask.js` 即可。

### 6.5 T4 · 原生子代理（M4）

- **T4-1** `lib/provider.js`：实现 `{ name:'zcode', capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false}, inheritsParentContext:false, start(request) }`，内部调 T3 的 ask，把结果包成 `SubagentRun`（`{id, result:Promise<SubagentResult>, dispose}`），`output` 用 `[{type:'text', text}]`。
- **T4-2** `cordis.patch.yml` 加 `tool-subagent` 行：`provider: zcode` / `toolName: subagent_zcode` / `maxDepth: provider-managed`。
- **T4-3** 契约核对：`start()` 必须能处理 `signal` 取消；`dispose()` 幂等。
- **T4-4** 端到端：DSH 里调 `subagent_zcode`，一次委派成功返回非空结果。

### 6.6 T5 · 退役与收口（M5）

- **T5-1** 从 `profiles/web/package.json` 删 `dsh-zcode-connect` 依赖与 bundles 项，删 symlink，删 `cordis.patch.yml` 的 `zcode-connect` insert 块（改前先按 `mem-skill-dsh-patch-0451a4771501` 查 patch 纪律）。
- **T5-2** `$DSH_HOME/@wingsky-1/dsh-mcp-manager/mcp.json` 移除 `zcode` server（若 R8 定为原生单通道）。
- **T5-3** 写 `docs/zcode-native/MIGRATION.md`：社区版 → 自研版的字段映射与回退步骤。
- **T5-4** 回归清单：设置卡可见、侧边栏 tab 可见、`/status` 200、一次 ask 成功、一次 `subagent_zcode` 成功、无 token 泄漏。

---

## 7. 约束与风险

| 风险 | 影响 | 处置 |
|---|---|---|
| **Dev Day 额度 2026-10-26 09:00 到期**（距本稿约 15 小时） | 之后 ask 报上游 1113/余额不足 | M3/M4 验收**必须赶在到期前**或先续期；到期后 M1/M2 只读部分不受影响 |
| 派活硬规则未解除 | M3/M4 无法验收 | 见 T0-1，等用户明确授权 |
| ZCode 更新覆盖 CDP 参数 | 9333 消失 | 启动脚本兜底；`/status` 显式报 `cdp.reachable=false` |
| DOM 选择器随版本变化 | 取答失效 | 选择器集中在一个模块 + 回退到 `body.innerText` 文本启发；UI 变化只改一处 |
| cwd 漂移 | 派活写错目录 | prompt 里写绝对路径；`/status` 暴露当前 workspace 路径 |
| 社区版仍在线 | 双写同一 9444/9333 | M5 前两者可共存（端口不冲突），M5 退役社区版 |
| 余额端点 3001 | 看板缺余额 | 显式"不可用"，从 client 侧日志兜底 |

---

## 8. 参考（不复抄）

- 社区插件源码副本：`zcode-assets-20261025/tmp/zcode-src/`（19 文件，含 `lib/status.js` 采集口径、`lib/provision.js` 白名单、`bridge/zcode-bridge.mjs` CDP 手法）
- 桥接治理交接：`zcode-assets-20261025/handoff-zcode-bridge-20261025.md`
- 派活前置规程：`zcode-assets-20261025/skills/zcode-dispatch-checklist/SKILL.md`
- 同工作区先例：`../amd-model-load`（M0–M1 骨架、`settings.section` 判据、`exports` 硬要求、RPC 通道照抄 `dsh-pause`）
- 插件契约记忆：`amd-model-load/MEMORY.md`（`settings.plugin.item` 不存在、`slots.inject` 静默等待、`ctx.logger.info` 不进日志、HMR 时序假阳性）
