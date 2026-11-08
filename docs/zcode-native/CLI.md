# CLI 后端：`subagent_zcode_cli`

ZCode 应用自带一个可以无头运行的 CLI。插件在 CDP 后端之外另接了一条 CLI 后端，两条并存：

| 后端 | 通道 | provider 名 | 工具 |
|------|------|-------------|------|
| CDP（默认） | 连 `127.0.0.1:9222` 操作 ZCode 界面 | `zcode` | `subagent_zcode` |
| CLI | 用 `node` 跑应用内的 `zcode.cjs` | `zcode-cli` | `subagent_zcode_cli` |

为什么需要它：ZCode 3.17.2 的打包版在 macOS 上不再接受 `--remote-debugging-port`（stderr 报
`bad option`，进程不监听任何端口），见 `LAUNCH.md` 与 README 的「已知限制」。CLI 是同一台机器上
唯一还能自动化的通道。

## 入口与前缀

```
/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs     # 15 MB，zcode 0.17.1
```

本机实测（2026-11-08）：

```
$ node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs --help | head -3
zcode 0.17.1

Usage:
  zcode [command] [options]
```

系统 `node` 是 v24.17.0。插件不往 PATH 里装任何东西，每次调用都用绝对路径 spawn 这个文件；
`cliEntry` 可以覆盖它。

## 三条使用路径

### 1. 工具 `subagent_zcode_cli`

和 `subagent_zcode` 同样的用法，只是换个工具名：

```
subagent_zcode_cli({ description: "读版本", prompt: "读取 package.json，只回复 version 字段的值" })
```

父代理拿到的结算文本就是 CLI 的 stdout（去掉 ANSI 与首尾空行）；CLI 非零退出、超时、找不到入口
都会变成 `stopReason: error` 加一段诊断，不会有假成功。

### 2. HTTP：`POST /plugins/dsh-zcode-native/ask` 的 `backend`

```
curl -s -X POST http://127.0.0.1:<webPort>/plugins/dsh-zcode-native/ask \
  -H 'content-type: application/json' \
  -d '{"prompt":"只回复 OK","backend":"cli","cwd":"/abs/path/to/project"}'
```

- 缺省或 `"cdp"`：与旧路径逐字节一致（响应体就是 `ask()` 的返回）。
- `"cli"`：走无头 CLI，响应体是 `{...outcome, backend:'cli'}`。
- `cliEnabled: false` 时回 200 与 `{"status":"error","error":"cli-disabled: …","backend":"cli"}`，不会 spawn。
- 其它值：400 `backend must be "cdp" or "cli"`，两条后端都不会被触达。

**`cwd` 要自己给**（`"cli"` 分支）：工具路径由宿主把父代理的工作目录放进 `request.cwd`，HTTP
路径没有这层信息。不给就落到宿主进程自己的 cwd，而那是桌面版的
`~/Library/Application Support/dsh-desktop/launch-root`，一个空目录——CLI 会以为项目是空的。
传了就必须是存在的绝对目录，否则 400：`cwd must be an absolute path` /
`cwd does not exist: …` / `cwd is not a directory: …`。

错误面与工具路径不完全一样：HTTP 这里不经过 `provider`，所以不会被加上
`zcode_dispatch_checklist` 指针；`cli` 分支的失败一律是 200 加
`{"status":"error","error":"<code>: <msg>","elapsedMs":null,"backend":"cli"}`。
退出码 0 但 stdout 为空同样按错误处理：`cli-empty-output: the cli printed no answer …`。

客户端中途断开（连接 `close` 且响应还没写完）会中止正在跑的 CLI 子进程（`cli-aborted`）：
CLI 调用是全局串行的，一次被放弃的请求本来会把后面所有 `subagent_zcode_cli` 一起堵住。

`backend` 这个字段是 `057b252` 引入的。宿主进程只有在**该提交之后重启**才会带这个路由行为；
重启前用 `backend: "cli"` 会被忽略，请求仍走 CDP（实测：返回 `zcode-not-running: … CDP …`）。

### 3. 直接命令行

调试时最省事的是直接跑，不经过插件：

```
ZCODE_BUILTIN_PROVIDER_CONFIG_FILE=/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json \
  node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs --resume sess_22c77399-… \
  -p "只回复 OK" --cwd "$PWD" --no-color
```

本机实测输出（会话 id 用占位符表示，实跑用的是真实会话）：

```
ZCode Built-in unchanged revision=43 source=CDN
OK
[exit=0]
```

`ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 不能省：`zcode login`、`-p`、`app-server` 这些路径都会先解析
builtin provider 配置，找不到就报 `无法定位 CLI ZCode Built-in Provider Config`。插件里由
`builtinProviderConfigPath()` 从应用根推出来并校验存在。

## 配置项

| 键 | 默认 | 含义 |
|----|------|------|
| `cliEnabled` | `true` | 关掉后不注册 `zcode-cli` provider 与 `subagent_zcode_cli` 工具，`/ask` 也只留 CDP |
| `cliEntry` | `''` | 覆盖 CLI 入口路径；空则按平台候选表发现 |
| `cliTimeoutMs` | `600000` | 单次 CLI 调用上限；超时会杀进程并回 `cli-timeout` |
| `cliSessionId` | `''` | 非空时把 `--resume <id>` 插进参数，见下节 |

## 模型由会话决定：`cliSessionId`

这是这条后端最容易踩的坑。CLI 的模型选择**只认会话记录**：`~/.zcode/cli/db/db.sqlite` 里
`session_entry` 表中 `type='runtime/model_selection'` 的那一行。

实测无效的三个位置（2026-11-08，均改过并还原）：

- `~/.zcode/v2/provider_config.json` 的 `config.defaultModelSelection`（`zcode login` 会写它，还会
  打印 `Model selection: …`）
- `~/.zcode/v2/setting.json` 的 `providerFamilyConnectionSelections.bigmodel.kind`
- 会话 `metadata.json` 里的 `modelSelection`

改这些之后跑 `-p`，`model_usage` 里记下的仍然是账号默认套餐（本机是
`account:bigmodel-individual-coding-plan / GLM-5.3` → `[1113] 余额不足或无可用资源包`），而桌面版同一
时刻用 `xiaomi-mimo / mimo-v2.6-flash` 是通的。

做法：在 ZCode 界面里建一条用目标模型的对话（或找一条已经在用的），从界面复制会话 ID，填到
`cliSessionId`：

```json
{ "cliEnabled": true, "cliSessionId": "sess_22c77399-d590-4180-9a86-8df8f92de7c7" }
```

然后参数变成 `<entry> --resume <id> -p <prompt> --cwd <ws> --no-color`。

两条真机证据：

| 做法 | 结果 |
|------|------|
| `--resume` 桌面里用 mimo 的那个会话，`-p "只回复 OK"` | stdout `OK`、exit=0，`model_usage` 记 `xiaomi-mimo / mimo-v2.6-flash / completed` |
| 自造 `session` + `session_entry`（`sess_probe_mimo_seed1`）再 `--resume` | stdout `OK`、exit=0（探针行已删） |

注意：派活会写进那条会话，所以最好单独建一条对话给插件用，别和你在界面里手动用的那条混在一起。

## 失败形状

`lib/cli.js` 的 `CliError.code` 是稳定机读值：

| code | 触发 | 诊断里的尾巴 |
|------|------|--------------|
| `cli-not-found` | 候选表与 `cliEntry` 都找不到入口 | 已找过的路径列表 |
| `cli-spawn` | spawn 本身失败（权限、可执行位） | 系统错误消息 |
| `cli-exit` | 非零退出 | stderr 尾部（≤4 KB） |
| `cli-timeout` | 超过 `cliTimeoutMs` | `no answer within <timeoutMs>ms` 与 stderr 尾部 |
| `cli-aborted` | 父代理取消，或 `/ask` 的客户端断开 | — |
| `cli-empty-prompt` | prompt 只有空白 | — |

业务层的两种常见错误会原样透出（这是 CLI 自己的话，插件不改写）：

- `Select a model before sending a message` —— 没有可用会话选择，或凭据缺 identity。
- `ProviderBusinessError: [1113][余额不足或无可用资源包,请充值。]` —— 会话选中的套餐没有额度。

## 边界（有意留成这样）

- 每次调用是一个独立的 CLI 进程，**不共享上下文**：要上下文就自己把历史写进 prompt。
- 插件**不写**用户的 `credentials.json`、`provider_config.json`，也不写 `~/.zcode/cli/db`。
  没登录就是没登录，报错原样交给调用方。
- 所有 CLI 调用串行（共享 `~/.zcode/cli/db`），同一时刻只有一个进程。
- `--cwd` 决定 CLI 看得见哪个项目。工具路径用宿主给的 `request.cwd`（父代理工作目录），
  `/ask` 用 body 里的 `cwd`，都没给才落到宿主进程的 cwd（桌面版的 launch-root，空目录）。

## 两条都不通时

CDP 起不来、CLI 又没入口或没可用模型时，失败诊断末尾会带一句
`call zcode_dispatch_checklist and follow it`，父代理可以调 `zcode_dispatch_checklist` 拿到一份
人工派活清单（DOM 守卫、composer 清空、取答案的选择器、超时≠失败）。清单不是自动执行器，它把
步骤交回给调用方。

带指针的失败码只有这几个（`provider.js` 的 `withChecklistHint`）：

| 通道 | 码 |
|------|-----|
| CDP | `zcode-not-running`、`launch-timeout` |
| CLI | `cli-not-found`、`cli-exit`、`cli-spawn` |

`cli-timeout` 与 `cli-aborted` 不带指针：前者通常只是任务太长，后者是调用方自己取消的。