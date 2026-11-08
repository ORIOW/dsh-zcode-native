# CLI 后端（替代 CDP）

ZCode 3.17.2 的打包版在 macOS 上关掉了 CDP：`--remote-debugging-port` 被拒（stderr `bad option`），
进程无任何监听端口，`app.asar` 里唯一开端口的分支在 `!isPackaged` 下（详见 `LAUNCH.md` 与 README 的
「已知限制」）。应用自带一个可以无头运行的 CLI，这是目前唯一还能自动化的通道：

```
/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs      # 15 MB，zcode 0.17.1
```

插件保留现有 CDP 后端，另加一条 CLI 后端，两条并存，由配置与 `/ask` 的 `backend` 选择。

## 七步与验收

| # | 内容 | 验收（可执行） |
|---|------|----------------|
| 1 | 打通 CLI 无头应答（spike） | `node <app>/Contents/Resources/glm/zcode.cjs -p "只回复 OK" --cwd <ws>` 输出 `OK`、退出码 0 |
| 2 | `lib/cli.js`：`discoverCli()` + `runCliPrompt()`，spawn/时钟全注入 | `node --test test/cli.test.mjs` 7 例全过（成功/非零退出/超时/abort/入口缺失/候选表/显式路径） |
| 3 | 输出解析与诊断（`-p` 文本，stderr 尾巴进 diagnostic） | 录制 fixture 解析测试 + 真机输出一致 |
| 4 | provider 接线：`zcode-cli` + 工具 `subagent_zcode_cli`，复用 `promptText` 与 `NO_START_CAPABILITIES` | 成功 → `completed`，abort → `aborted`，其它 → `error` + diagnostic |
| 5 | 配置与路由：`cliEnabled`(true)/`cliEntry`('')/`cliTimeoutMs`(600000)，`/ask` 增 `backend`（默认 `cdp`） | host-route 断言 2 个 provider、3 个工具，默认路由逐字节不变 |
| 6 | 文档：README「两条后端」+ `docs/zcode-native/CLI.md` | 文档里每条命令本机实跑 |
| 7 | 回归 + 宿主内终验 | 全套测试通过；重启后派 `subagent_zcode_cli` 的结算与直接跑 CLI 一致 |

## 硬约束（来自步骤 1 的实测与复核）

1. `zcode login`、`app-server`、`tui` 等子命令都需要 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`，否则报
   `无法定位 CLI ZCode Built-in Provider Config`。该文件在 `<app>/Contents/Resources/config/provider/zcode-builtin.json`。
2. 每次调用必须带 `--cwd <DSH 工作区>`，否则 CLI 用它自己的默认工作目录。
3. CLI 的模型选择是 `~/.zcode/v2/provider_config.json`（登录时会打印 `Model selection: …`），
   不是 `setting.json` 的 `providerFamilyConnectionSelections`，后者改了无效。
4. 插件**不写**用户全局凭据与模型选择（`credentials.json` / `provider_config.json`）。没登录就让 CLI 的
   原始错误浮出来（`Select a model before sending a message`）。
5. 共享 `~/.zcode/cli/db`，同一时刻只跑一个 CLI 进程；超时 ≥120 s。
6. 错误分类只认 stderr + 退出码，解析器要容忍 banner 与 ANSI。

## 账号前提（步骤 1 的真机验收卡在这里）

| 观察 | 事实 |
|------|------|
| CLI 里出现的 account provider | `individual-coding-plan`(5)、`start-plan`(7)、`team-coding-plan`(3)、`highspeed-card`(1)、`offpeak-idle-plan`(1) |
| CLI 里 `weekend` 字样 | 0 处 |
| `zcode login bigmodel` 之后 | `Model: account:bigmodel-individual-coding-plan/GLM-5.3` |
| 把 `provider_config.json` 的 `defaultModelSelection` 改成 `start-plan / GLM-5.3-Flash` | 主回合仍打 `individual-coding-plan / GLM-5.3` → `[1113] 余额不足` |
| 同期 `model_usage` 里 `start-plan / GLM-5.3-Flash → completed` | 桌面版发出的请求 |

结论：CLI 认识 `start-plan`，但登录态绑定 `individual-coding-plan`（无额度）。用户桌面用的
ZCODE WEEKEND BUILD（5 亿免费 token，走 `start-plan / GLM-5.3-Flash`）在 CLI 侧取不到。
**步骤 1 的真机验收受阻于账号，不在代码**；等账号侧能用周末套餐或换到有额度的套餐，再补一条
`-p "只回复 OK"` 的真机记录即可。

## 进度

- 步骤 1：接线全部打通（发现入口、spawn、退出码、stderr 尾巴都真机验证），**卡在 1113**。
- 步骤 2：完成。`lib/cli.js` 311 行（含模块级串行队列），`test/cli.test.mjs` 10 例。
- 步骤 3（与 4 合并执行）：完成。`stripAnsi()` + `parseCliAnswer()`，退出码 0 但 stdout
  为空判为错误而不是空答案；`test/cli.test.mjs` 新增 3 例解析测试。
- 步骤 4：完成。`ZcodeCliSubagentProvider`（provider `zcode-cli`）+ `toCliResult()`，
  复用从 `ZcodeSubagentProvider` 抽出的 `runHandle()`（同一套 abort/dispose 语义）；
  `lib/index.js` 注册第二个 provider 与工具 `subagent_zcode_cli`（新增 `cliEnabled` /
  `cliEntry` / `cliTimeoutMs`）。`test/provider.test.mjs` 新增 6 例，`test/host-route.test.mjs`
  新增 3 例（含 `cliEnabled:false` 退回单后端）。
- 全套回归：**91/91**。
- 真机（provider 层）：`ZcodeCliSubagentProvider.start()` → `zcode-cli-b94617cd-…`，
  `stopReason:error`，诊断 `zcode-cli: cli-exit: … [1113][余额不足或无可用资源包,请充值。]`
  ⇒ provider → CLI → 错误分类这条链在真机上成立，唯一缺口仍是账号额度。
- 剩余：步骤 5（`/ask` 的 `backend` 路由）、步骤 6（`docs/zcode-native/CLI.md`）、
  步骤 7（宿主内终验，需重启让 host 半身加载新代码）。