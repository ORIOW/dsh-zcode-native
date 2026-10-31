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

- macOS（其他平台未验证）；DSH Desktop（宿主）与 ZCode **3.17.1**。
- ZCode 必须带 CDP 调试端口启动，且**必须先完全退出（Cmd+Q）再由终端启动**：

  ```bash
  /Applications/ZCode.app/Contents/MacOS/ZCode --remote-debugging-port=9222
  ```

  ZCode 是 Electron 单实例应用：已有实例在跑时再启动，命令行参数会被单实例锁 +
  argv 解析器拒绝（报 `bad option: --remote-debugging-port`），端口不会开。
  也可以用仓库自带的 `scripts/zcode-debug.sh`（默认端口 9222，会自动退旧实例再启动）。

## 安装与挂载

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

## 配置项

定义在 `lib/index.js` 的 `Config`（schemastery），可在 profile 的
`cordis.patch.yml` insert 块里覆盖：

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `debugPort` | number | `9222` | ZCode 的 CDP 调试端口 |
| `cacheMs` | number | `15000` | `/status` 快照的缓存有效期（毫秒） |
| `askTimeoutMs` | number | `600000` | 派活等待答案的超时（毫秒） |

## 能力清单

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

### 侧边栏看板

DSH 界面右侧边栏（Subagents / Tasks 旁）出现「ZCode」tab：账号、套餐到期
倒计时、余额、客户端版本与可达性、catalog 模板数；底部有更新时间与手动刷新
按钮。可在设置卡里关掉。

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

## 已知限制

- 一次只能服务一个 ZCode 会话：派活串行排队，ZCode 正在生成时会拒绝新任务。
- 必须由你手动在 ZCode 里打开目标项目，插件不做项目切换。
- CDP 端口必须由用户带参启动（见前置条件），插件不会替你启动或重启 ZCode。
- Windows / Linux 未验证。
- ZCode 界面更新可能使 DOM 选择器失效（选择器均已按 3.17.1 实测校准）。

## 路线图

- ✅ M0 — 插件骨架（加载验证 + 设置卡）
- ✅ M1 — 只读状态采集（账号 / 套餐 / catalog）+ `/status` 路由
- ✅ M2 — 侧边栏看板 tab + 设置页开关
- ✅ M3 — 派活闭环（`/ask`：清空 → 写入校验 → 发送 → 按回合索引取答）
- 🚧 M4 — 原生子代理（`subagent_zcode` 工具 + provider）开发中
- ⬜ M5 — 开源发布

## 许可证

[MIT](./LICENSE)
