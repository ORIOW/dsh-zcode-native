# dsh-zcode-native · M1 完成说明

日期：2026-10-25。范围：只读状态采集 + `/status` 路由。M0 的 client.js / package.json / cordis.patch.yml 未改动。

## 文件清单（行数）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `lib/index.js`（改造） | 74 | inject 改为 `['webServer']`；`ctx.inject(['webServer'], ...)` 延迟注册 GET `/plugins/dsh-zcode-native/status`；loopback 校验 + `cache-control: no-store` + cacheMs 缓存 |
| `lib/cdp.js`（新增） | 187 | CDP 只读客户端：attach / evaluate / snapshot / dispose |
| `lib/status.js`（新增） | 359 | 五路采集 + 纯函数解析器（parsePlan / parseBalance / parseCatalog / describeAccount / decryptCredential） |
| `test/status.test.mjs`（新增） | 207 | node:test 单测，11 条全过（见下） |

## 每个字段的真实数据来源

| 槽位 | 来源 | 实测结果 |
| --- | --- | --- |
| account.id / username / displayName | `~/.zcode/v2/credentials.json` 的 `oauth:bigmodel:user_info`，`enc:v1:` AES-256-GCM 解密（key = sha256(`zcode-credential-fallback:<platform>:<homedir>:<username>`)，即客户端自身的 fallback secret） | 27241790230962551 / ORIOW / ORIOW |
| account.activeProvider | 同文件 `oauth:active_provider`，同样解密 | bigmodel |
| account.hasAccountToken / accountTokenLength | 同文件 `zcodejwttoken` 解密后按长度报告（204），**token 原文不进任何输出/日志** | true / 204 |
| client.* | CDP `GET http://127.0.0.1:<debugPort>/json/list` 选 `renderer/index.html` 页面，`Runtime.evaluate` 快照 | reachable=true，ZCode/3.16.3，title=ZCode |
| plan | `GET https://zcode.z.ai/api/v1/zcode-plan/billing/current?app_version=<v>&platform=<p>`，头 `authorization: Bearer <token>` + `x-zcode-app-version` + `x-platform`。**实测：不带 app_version/这两个头会 401 空响应，带上后 200** | authenticated=true，ZCode 1024 Dev Day（zcode-v3-start-plan-1024）active，entitlements: GLM-5.3-Flash、GLM-5.3 |
| balance | `GET .../billing/balance?app_version=<v>` 同头 | available=false，reason=`HTTP 400 code=3001 msg=parameter error`（真实错误，未编造数值） |
| catalog | readdir `~/.zcode/v2/runtime/provider/darwin-aarch64/*/endpoint-*/zcode-builtin.json`，取 `config.providerConfigRules.templateRules[].templateId` 与每条 `config.builtinModelIds` 数量 | 21 个模板（zai-api=2、openrouter=59、anthropic=5 等） |

失败语义：每路独立 try/catch；plan 失败 → `{ authenticated:false, error }`；balance 失败 → `{ available:false, reason:<真实错误码和消息> }`；catalog 读不到 → `[]`。

## 关键实现决策

1. **路由注册**：`ctx.inject(['webServer'], (webCtx) => ctx.effect(() => webCtx.webServer.register({ kind:'exact', path, handler(request, response) {...} }), label))`。handler 拿到的是 Node 原生 `http.IncomingMessage/ServerResponse`。参考了 zcode-assets 里前代插件 dsh-zcode-connect 的同款实现；不用 `ctx.get`（实测返回 undefined，路由会消失）。
2. **CDP 安全边界**：URL host 硬编码 `127.0.0.1`，端口必须是 1-65535 整数；只发 `Runtime.evaluate`；每次调用带默认 5000ms 超时（AbortSignal / pending-map timer），`dispose()` 幂等。
3. **token 泄漏防护**：describeAccount 只输出六个安全字段；单测里用自加密的 `enc:v1` 信封做了端到端泄漏断言。

## test 实际运行结果（node --test test/）

```
✔ describeAccount tolerates malformed JSON input without throwing
✔ describeAccount survives missing fields
✔ describeAccount decrypts enc:v1 values and NEVER emits the token
✔ decryptCredential round-trips and rejects a tampered envelope
✔ parseCatalog: malformed input -> [], valid input -> mapped template ids + counts
✔ parseBalance: the measured 3001 body yields available:false with the REAL reason, no numbers
✔ parseBalance: malformed body and non-zero codes also degrade without numbers
✔ parseBalance: a real code:0 response maps balances
✔ parsePlan: malformed -> authenticated:false; valid -> camelCase mapping
✔ collectStatus: token never leaks end-to-end, each slot stays independent
✔ collectStatus: a missing home degrades every slot instead of throwing
ℹ tests 11  pass 11  fail 0
```

另做了一次真实机器冒烟（stub 全部换成真实来源）：五个槽位全部取到上表数据，且输出 JSON 不含 token 原文。
