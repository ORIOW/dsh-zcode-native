# 自动查找并启动 ZCode（issue #1）

issue #1（ORIOW，2026-11-05）只有一句标题：

> 增加自动查找本地 zcode.exe、并设置带调试端口启动，可在会话中由用户 prompt 和 agent 启动 zcode

拆成三件可验收的事：

1. **找得到**：不给路径也能定位本机的 ZCode 可执行文件（Win11 上叫 `ZCode.exe`）。
2. **带端口启动**：以 `--remote-debugging-port=<port>` 拉起来，并等到 CDP 真的应答。
3. **会话里能触发**：用户 prompt 与 agent 都能触发——agent 走工具，用户走自然语言，
   且派活时如果端口本来就不通，**不用先手动开终端**。

## 1. 实现

`lib/launch.js`，所有外部依赖可注入（`exists / listDir / run / spawn / fetch / sleep / now`），
所以整套平台矩阵能在任何系统上毫秒级跑完（`test/launch.test.mjs`，28 例）。

### 查找顺序

| 顺序 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `executablePath` 配置/工具参数 | 显式给了就只用它；不存在直接 `executable-not-found` |
| 2 | 平台候选表 | win32：`%LOCALAPPDATA%\Programs\ZCode\ZCode.exe`、`%LOCALAPPDATA%\ZCode\…`、`%APPDATA%\ZCode\…`、`%ProgramFiles%\ZCode\…`、`%ProgramFiles(x86)%\ZCode\…`；darwin：`/Applications/ZCode.app/Contents/MacOS/ZCode`、`~/Applications/…`；linux：`/opt/ZCode/zcode`、`/usr/bin/zcode`、`~/.local/bin/zcode` |
| 3 | `PATH` | `where ZCode.exe`（win32）/ `which zcode` |
| 4 | 目录扫描 | `%LOCALAPPDATA%\Programs` 下两层的 `ZCode.exe`（相对路径，避开 Windows `%ProgramFiles%` 权限问题） |

全 miss ⇒ `LaunchError('executable-not-found')`，消息里把找过的**每一处**列出来（含
`where ZCode.exe` 与 `scan …` 两项），不要只说「找不到」。

候选表按**目标平台**拼路径（`path.win32.join` / `path.posix.join`），不能用
`node:path.join`——它跟着宿主平台走，在 macOS 上算 Windows 候选表会混出 `/` 分隔符。

### 单实例语义（Electron 的坑）

ZCode 是 Electron 单实例应用：已有实例在跑时，新进程的命令行参数会被单实例锁丢掉，
端口不会开。所以：

- 端口**已经通** ⇒ 返回 `alreadyRunning: true`，**不**起第二个实例；
- 端口不通但**有实例在跑** ⇒ 默认抛 `already-running-without-debug-port`（消息带 pid），
  只有显式 `restart: true` 才先退出旧实例再启动——**这会丢掉 ZCode 里未保存的东西**，
  所以 `autoLaunch` 的自动路径永不预设 `restart`，只有工具参数能传。

### 等待与失败

启动后每 300ms 探一次 `/json/version`，预算 `launchTimeoutMs`（默认 30000）。
超时抛 `launch-timeout`，消息里带：预算毫秒、最后一轮的探测原因、以及**子进程 stderr 的
尾巴**——应用自己拒绝开关时那句 `bad option: --remote-debugging-port=…` 就是全部诊断，
必须让它出现在错误里（`collectStderr`，上限 4096 字符，永不抛错）。

`spawn` 用 `detached: true` + `unref()`，stderr 收 `pipe` 但只留尾巴，不阻塞宿主退出；
轮询用的 `defaultSleep` **不能** `unref()`——否则 `await` 期间没有句柄可等，node 以
`Detected unsettled top-level await` / exit code 13 退出。

### 版本快失败（3.17.2+）

spawn 之前先读已装 ZCode 的版本（`probeAppVersion`，纯只读，任何失败返回 null 并照旧
走启动逻辑）：≥ `CDP_REFUSING_MIN_VERSION`（3.17.2，实测拒绝开关的最低版本）时立即抛
`version-no-cdp`，消息里指向 CLI 后端（`subagent_zcode_cli`）或回退 3.17.1。该步位于
破坏性 quit **之前**——`restart: true` 也不得先杀掉一个开不出端口的版本。

**无端口回退（`plainFallback`）**：工具参数 `plainFallback: true`（默认关）时，上述
`version-no-cdp` 与 `launch-timeout` 不再抛错，而是以**零参数**再 spawn 一次 ZCode
（`restart: true` 时先退出旧实例）：窗口有了，CDP 仍不可用——返回值
`{ plainFallback: true, fallbackReason, version }`，供 `zcode_dispatch_checklist`
手工派活。自动路径（`autoLaunch`）永不传该参数：不冒没人要的窗口。

### 两条触发路径

