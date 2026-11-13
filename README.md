# dsh-zcode-native

把 [ZCode](https://z.ai) 桌面 app 变成 DSH（DeepSeek Harness）的**子代理后端 / 派活通道**：DSH 里的模型可以直接把一个完整任务派给 ZCode，等它做完并把答案取回来。实现方式是走 ZCode 的 CDP 调试端口读写界面 DOM，**不依赖 ZCode 的 CLI、stdio 或任何其他通道**——只要桌面上开着 ZCode 就能干活。

## 架构

插件分两个半身：

- **host 半身**（`lib/index.js` 等，ESM，跑在 DSH 宿主 Node 进程里）：
  - HTTP 路由（挂在 DSH 的 webServer 上，仅 loopback 可访问）；
  - CDP 客户端（`lib/cdp.js`，Node 内置 WebSocket 连 `127.0.0.1:<debugPort>`）；
  - 只读状态采集（`lib/status.js`）、派活状态机（`lib/ask.js`）、
    原生子代理提供者（`lib/provider.js`，把 ZCode 注册成 DSH 的 subagent backend）。
- **client 半身**（`lib/client.js`，`__ModuleLoader__.load` 信封，注入 DSH web 界面）：
  - 右侧边栏「ZCode 看板」tab（`sidebarRightTabs` + `sidebar.right.pane.tab` 插槽），
    只 fetch 本机 `/status` 路由，每 60 秒自动刷新；
  - 设置卡（`settings.section` 插槽）里一个开关，控制看板 tab 的注册与否
    （偏好存 localStorage，key `dsh-zcode-native:sidebar`，默认开启）。

两个半身的通信只有一条路：client 通过同源 HTTP 读 host 暴露的路由，客户端代码永远不直连 CDP 或远程 API。

## 前置条件

- DSH Desktop（宿主）；ZCode **3.17.1**（macOS 实测；Windows 用 `ZCode.exe`，见
  [docs/zcode-native/LAUNCH.md](docs/zcode-native/LAUNCH.md)）。
- ZCode 必须**带 CDP 调试端口**在跑。现在不用自己开终端：`autoLaunch`（默认开）会在
  端口不通时自动查找并启动它，也可以显式调工具 `zcode_launch`。手动等价命令：

  ```bash
  /Applications/ZCode.app/Contents/MacOS/ZCode --remote-debugging-port=9222
  ```

  ZCode 是 Electron 单实例应用：已有实例在跑时再启动，命令行参数会被单实例锁 +
  argv 解析器拒绝（报 `bad option: --remote-debugging-port`），端口不会开——所以
  `zcode_launch` 默认拒绝杀掉你正在用的实例，只有 `restart: true` 才退出重启。
  仓库自带的 `scripts/zcode-debug.sh`（默认端口 9222，会自动退旧实例再启动）等价于
  `restart: true` 的手动版。

- ⚠️ **ZCode 3.17.2+（含 Windows 3.18.0）的打包构建都拒绝该开关**：macOS 上进程能起、
  窗口能开，但端口永不通；Windows 3.18.0（2026-11-12 实测）进程直接退出、连窗口都不开
  （stderr `bad option: --remote-debugging-port=9222`）。打包构建没有替代入口（asar 里
  只有 `!isPackaged` 才开 9229）。插件在启动前会读已装 ZCode 可执行文件的版本：≥3.17.2
  立即以 `version-no-cdp` 失败（不浪费 30 秒启动等待，也不会杀掉你正在跑的实例），
  并指向 CLI 后端（`subagent_zcode_cli`）或回退 3.17.1。

## 安装

三种装法，按场景选一条。装完都要**重启 DSH Desktop**（host 半身不热重载）。

### A. 在 DSH 界面里装（最省事，无需克隆）

设置 → 插件 → 安装插件，粘贴：

```
github:ORIOW/dsh-zcode-native#v0.2.0
```

面板会装依赖、把它选进 `dsh.profile.bundles`，并按包内 `dsh.bundle.patch` 声明的
`cordis.patch.yml` 插入插件条目。`#v0.2.0` 是 tag；想让版本彻底钉死，换成本次
Release 页上那个提交 SHA（`github:ORIOW/dsh-zcode-native#<sha>`）——tag 可以被移动，
SHA 不能。

同一段字符串也是 CLI 命令的后半截：

```bash
dsh plugin --profile web add "github:ORIOW/dsh-zcode-native#v0.2.0"
```

`dsh plugin` 只是把参数转发给 profile 目录里的 pnpm，**它只装依赖**：装完要在插件页
把 `dsh-zcode-native` 勾上启用，否则不会加载。界面里的安装对话框则两者都做。

### B. 本地检出 + 挂载脚本（开发用：改代码能立刻看到）

插件以 `link:` 依赖的方式挂进 DSH 的 profile（`$DSH_HOME/profiles/web`）：

1. 把本仓库克隆到任意位置（下称 `<repo>`）。
2. 仓库根由脚本自己解析（= `<repo>/scripts/` 的上一级）；如果检出位置特殊，用
   `ZCODE_NATIVE_REPO=<repo>` 覆盖。
3. 干跑检查：`node <repo>/scripts/mount-zcode-native.mjs`
4. 真执行：`node <repo>/scripts/mount-zcode-native.mjs --apply`

脚本（幂等，可重复跑）会：备份 profile 的 `package.json` 与 `cordis.patch.yml` →
在 `dependencies` 里加 `"dsh-zcode-native": "link:<repo>"` → 把插件加进
`dsh.profile.bundles` → 调 DSH 内置 pnpm install → 在 profile 的
`node_modules/dsh-zcode-native` 建**符号链接**指向 `<repo>` 并校验 realpath →
向 profile 的 `cordis.patch.yml` 追加本插件的 `insert` 块（见仓库根的
`cordis.patch.yml`，`id: zcode-native`）。

完成后重启 DSH Desktop，插件即生效（设置页出现「ZCode Native」卡片）。

### C. 压缩包 / 本地绝对路径

安装对话框同样接受 `.tgz` 压缩包和本地绝对路径（`/Users/you/code/dsh-zcode-native`）。
注意这两条装出来的是**拷贝**：改了代码不会生效，得重新装一遍。要边改边看请走 B。

## 配置项

定义在 `lib/index.js` 的 `Config`（schemastery），可在 profile 的
`cordis.patch.yml` insert 块里覆盖：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `debugPort` | number | `9222` | ZCode 的 CDP 调试端口 |
| `cacheMs` | number | `15000` | `/status` 快照的缓存有效期（毫秒） |
| `askTimeoutMs` | number | `600000` | 派活等待答案的超时（毫秒） |
| `autoLaunch` | boolean | `true` | 端口不通时自动查找并启动 ZCode（见「自动启动」） |
| `zcodeExecutable` | string | `''` | 手动指定可执行文件；留空则按平台候选表 + `PATH` + 目录扫描找 |
| `launchTimeoutMs` | number | `30000` | 启动后等待 CDP 上线的预算（毫秒） |
| `cliEnabled` | boolean | `true` | 注册 CLI 后端（provider `zcode-cli` + 工具 `subagent_zcode_cli`）；`false` 就退回只有 CDP 的形态 |
| `cliEntry` | string | `''` | `zcode.cjs` 的绝对路径；留空按安装位置自动找 |
| `cliTimeoutMs` | number | `600000` | 一次 CLI 派活的超时（毫秒） |
| `cliSessionId` | string | `''` | 显式指定复用的 ZCode 会话 id（界面里可复制）。留空则按派活工作目录自动认领该目录最新的一条会话 |

## 能力清单

宿主里共四个工具：`subagent_zcode`（CDP 派活）、`subagent_zcode_cli`（无头 CLI
派活）、`zcode_launch`（找并启动 ZCode 的调试端口）、`zcode_dispatch_checklist`
（前两条都够不到时的人工清单；`cliEnabled: false` 时这个也只有三个）。下面逐项说明。

### HTTP 接口（host 半身，仅 loopback，响应带 `cache-control: no-store`）

- **`GET /plugins/dsh-zcode-native/status`**：只读状态快照，含账号（仅 id /
  用户名 / token 长度，见下文安全边界）、客户端可达性与版本、套餐
  （planId / name / status / 起止时间 / entitlements）、余额（见下）、
  catalog 模板清单。`cacheMs` 内返回缓存。
- **`POST /plugins/dsh-zcode-native/ask`**：派活。请求体 `{"prompt": "..."}`
  （上限 64 KiB），把 prompt 送进 ZCode 的输入框并取回答案，返回
  `{ status: 'ok'|'timeout'|'error', answer?/partialText?, elapsedMs, error? }`。
  多个请求在插件内部排队串行执行（ZCode 只有一个输入框）；ZCode 正在生成时
  返回 `busy`，不会抢占。

### DSH 工具 `subagent_zcode`

把 ZCode 注册成 DSH 的原生子代理后端（provider 名 `zcode`，外部后端：
不接受后续消息，完成通知携带最终答案）。模型可见的参数只有两个：

- `description`（string，必填）：任务的简短描述（3-5 个词），用于展示；
- `prompt`（string，必填）：**完整自包含**的任务文本——ZCode 看不到本对话，
  文件路径、仓库位置、验收标准都要写全。

**刻意不暴露 `cwd`**：ZCode 只操作它自己打开的项目，传一个它不会用的工作目录
等于假装支持。

**取消会真的停下 ZCode**：abort 与超时都不只是让调用方拿到 `aborted`/`timeout`，
而是先点 ZCode 的 `停止生成`、再在有界预算内等它回到空闲（至多 4s，尽力而为，
永不 reject）。否则被弃的生成会一直空转，并让之后每一次派活都撞上 `busy`。

**派活前确认 ZCode 停在目标任务的那个会话**：ZCode 可以同时开多个项目的会话，
composer 只属于当前可见的那一个。插件在发送前记下标题栏（拖拽区里的项目名），
中途被切走会立刻以 `session-changed` 失败，而不是把别的项目的回答当作结果——
但它无法推断「你想问哪个项目」。切走之后插件也不会去点 `停止生成`：那时那个
按钮属于你在另一个会话里的活儿。

### 两条后端：`subagent_zcode` 与 `subagent_zcode_cli`

ZCode 3.17.2+ 的打包版（macOS 与 Windows 3.18.0，均实测）不再接受 `--remote-debugging-port`
（`app.asar` 里唯一开 CDP 的语句在 `!isPackaged` 分支），所以插件同时提供第二条通道：
驱动 ZCode 自带的无头 CLI。

| | `subagent_zcode`（CDP） | `subagent_zcode_cli`（CLI） |
| --- | --- | --- |
| 需要 ZCode 窗口 | 是 | 否 |
| 需要调试端口 | 是（3.17.2 拿不到） | 否 |
| 工作目录 | ZCode 当前打开的项目 | 工具走父代理工作目录，`/ask` 要自己给 `cwd`（自动带 `--cwd`） |
| 会话 | 复用 ZCode 的 composer，可看到对话历史 | 每次新建 CLI 会话，无历史 |
| 并发 | 串行（一张 composer） | 串行（共享 `~/.zcode/cli/db`） |
| 前提 | ZCode 停在目标会话 | 该 ZCode 安装已 `zcode login` 过 |
| 鉴权 | 与桌面版一致 | 用 CLI 自己的登录态与模型选择 |

CLI 后端的行为边界，都是实测出来的：

- 每次派活起一个 `node <ZCode>/Contents/Resources/glm/zcode.cjs -p <prompt> --cwd <ws> --no-color`
  子进程；答案就是退出码 0 时的 stdout（去掉 ANSI 与行尾空白）。
- **不写你的全局配置**：只从入口路径推导 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE`
  并传进去，`credentials.json` / `provider_config.json` 一律只读。
- 失败带证据：非零退出、超时、abort 三种都把最后 4 KB stderr 拼进诊断，形如
  `zcode-cli: cli-exit: zcode cli: exit code 1 — the cli said: …`。
- 退出码 0 但 stdout 为空会被判成错误（CLI 有时把结论写进 stderr），不会当成
  空答案投给父代理。
- 还没登录时 CLI 会自己报 `Select a model before sending a message`，插件原样透出。
- `POST /plugins/dsh-zcode-native/ask` 也认后端：body 带 `"backend": "cli"` 就走无头 CLI，
  缺省或 `"cdp"` 与旧行为逐字节一致，`cliEnabled: false` 时回 `cli-disabled`。

完整说明（入口、配置项、失败码、实跑命令）见
[docs/zcode-native/CLI.md](docs/zcode-native/CLI.md)。

#### CLI 用哪个模型：模型由会话决定，会话由工作目录认领

CLI 只认**会话记录里的模型选择**（`session_entry` 里那条 `runtime/model_selection`），
配置文件里的默认模型、`setting.json` 里的套餐选择都改不动它（2026-11-08 逐项实测）。
不给会话时 CLI 每次新建会话，就落回账号的默认套餐，可能直接报
`[1113][余额不足或无可用资源包,请充值。]`。

所以插件按**派活的工作目录**去会话库里认领：`directory` 等于该目录、未删除的最新一条，然后带
`--resume` 用它。你在 ZCode 里为某个项目建的那条对话，就是这个项目里所有 CLI 派活用的那条——
不同的 DSH 会话在不同项目里干活，会各走各的。

想固定到某一条（例如目标会话不在这个目录），填配置 `cliSessionId`，或给 `/ask` 传
`"sessionId"`；两者都优先于目录认领。实测输出：

```
--resume sess_22c77399-… -p "只回复 OK" --cwd <ws>
→ stdout: OK   exit: 0   （model_usage 记 xiaomi-mimo / mimo-v2.6-flash / completed）
```

注意两点：派活会写进那条会话，别和你在界面里手动用的那条混在一起；认领只看目录、不看模型，
那条会话的套餐没额度时照样报 `[1113]`，得在 ZCode 界面里换模型或改用 `cliSessionId`。

### 自动启动：`zcode_launch` 与 `autoLaunch`

端口不通时插件会自己把 ZCode 找出来并带上 `--remote-debugging-port=<port>` 启动，
不需要你先开终端（issue #1）。两条触发路径：

- **自动**：`subagent_zcode` 派活或 `POST /ask` 发现端口不通 → 启动 → 再 attach，
  日志里多一行 `[zcode-native] ask launch port=9222 launched=true elapsedMs=...`。
  由 `autoLaunch`（默认开）控制；启动失败会以 `zcode-not-running` 失败，消息里带
  子进程的 stderr（例如应用自己拒绝开关时的 `bad option: ...`）。
- **显式**：工具 `zcode_launch`，三个可选参数：`restart`（先退出旧实例再启动，
  **会丢掉 ZCode 里未保存的东西**）、`executablePath`（指定装在哪）、`plainFallback`
  （端口开不起来时改以零参数拉起窗口：CDP 仍不可用，供 `zcode_dispatch_checklist`
  手工派活；默认关）。返回
  `{ launched, alreadyRunning, restarted, port, executablePath, browser, plainFallback?, fallbackReason?, version? }`。

查找顺序：配置里的 `zcodeExecutable` → 平台候选表（Windows
`%LOCALAPPDATA%\Programs\ZCode\ZCode.exe` 等；macOS
`/Applications/ZCode.app/Contents/MacOS/ZCode`；Linux `/opt/ZCode/zcode` 等）→
`where ZCode.exe` / `which zcode` → `%LOCALAPPDATA%\Programs` 下两层的目录扫描。
全都没找到会报 `executable-not-found`，消息里列出找过的每一处。

**单实例语义**：ZCode 是 Electron 单实例应用，已有实例在跑时新进程的参数会被丢掉。
所以端口不通 + 已有实例在跑 ⇒ 默认报 `already-running-without-debug-port`（提示你
退出或传 `restart:true`），绝不偷偷杀掉你正在用的 ZCode。

**版本快失败**：启动前插件先读已装 ZCode 可执行文件的版本（Windows 读文件版本信息、
macOS 读 `Info.plist`、Linux 跑 `--version`；读不到按未知处理，照旧逻辑走）。
版本 ≥3.17.2（实测拒绝开关的最低版本，`CDP_REFUSING_MIN_VERSION`）时立即报
`version-no-cdp`，指向 CLI 后端或回退 3.17.1——不空等 30 秒，即使传了
`restart: true` 也不会先杀掉你正在跑的实例。传 `plainFallback: true` 时不报错：
改以零参数拉起窗口（`restart: true` 时先退出旧实例），方便接着走人工清单；
自动路径（`autoLaunch`）不使用该回退。

### 第三条路：`zcode_dispatch_checklist`（两条后端都够不到时）

前两条路都有机器前提：CDP 那条要调试端口，CLI 那条要有一个它肯用的模型。两个前提
都不成立时，插件不再让你去猜错误码，而是把「手工给 ZCode 派活」的完整清单交出来：

| 情况 | 现象 | 走哪条路 |
| --- | --- | --- |
| 端口起不来 | `zcode-not-running`，stderr 带 `bad option: --remote-debugging-port` | 清单（第 1 步就是端口排查与启动命令） |
| CLI 找不到入口 | `cli-not-found` | 清单 + 检查 ZCode 是否装在这台机器上 |
| CLI 没有可用模型 | `cli-exit`，stderr 带 `[1113]` 或 `Select a model` | 清单 + 先在 ZCode 里把会话模型切对 |
| 正常派活被拒 | `busy`、prompt 为空 | 不是「通道不可用」，照原错误处理，不提示清单 |

怎么用：派活失败后调工具 `zcode_dispatch_checklist`（参数只有一个可选的 `reason`），
它返回一整份可执行的人工流程：

- **DOM 项目守卫**：读 48px 会话标题条（`app-region:drag`），标题不符就停下问人；
  不能用全文匹配（左侧任务列表里列着所有项目名，会误判）。
- **能用的选择器与判据**：`[class~="group/assistant-turn"]`、`group/assistant-row`、
  发送后必须出现新回合（`no-new-turn` 就是没发出去）、答案按 `turns[before]` 取。
- **踩过的坑**：`execCommand` 清不掉 composer、「超时 ≠ 失败，绝不重发」、
  每次 ask 都是新会话所以 prompt 必须自包含。
- 抬头会写明触发原因、先试过的后端与那次诊断；正文与工作区技能
  `.dsh/skills/zcode-dispatch-checklist/` 同源（`lib/checklist.md` 是它的同步副本）。

清单里出现的 `zcode_ask` / `zcode_status` 属于姊妹插件 dsh-zcode：前者对应本插件的
`subagent_zcode`，后者对应 HTTP 路由 `/plugins/dsh-zcode-native/status`。

### 侧边栏看板

DSH 界面右侧边栏（Subagents / Tasks 旁）出现「ZCode」tab：账号、套餐到期
倒计时、余额、客户端版本与可达性、catalog 模板数；底部有更新时间与手动刷新
按钮。可在设置卡里关掉。

## 用法示例

装好之后不用记 API，在 DSH 里正常说话就行，模型会自己调 `subagent_zcode`（也可以直接打
`POST /plugins/dsh-zcode-native/ask`）：

> 用 ZCode 查一下 `~/Projects/foo` 里 `pnpm test` 为什么在第 3 个用例挂掉，把根因和改法带回来。

> 把这个仓库的 `lib/ask.js` 通读一遍，列出所有会抛错的分支和它们的错误码。

三条硬规则——**ZCode 看不到这个对话**：

1. **prompt 必须自包含**：路径、仓库位置、验收标准都写全，别写「上面那个文件」。
2. **先让 ZCode 停在目标项目的会话上**：它可能同时开着好几个项目的会话，composer 只属于
   当前可见那一个。插件在发送前记下标题栏，中途被切走会立刻以 `session-changed` 失败，
   而不是把别的项目的答案端回来。
3. **一次只派一件**：插件内部串行，ZCode 正在生成时新任务直接 `busy`。

默认最多等 10 分钟（`askTimeoutMs` 可调）。想放弃就取消——取消会真的点 ZCode 的
`停止生成`，不会留下一个空转的生成把后续派活全堵死。

## 安全边界

- 插件会读取 `~/.zcode/v2/credentials.json`。该文件的大部分值是
  `enc:v1:` 信封（base64url 的 `nonce.tag.ciphertext`，AES-256-GCM），
  密钥 = `sha256(ZCODE_CREDENTIAL_SECRET ?? "zcode-credential-fallback:<platform>:<homedir>:<username>")`
  ——即 ZCode 客户端自己的离线 fallback secret，插件用同一算法解密。
- 账号 token（`zcodejwttoken`）**只在本机内存里解出**，唯一用途是作为
  `Authorization: Bearer` 请求 `https://zcode.z.ai` 的套餐/余额接口；
  **不回显、不写日志、不进任何 HTTP 响应**。`/status` 只输出
  `hasAccountToken` 布尔值与 `accountTokenLength` 长度，测试里有专门的
  token 泄漏断言。
- 余额接口在本插件实测恒返回 `{"code":3001,"msg":"parameter error"}`，
  `/status` 如实报告 `{"available": false, "reason": "..."}`，**绝不显示
  猜测的数值**。
- 所有 HTTP 路由只接受 loopback 来源（`127.0.0.0/8`、`::1`），其余 403。

## 日志

每次派活在宿主日志（`~/Library/Logs/DSH Desktop/harness.log`）里留两行，出问题先看这里：

```
[zcode-native] ask start port=9222 promptChars=42 waitedMs=0
[zcode-native] ask settled status=ok elapsedMs=4311 answerChars=5
```

失败是 `ask failed code=busy elapsedMs=0 detail="…"`；取消多一行
`ask release clicked=true idle=true elapsedMs=258`（`idle=false` = 点了停止但 ZCode 还在
生成，接下来的派活会撞 `busy`）。`waitedMs` 不是在等 ZCode，是在等前一条派活让出队列，
它变大说明前一条卡住了。prompt 与答案正文永远不进日志，只记长度。

## 已知限制

- 一次只能服务一个 ZCode 会话：派活串行排队，ZCode 正在生成时会拒绝新任务。
- 必须由你手动在 ZCode 里打开目标项目，插件不做项目切换。
- 自动启动能拉起进程，但**能否开出 CDP 端口取决于 ZCode 自己的 argv 处理**：
  3.17.2（macOS）与 3.18.0（Windows，2026-11-12 实测）起的打包构建直接拒绝该开关
  （见前置条件）；插件按版本快失败（见自动启动），启动失败时只报事实，不绕过应用。
- Windows 的启动路径已真机实测（3.18.0：拒绝开关、进程直接退出，见前置条件）；
  Linux 的启动路径未在本机验证（候选表与 `where` 回退是照惯例写的，单测覆盖，
  缺真机证据）。
- ZCode 界面更新可能使 DOM 选择器失效（选择器均已按 3.17.1 实测校准）。

## 路线图

- ✅ M0 — 插件骨架（加载验证 + 设置卡）
- ✅ M1 — 只读状态采集（账号 / 套餐 / catalog）+ `/status` 路由
- ✅ M2 — 侧边栏看板 tab + 设置页开关
- ✅ M3 — 派活闭环（`/ask`：清空 → 写入校验 → 发送 → 读最后一个回合取答）
- ✅ M4 — 原生子代理（`subagent_zcode` 工具 + provider，宿主内验收通过）
- ✅ M5 — 开源发布

## 许可证

[MIT](./LICENSE)