- **自动**：`lib/ask.js` 的 `attachZCode()` —— 先 attach；失败且配置了 `ensureRunning`
  时调用启动钩子（`autoLaunch` 默认开），成功则打一行 `ask launch port=… launched=…`，
  再 attach 一次；启动失败抛 `AskError('zcode-not-running')`，消息里同时保留 attach 的
  原始错误与启动错误码。
- **显式**：工具 `zcode_launch`（`restart` / `executablePath` / `plainFallback` 三个可选参数，
  `isConcurrencySafe` 为 false——它会动进程）。返回值
  `{ launched, alreadyRunning, restarted, port, executablePath, browser, plainFallback?, fallbackReason?, version? }`。

配置项：`autoLaunch`（默认 true）、`zcodeExecutable`（默认空）、`launchTimeoutMs`（默认 30000）。

## 2. 实测（2026-11-05，macOS + ZCode 3.17.2）

| 场景 | 结果 |
| --- | --- |
| 查找 | 命中 `/Applications/ZCode.app/Contents/MacOS/ZCode` |
| `launch({ port: 9222 })`（已有实例在跑） | 43ms → `already-running-without-debug-port`，消息含 pid 43345 |
| `launch({ port: 9222, restart: true })` | 退出旧实例、启动新实例（用户看到窗口），29397ms 后 `launch-timeout`，消息尾部 `The app said: … bad option: --remote-debugging-port=9222` |
| `open -na /Applications/ZCode.app --args --remote-debugging-port=9222`（轮询 40s） | `http=000`，端口始终不通 |
| 直接 spawn 二进制 | 立即 stderr：`ZCode: bad option: --remote-debugging-port=9222` |

**结论**：启动链路本身通了（窗口起来了、pid 正确、失败语义正确）；**CDP 在 macOS 的
ZCode 3.17.2 上打不开**——应用自己拒绝这个开关，与插件无关（`scripts/zcode-debug.sh`
在同样环境下也失败）。11-01 用 3.17.1 时 9222 是通的，11-02 应用更新到 3.17.2 后变了。
asar 里`!isPackaged` 分支只在**非打包**构建才 `appendSwitch("remote-debugging-port","9229")`，
打包版没有任何替代入口，`~/.zcode/v2/setting.json` 也没有端口配置键。

**Windows 实测（2026-11-12，Win11，ZCode 3.18.0.10300）**：同类拒绝，且更彻底——
进程**直接退出**，连窗口都不开，stderr 只有一句 `C:\Program Files\ZCode\ZCode.exe: bad
option: --remote-debugging-port=9222`；旧启动逻辑要等满 30 秒预算才报
`launch-timeout`（stderr 尾巴留在消息里）。据此 `launch.js` 现在在启动前先读可执行文件
的版本（Windows：PowerShell `VersionInfo.FileVersion`；macOS：`Info.plist` 的
`CFBundleShortVersionString`；Linux：`--version`；读不到返回 null、照旧逻辑走）：
≥ `CDP_REFUSING_MIN_VERSION`（3.17.2，实测拒绝开关的最低版本）立即报
`version-no-cdp` 并指向 CLI 后端或回退 3.17.1——在破坏性 quit 之前抛出，不 spawn、
不空等 30 秒，即使 `restart: true` 也不会先杀掉正在跑的实例。

## 3. 测试

`test/launch.test.mjs` 28 例（全 fake dep）：win32 候选首位、darwin 两个 bundle 路径、
显式路径命中/miss、`where ZCode.exe` 回退、两层扫描、全 miss 的 `searched` 清单、
探测异常降级、已连上复用（且不触发版本探测）、无端口不重启、`restart` 先 quit 再 spawn 并带参数、
端口永不打开 → `launch-timeout`（含预算数字）、应用 stderr 进入错误消息、找不到可执行
文件不 spawn、`bad-port` 不探测；另有版本比较（数字段、缺段补 0、3.17.10 > 3.17.2）、`probeAppVersion`
的 win32/darwin/linux 读取与失败降级 null（linux 锚定含 version 的行，无关点号数字不误报）、
CDP 拒绝版本快失败（不 spawn、不 quit、时钟不前进）、
plainFallback 快失败路径（零参数 spawn、不空等）、plainFallback+restart 先 quit 再零参数 spawn、
launch-timeout 后 plainFallback 二次 spawn（零参数）、plainFallback 不碰已在跑的实例、
低于阈值的版本照旧 spawn、版本读不到降级旧逻辑。
`test/ask.test.mjs` 2 例：端口死了自动启动后重试、启动失败映射成 `zcode-not-running`。
`test/host-route.test.mjs` 1 例：`zcode_launch` 的参数与输出形状。
全量：135 例——Windows 3.18.0 真机（2026-11-13）134 绿；1 个失败为 `test/cli.test.mjs:73`
的预存平台敏感用例（darwin 期望值写死、未注入 platform，非 darwin 宿主必挂）。