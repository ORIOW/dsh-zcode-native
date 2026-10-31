# M0 骨架独立验证报告 · dsh-zcode-native

- 验证时间：2026-10-25 18:20 +08:00
- 验证角色：独立验证工程师（不信任既有结论，全部重新取证；未修改任何源码）
- 工作区：`<repo>`
- 宿主：DSH Desktop **0.2.1-rc.2**，asar = `/Applications/DSH Desktop.app/Contents/Resources/app.asar`（369,209,070 B）
- 验证方式：真实 `node -e` 解析 + asar 字节扫描 + 宿主 js-yaml 实解析 + 隔离 stub 运行

---

## 0. 总体判定

# `NEEDS_FIX`

**阻断级缺陷 1 条**（client 半身未导出 `inject`，会抛 `cannot get property "slots" without inject`，设置卡必然不显示）。
另有 **1 条中风险**（组件返回裸字符串，偏离官方示例）、**1 条文档失真**（M0-DONE.md 行数与实际不符）。

host 半身（`lib/index.js`）**全部通过**，`package.json` 与 `cordis.patch.yml` **全部通过**。

---

## 1. exports 可解析性 —— ✅ PASS

**取证命令**：用 `createRequire` 以包名（非相对路径）实际解析四项：

```
RESOLVE OK   dsh-zcode-native                    -> .../lib/index.js          exists=true
RESOLVE OK   dsh-zcode-native/client             -> .../lib/client.js         exists=true
RESOLVE OK   dsh-zcode-native/cordis.patch.yml   -> .../cordis.patch.yml      exists=true
RESOLVE OK   dsh-zcode-native/package.json       -> .../package.json          exists=true
FAILURES=0
```

**结论**：四项齐全、全部指向真实存在的文件。`./cordis.patch.yml` 在位，因此宿主 `require.resolve('<pkg>/cordis.patch.yml')` **不会**抛 `ERR_PACKAGE_PATH_NOT_EXPORTED`。

**补充取证**：asar 内 `ERR_PACKAGE_PATH_NOT_EXPORTED` / `PACKAGE_PATH_NOT_EXPORTED` 各出现 **3 次**，确认该错误路径真实存在于宿主代码中，不是理论风险。

---

## 2. cordis.patch.yml 结构 —— ✅ PASS

**2.1 与两个已知可用先例逐字对比**

| 文件 | 顶层形状 | insert 条目数 | 首条 id / name |
|---|---|---|---|
| 当前 `dsh-zcode-native` | 序列（array） | 1 | `zcode-native` / `dsh-zcode-native` |
| 先例 `amd-model-load` | 序列（array） | 1 | `amd-model-load` / `dsh-amd-model-load` |
| 先例 社区版 | 序列（array） | 1 | `zcode-connect` / `dsh-zcode-connect` |

`cat -e` 逐字节对比：三者的 `- insert:` 与 `    - id:` 缩进**完全一致**（2 空格 / 4 空格）。

**2.2 真实 YAML 解析**（用宿主 profile 自带的 js-yaml，先做 `!!js` 预处理，与宿主 `patch.js` 一致）：

```
PARSE OK   current dsh-zcode-native | top-level array = true | shape = [["insert"]]
           insert entries = 1 | first id = zcode-native | name = dsh-zcode-native
```

**2.3 asar 字节计数**

```
- insert:                        36
type: insert                      0
type:insert                       0
insert:                         132
```

`type: insert` 出现 **0 次** —— 宿主只认 `- insert:` 的 YAML 序列写法，当前文件正确。

**2.4 宿主 schema 佐证**：`patchStructure()` 定义 `properties: { insert: ref("entryList") }`，`entryList` 为 `type: "array"`。另有校验 `if (!isSeq(document.contents)) throw new Error("Profile patch must be a YAML sequence")` —— 当前文件是序列，满足。

**结论**：格式与缩进均正确，YAML 可解析，结构符合宿主 schema。**Lead 的两处修复中，patch 格式这一处修复是正确的。**

---

## 3. slots.register 签名 —— ✅ PASS

**3.1 签名实证**：asar 内 `slots.register` 出现 **397 次**，逐一核对均为 `ctx.slots.register(spec, Component)` 双参数形式，**spec 内无 `render` 键**。当前 `lib/client.js:21-29` 正是此形状。

**3.2 官方契约文档原文**（asar offset 76536600，`packages/client/ui-settings/src/client/contract/slots.ts:57`）：

```js
return {
  inject: ['slots'],
  apply(ctx) {
    ctx.slots.inject('settings.section', () => ctx.slots.register(
      { name: 'settings.section', id: 'my-entry', order: 100, label: 'My entry' },
      () => React.createElement('div', null, 'hello'),
    ))
  },
}
```

**3.3 `label` 形态**：契约文档 registerOptions 明确

> `label` — requirement: **optional**，type: **`string | (() => string)`**
> "A thunk is re-read on every projection, so localized text follows the active locale without re-registering."

当前写成 `label: () => 'ZCode Native'` —— **函数写法合法**，且与 `agent-presets` / `account` / `general` / `models` / `plugins` 五个内置先例一致（全部用 thunk）。

**3.4 `order: 90` 边界检查**：既有 section 的 order 分布为 `account=-10, general=0, models=10, plugins=15, agent-presets=20, market=40, my-entry=100`。`90` 落在区间内、**不与任何既有 id 冲突**，合法。

**结论**：`register(spec, Component)` 签名正确，spec 无 `render` 键，`label` 用 thunk 合法。**Lead 的这一处修复是正确的。**

---

## 4. 模块解析 —— ✅ PASS（确认是预期行为）

**4.1 裸 Node 下确实失败**：

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/schemastery'
  imported from .../make zcode plugin/lib/index.js
```

**4.2 但这是预期行为**，回退机制在 `Resources/host-module-fallback.mjs`：

```js
const HOST_PACKAGE_PREFIX = '@deepseek-ai/'
const HOST_RETRYABLE = new Set(['ERR_MODULE_NOT_FOUND'])

export function registerHostModuleFallback(dshEntryPath) {
  const hostEntryUrl = pathToFileURL(dshEntryPath).href
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      try { return nextResolve(specifier, context) }
      catch (error) {
        if (!specifier.startsWith(HOST_PACKAGE_PREFIX) || !HOST_RETRYABLE.has(error.code)) throw error
        return nextResolve(specifier, { ...context, parentURL: hostEntryUrl })
      }
    }
  })
}
```

**确切工作方式**：`registerHooks` 拦截 ESM 解析 → 先按插件自身物理路径正常解析（插件自带 node_modules 时优先用插件的）→ 仅在**两个条件同时满足**时重试：① specifier 以 `@deepseek-ai/` 开头；② 错误码为 `ERR_MODULE_NOT_FOUND` → 用 `parentURL = dshEntryPath` 重新解析，即从宿主入口（asar 内的 `node_modules`）取包。其他依赖**不会**被宿主顶替，保持插件自有。

**4.3 挂载时序**：`harness-node-entry.mjs:101` 在 `import(dshEntryPath)` **之前**调用 `registerHostModuleFallback(dshEntryPath)`，确保插件加载时钩子已生效。

**4.4 包确实在宿主内**：解析 asar header（offset 12，len 7,180,856）确认目录存在：
```
FOUND /node_modules/@deepseek-ai/schemastery | dir: True
```

**说明**：我用裸 Node 模拟 fallback 时仍失败，是因为 asar 内部路径无法被裸 Node 解析（宿主是在 Electron + asar 感知环境下运行），**该模拟不能作为"回退失效"的证据**。以上代码与时序证据为准。

**结论**：裸 import 失败是**预期行为，不是缺陷**。

---

## 5. host 半身契约 —— ✅ PASS

用 schemastery stub 做隔离加载（stub 仅实现 `object/number/string` 与 `default/description` 链式调用），实际执行 `import` 并调用 `apply`：

```
EXPORTS: Config, apply, inject, name
name = "zcode-native" | type string
inject isArray = true | value = []
Config type = object | schema(object)
apply type = function
apply() ran, console.log captured: ["[zcode-native] loaded"]
```

逐条对照：

| 导出 | 要求 | 实际 | 判定 |
|---|---|---|---|
| `name` | string | `"zcode-native"` | ✅ |
| `inject` | 数组 | `[]`（合法，host 半身不依赖任何服务） | ✅ |
| `Config` | schemastery schema | `Schema.object({...})`，可被宿主归一化 | ✅ |
| `apply` | function | 可调用，不抛错 | ✅ |

**额外验证**：`apply` 用 `console.log` 而非 `ctx.logger.info` —— **正确**，因为宿主日志桥只放行 error/warn，info 永不进 harness.log。

**结论**：host 半身四个导出完全符合要求。

---

## 6. 缺陷表

| # | 文件 | 行号 | 问题 | 为什么会导致失败 | 建议修法 | 级别 |
|---|---|---|---|---|---|---|
| **D1** | `lib/client.js` | 全文件（19-31） | **未导出 `inject`**。文件只 `export function apply`，缺 `export const inject = ['slots']` | `apply` 里访问 `ctx.slots`。cordis 的 context 代理（`ReflectService.handler.get`）对未在 inject 中声明的属性直接抛 `cannot get property "slots" without inject`。实测复现：`declared=[] -> THROWS: cannot get property "slots" without inject`；`declared=["slots"] -> OK`。⇒ client 半身加载即抛错，设置卡**必然不显示** | 在 `lib/client.js` 顶部加：`export const inject = ['slots']`。注意 `dsh.client.inject`（package.json 里那个）**只是激活顺序声明，不能替代**这个运行时 inject —— 宿主文档原文："`dsh.client.inject` entries only order activation and stay allowed" | **阻断** |
| **D2** | `lib/client.js` | 15-17 | 组件返回裸字符串 `'dsh-zcode-native · M0 骨架'`，非 React 元素 | React 18 支持函数组件返回字符串，**不会崩**；但偏离官方示例（`React.createElement('div', ...)`），且裸文本无任何样式/容器，在设置面板里排版不可控。若后续宿主对 slot 内容做 `React.Children` 相关处理，裸字符串行为不确定 | 改为 `return React.createElement('div', null, 'dsh-zcode-native · M0 骨架')`，或返回 `null` 先只验证注册链路 | 中 |
| **D3** | `docs/zcode-native/M0-DONE.md` | 10、12 | 行数失真：声称 `cordis.patch.yml` 6 行（实际 **10**）、`lib/client.js` 11 行（实际 **31**） | 不导致加载失败，但文档与实际不符，会误导后续维护者判断改动范围 | 更正为实际行数 10 / 31 | 文档 |

### 补充观察（不构成缺陷，但需 Lead 知晓）

- **`lib/index.js` 的 `apply` 里 `config` 参数未被使用**。M0 阶段无害，但 `Config` 声明了 `debugPort`/`cacheMs` 却完全不用，属占位。
- **`package.json` 的 `peerDependencies` 声明 `react: ^18.2.0`**。asar 内 `react@18` 出现 3 次，版本匹配，无冲突。但 client 半身当前**不 import react**，D2 若改用 `React.createElement` 才需要真正引入。
- **`dsh.client.inject` 三项**（`dsh-client-runtime` / `dsh-client-ui-slots` / `dsh-client-ui-settings`）与实际用到的能力**匹配**：用了 `ctx.slots` → 已含 `dsh-client-ui-slots`。这一项没问题（问题在运行时 `inject`，见 D1）。
- **`README.md` 写"DeepSeek Hub"**，正确全称是 **DeepSeek Harness**。纯文案问题。

---

## 7. 可进入挂载的判据

修掉 **D1** 后即可进入挂载。D2 建议一并修（成本极低）。D3 属文档。

修完后的**唯一有效判据仍是肉眼确认**：重启 DSH Desktop 后，设置页出现「ZCode Native」分区且内容可见。日志不可作判据 —— `ctx.logger.info` 不进 harness.log，且 `slots.inject` 对未声明 slot 静默等待、不报错不打日志。

---

## 8. 取证命令清单（可复现）

```bash
# exports 四项解析
node -e "const {createRequire}=require('node:module');const r=createRequire(process.cwd()+'/x.js');
for(const t of ['.','./client','./cordis.patch.yml','./package.json']){try{console.log(t,r.resolve('dsh-zcode-native'+(t==='.'?'':t.slice(1))))}catch(e){console.log('FAIL',t,e.code)}}"

# YAML 真实解析（宿主 js-yaml）
node --input-type=module -e "import {readFileSync} from 'node:fs';
const y=await import('<profile>/node_modules/js-yaml/index.js');
console.log(JSON.stringify((y.default?.load??y.load)(readFileSync('./cordis.patch.yml','utf8'))))"

# asar 字节计数
python3 -c "d=open('/Applications/DSH Desktop.app/Contents/Resources/app.asar','rb').read();
print('- insert:',d.count(b'- insert:'),'| type: insert',d.count(b'type: insert'))"

# client 导出实测
node --input-type=module -e "import {pathToFileURL} from 'node:url';
const m=await import(pathToFileURL('./lib/client.js').href);console.log(Object.keys(m))"
```

---

## 复核（Round 2）

- 复核时间：2026-10-25 18:30 +08:00
- 复核范围：仅改动面（`lib/client.js` 的 `inject` / React 引入 / 组件返回值），外加 `M0-DONE.md`、`README.md` 文案
- 复核方式：同 Round 1，全部重新取证

### R2.0 复核判定

# `NEEDS_FIX`

Round 1 的 D1（缺 `inject`）**已修对**；但 Lead 为修 D2 新增的 `import React from 'react'` **引入了新的阻断缺陷** —— client 半身不是 ESM，`import` 语句在浏览器里直接是语法错误。修完 D1 反而把整块打回不可加载。

### R2.1 【阻断·新】`lib/client.js` 的模块格式错误 —— client 半身不是 ESM

**Lead 的疑问**：「`import React from 'react'` 在 client 半身是否合法（是 ESM 被转译，还是必须用 `require`）？」

**答：不合法，且不是"被转译"的关系。client 半身的文件字节被原样当经典脚本执行，没有任何转译环节。**

四条独立证据：

**证据 1 —— `exports["./client"]` 指向的文件就是最终产物，无构建步骤**

`dsh-client-modules/lib/index.js:748-753`：

```js
const clientRel = clientExportOf(packageName, pkg.exports);
if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
const resolved = { packageName, meta: { clientPath: join(dirname(pkgPath), clientRel), ... } };
```

`clientPath` 直接由 `exports["./client"]` 拼出，中间没有任何构建/转译调用。`lib/client.js` 的字节 = 浏览器收到的字节。

**证据 2 —— 字节被原样读出并作为 bundle 服务**

`dsh-client-modules/lib/index.js:642`：`const bundle = readFileSync(record.meta.clientPath);`
`prepareSource()`（:253）只做两件事：剥离 `//# sourceURL=` / `//# sourceMappingURL=` 尾部、补一个换行。`buildComboScript()`（:338-342）只做字符串拼接 `source += \`${prepareSource(resource).source};\n\``。**没有任何 parse/transform/babel 步骤。**

**证据 3 —— 注入到页面的是经典脚本，不是 module**

- 服务端 `dsh-host-webserver/lib/index.js:39-42`：`case "script-src": markup: \`<script src="${...}"><\/script>\`` —— 无 `type="module"`。
- 浏览器端 `dsh-client-modules/lib/client.js:600-612`（`defaultLoadBundle`）：`document.createElement("script")` + `el.src = url`，同样**从不设置 `el.type = "module"`**。
- `dist/index.html` 中 `importmap` 出现 **0 次**（实测），`type="module"` 只用于 shell 自己的入口 `assets/index-CN7NIWNw.js`。插件 bundle 走的是经典 script，`import` 无任何可用的解析上下文。

**证据 4 —— asar 内 86 个 client bundle，86/86 全部用 `__ModuleLoader__.load` 信封，0 个含 ESM 语法**

对 `dsh.client` 声明齐全的 86 个包，逐一解析 `exports["./client"]` 指向的真实文件：

```
client packages scanned: 86
start with __ModuleLoader__.load: 86
contain top-level ESM import/export: 0
```

无一例外。官方模板 `templates/decoration/client.js` 也是同一格式（`window.__ModuleLoader__.load({ id, factory(require) {...} })`）。

**实测复现**（vm 按经典脚本执行，模拟 `<script src>`）：

```
=== A. 当前 lib/client.js（ESM 语法）作为经典脚本执行 ===
{ "ok": false, "stage": "execute",
  "error": "SyntaxError: Cannot use import statement outside a module" }

=== B. 正确信封格式（参照 asar 内 86/86 个 bundle）===
{ "ok": true, "stage": "ok", "id": "dsh-zcode-native",
  "exportKeys": ["inject", "apply"], "inject": ["slots"],
  "applyType": "function", "pluginShapeOk": true }
```

**后果链**：语法错误 → `defaultLoadBundle` 的 `load` 事件仍会触发（script 已下载并"执行"失败）→ `arrive()` 判定 `"loaded without registering "dsh-zcode-native" via __ModuleLoader__.load"` → `arrive()` 抛 `client-modules: could not load "dsh-zcode-native"` → `ClientEntries.start()` 把它计入 `requiredFailures`（该行不含 `dsh-desktop-workbenches`，不享受降级）→ **`web boot: N entries did not activate`，整页插件启动失败**。

这不只是"设置卡不显示"：**它会让 web 端启动审计整体报错**，比其他插件的失败更容易被看见。

**正确写法**（与社区版 `zcode-assets-20261025/tmp/zcode-src/lib/client.js:22-220` 完全同构，该文件已实测可用）：

```js
window.__ModuleLoader__.load({
  id: 'dsh-zcode-native',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const React = require('react');

    function ZcodeNativeSection() {
      return React.createElement('div', null, 'dsh-zcode-native · M0 骨架');
    }

    function apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register(
        { name: 'settings.section', id: 'zcode-native', order: 90, label: () => 'ZCode Native' },
        ZcodeNativeSection,
      ));
    }

    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
```

**关键点**：`React` 必须来自 factory 参数 `require('react')`，**不能**用 `import`，也不能用裸全局 `React`（factory 只收到 `(require)`，React 由 `makeRequire` 从 platform seed 表解析：`staticModules` 里含 `react` / `react/jsx-runtime` / `react-dom`，见 `dist/assets/index-CN7NIWNw.js` 的 `SZ()`）。

> 补充：Lead 引用社区版「`const React = require("react")`」作为依据是**对的**，但只抄了那一行、没抄外层信封 —— 该 `require` 的合法性来自它处在 `factory: (require) => {...}` 内部。单独把这行搬进 ESM 文件里并不成立。

### R2.2 D1 修复验证 —— ✅ 修对了

`lib/client.js:23` `export const inject = ['slots']` 已补上。判定依据与 Round 1 相同且已复测：

- cordis context 代理 `ReflectService.handler.get`（`cordis/lib/index.js:672-695`）对未在 `fiber.inject` 中声明的属性抛 `cannot get property "slots" without inject`。
- `slots` 是真实服务名：`SlotRegistry` 构造 `super(ctx, "slots")`（`dsh-client-ui-renderer/lib/client.js:1348`）。
- 对照三个内置 settings 分区：`settings-plugins` = `["slots", "locale"]`、`settings-general` 以 `"slots"` 起头、`agent-preset` 以 `"slots"` 起头 —— `slots` 确实是必需项。

**但注意**：D1 的修复目前被 R2.1 的语法错误完全掩盖 —— 文件根本执行不到 `apply`。**必须先修 R2.1，D1 才谈得上生效。**

### R2.3 inject 列表是否只写 `['slots']` 就够 —— ✅ 够

逐项核对 `apply` 实际触达的 ctx 能力：

| 触达 | 来源 | 是否需要声明 |
|---|---|---|
| `ctx.slots` | `ctx.slots.inject` / `ctx.slots.register` | **需要**，已声明 ✅ |
| `ctx.effect`（隐式） | `slots.inject` 内部 `ctx.effect(...)`（`ui-renderer:1371`） | **不需要**。`effect` 属 cordis 内建 verb，走 `fiber.effect`，不在 service 解析路径上（`cordis/lib/index.js:329-337` 直接用 `this.ctx.fiber.effect`） |
| `React.createElement` | 组件渲染 | **不需要**。React 来自 `require('react')` 的 platform seed，不是 ctx 服务 |

内置对照：`settings-plugins` 用 `["slots", "locale"]` 是因为它调了 `ctx.locale.bind(NS)`。本插件 label 用硬编码字符串、未碰 locale，**所以只声明 `slots` 是正确的，多写反而会引入无谓的激活依赖**。

一处可选的改进（非缺陷）：若后续要走官方 locale 通道，需补 `locale` 并加 `locale/zh.json`。M0 不必。

### R2.4 D2 / D3 / README 复核

| 项 | 状态 | 说明 |
|---|---|---|
| D2 组件返回 React 元素 | ✅ 思路正确 | `React.createElement('div', ...)` 方向对，但依赖 R2.1 的 `require` 才能落地 |
| D3 行数更正 | ✅ 已核 | 实测 `wc -l`：`cordis.patch.yml`=10、`lib/client.js`=46、`lib/index.js`=14，与 `M0-DONE.md` 表格一致 |
| README "DeepSeek Harness" | ✅ 已核 | 已改 |
| `M0-DONE.md` 新增「Lead 修复记录」 | ⚠️ 需补一行 | 表格 F3 写「补 `inject`，并 `import React from 'react'`」—— 该修法本身错误，应改为「改为 `__ModuleLoader__` 信封 + `require('react')`」。否则文档会把错误写法固化成"已修好的证据" |

### R2.5 【中】`M0-DONE.md` 与 `M0-VERIFY` 的方法论风险（非代码）

`M0-DONE.md` F3 行把「`import React from 'react'`」记为已完成的修复项，而该写法会让插件无法加载。文档作为后续维护依据会误导下一轮。建议在 R2.1 修完后同步更正该行。

### R2.6 复核结论与待修清单

**必须修（阻断，1 条）**

| # | 文件 | 位置 | 问题 | 修法 |
|---|---|---|---|---|
| **R2-1** | `lib/client.js` | 全文件（20-46） | 用 ESM `import`/`export`，但该文件字节被当经典脚本执行（`<script src>` 无 `type=module`、无 importmap、无构建步骤）。`import React from 'react'` → `SyntaxError: Cannot use import statement outside a module` | 整体改写为 `window.__ModuleLoader__.load({ id: 'dsh-zcode-native', factory: (require) => {...} })` 信封；`const React = require('react')`；用 `exports.inject = ['slots']` / `exports.apply = apply` / `return module.exports` |

**建议修（非阻断）**

| # | 文件 | 位置 | 问题 |
|---|---|---|---|
| R2-2 | `docs/zcode-native/M0-DONE.md` | 修复记录表 F3 | 把 `import React from 'react'` 记为正确修法，与 R2-1 冲突，需同步更正 |

**已确认修对，无需再动**：D1（`inject`）、D3（行数）、README。

**修完 R2-1 后的唯一有效判据不变**：重启 DSH Desktop，设置页出现「ZCode Native」分区。日志仍不可作判据（`slots.inject` 对未声明 slot 静默等待）。但**这次有一个新的可观察信号**：若 R2-1 未修，web 端启动会在控制台/启动审计里报 `web boot: N entries did not activate`，这是比"设置卡不显示"更早、更明确的失败信号。

### R2.7 复核取证命令

```bash
# 1. 模块格式分布（决定性证据）
node --input-type=module -e '
import * as A from "/tmp/asarx.mjs"; import path from "node:path";
let n=0, loader=0, esm=0;
for (const k of A.list()) {
  if (!/^node_modules\/((?:@[^/]+\/)?[^/]+)\/package\.json$/.test(k)) continue;
  let pkg; try { pkg = JSON.parse(A.readFile(k)); } catch { continue; }
  if (!pkg.dsh?.client) continue;
  const ex = pkg.exports?.["./client"];
  const rel = typeof ex === "string" ? ex : ex?.default;
  if (typeof rel !== "string") continue;
  const t = A.readFile(path.posix.normalize(path.posix.dirname(k)+"/"+rel));
  n++; if (/__ModuleLoader__\.load\(\{/.test(t)) loader++; if (/^\s*(import\s|export\s)/m.test(t)) esm++;
}
console.log("scanned="+n, "loaderEnvelope="+loader, "esmSyntax="+esm);'

# 2. 经典脚本执行实测（当前文件必失败）
node --input-type=module -e '
import vm from "node:vm"; import fs from "node:fs";
try { vm.runInNewContext(fs.readFileSync("./lib/client.js","utf8"), {console}); }
catch(e){ console.log(e.constructor.name+": "+e.message); }'
# 期望输出：SyntaxError: Cannot use import statement outside a module

# 3. 确认注入无 type=module
grep -n 'case "script-src"' -A3 <(node -e 'import("/tmp/asarx.mjs").then(m=>console.log(m.readFile("node_modules/@deepseek-ai/dsh-host-webserver/lib/index.js")))')
```

### R2.8 一句话给 Lead

> `import React from 'react'` **不可用**。client 半身是 `__ModuleLoader__` 信封里的经典脚本（asar 内 86/86 无一例外，0 个 ESM），`import` 会直接 SyntaxError 让整个 web 端插件启动失败。React 必须写成 `factory: (require) => { const React = require('react'); ... }`。`inject = ['slots']` 这条修对了、也只写 `slots` 就够。**当前状态仍为 `NEEDS_FIX`。**

---

## 收尾确认（Round 3）

- 确认时间：2026-10-25 18:32 +08:00
- 范围：`lib/client.js` 最终态实跑 + `scripts/mount-zcode-native.mjs` 三处关键动作

### R3.0 判定

# `PASS`

`lib/client.js` 已无阻断问题，可以执行挂载。

### R3.1 `lib/client.js` 实跑（不是只看语法）

用 vm 按经典脚本执行，mock `__ModuleLoader__` + mock `require('react')`：

```
1. classic-script execute: ok
2. registered count: 1
3. id: dsh-zcode-native | id === package name: true
4. exports keys: [ 'inject', 'apply' ] | inject: ["slots"]
5. slots.inject key: ["settings.section"]
6. register spec: {"name":"settings.section","id":"zcode-native","order":90}
7. 2nd arg is function: true
8. spec has render key: false
10. rendered element: {"$$el":"div","props":null,"kids":["dsh-zcode-native · M0 骨架"]}
```

逐项对照宿主契约：

| 检查 | 要求 | 实测 | 判定 |
|---|---|---|---|
| 模块格式 | 经典脚本，无 ESM 语法 | 无 `import`/`export`，`vm` 执行无 SyntaxError | ✅ |
| 注册信封 | `__ModuleLoader__.load({id, factory})` | 注册 1 次，`id === 'dsh-zcode-native'`（与包名一致，`stripClientSuffix` 后对得上） | ✅ |
| factory 返回 | 插件对象 | `{inject, apply}` | ✅ |
| `inject` | 数组含 `slots` | `["slots"]` | ✅ |
| `apply` | 函数 | function | ✅ |
| 第二参数 | React 组件 | function | ✅ |
| spec 无 `render` | 无该键 | `'render' in spec === false` | ✅ |
| `label` | string \| thunk | thunk，返回 `'ZCode Native'` | ✅ |
| 组件返回 | React 元素 | `{$$el:'div', kids:[...]}` | ✅ |

`id` 与包名一致这点值得单独说明：`register()` 里 `ownerId = stripClientSuffix(registration.id)`，宿主用这个 id 去 `graphRows` 查对应行。写成包名（而非任意别名）才保证 `arrive()` 的 "registered" 判定能对上。

### R3.2 挂载脚本三处动作 —— ①②③ 全部正确

**① profile `package.json`：dependencies + bundles —— ✅ 正确**

读真实 profile（`profiles/web/package.json`）确认现状：`dependencies` 里已有 8 个 `link:` 形态依赖（`dsh-amd-model-load`、`dsh-zcode-connect` 等），`dsh.profile.bundles` 27 项。脚本的 `depSpec = \`link:${WORKSPACE}\`` 与既有约定一致，`bundles` 追加写法（`[...bundles, PKG_NAME]`）正确保留原顺序 —— 顺序有意义，宿主按 `dsh.profile.bundles` 顺序叠加 patch 层（`app-boot.js:1067`）。

脚本还做了 `must(wsPkg.name === PKG_NAME)` 前置校验，避免名字不符时写坏 profile。

**② `node_modules` symlink —— ✅ 动作正确，但"因为只改 package.json 不够"这个理由不准确**

脚本注释写「HMR 靠 symlink 解析 bundle」，实际上：
- `link:` 协议**本身**就让 pnpm 生成 symlink。活证据：`profiles/web/node_modules/dsh-amd-model-load` 已是指向工作区的 symlink，那是 pnpm 建的，不是谁手工建的。
- 所以脚本第 3 步在 `pnpm install` 之后跑，绝大多数情况是**幂等空转**（`linkOk` 已为 true）。

但这一步**保留是对的**，理由是另一个：`pnpm install` 失败或没跑到时，symlink 是最后的兜底；且 `realpathSync` 双向校验能捕获"symlink 指向旧路径"这类静默错误。**建议只改注释**（把"HMR 靠 symlink"改成"pnpm 通常已建好，此处为幂等兜底与校验"），代码不用动。

**③ profile `cordis.patch.yml` 追加 insert —— ✅ 正确，且我做了字节级验证**

用宿主 js-yaml + 复刻的 `!!js` 自定义 schema 实跑脚本的拼接逻辑：

```
原始行数: 953 → 追加后: 961
追加前: OK | 数组=true | 条目=20 | insert型=4  | zcode-native=0 | zcode-connect保留=true
追加后: OK | 数组=true | 条目=21 | insert型=5  | zcode-native=1 | zcode-connect保留=true
```

原有 20 个条目（含 4 个 insert 型、`zcode-connect`、以及那堆 `!!js` 预设）全部完好，新增 1 条。`patch.replace(/\s*$/, '\n')` 保证末行换行，不会和上一行粘连 —— 这点很关键，profile patch 末尾原本就有 `bridgeMode: on-demand` 且以 `\n` 结尾（实测末字节 `0a`）。

**关于"双份 insert"：我专门查了，无害，不用改。**

当前 `cordis.patch.yml`（bundle 自带）已有一条 `zcode-native` insert，脚本又会往 profile patch 追加一条，等于两份。我验证了两层：

1. **patch 层不折叠**：复刻 `applyEntryPatches`（`cordis-plugin-include/lib/index.js:56-100`）实跑，两次 insert 确实产生两条同 id 条目。
2. **loader 按 id 折叠**：`EntryTree.update`（`cordis-plugin-loader/lib/index.js:81-95`）用 `Object.fromEntries(config.map(o => [o.id, o]))` 建 map，重复 id 自然折叠为 1 条，只 `create` 一次。

活证据：社区版 `dsh-zcode-connect` 正是双份 —— 它的 `package.json` 声明 `dsh.bundle.patch: ./cordis.patch.yml`（自带 insert），profile patch 第 947 行又有一条 `id: zcode-connect` insert，而它此刻正常工作。

**结论**：双份冗余但无功能影响。若想更干净，可以把 profile 那条删掉只留 bundle 自带的 —— 但**不建议在 M0 动**，多一条 patch 反而方便你临时调 `debugPort` 而不用改工作区源码。

### R3.3 一个已知的良性冗余：`dsh.client.inject` 里有个不存在的包

`package.json` 的 `dsh.client.inject` 列了 `@deepseek-ai/dsh-client-runtime`，我实测**该包在 asar 内不存在**：

```
@deepseek-ai/dsh-client-runtime    *** NOT IN ASAR ***
@deepseek-ai/dsh-client-ui-slots   IN ASAR
@deepseek-ai/dsh-client-ui-settings IN ASAR
```

**不影响加载**，因为 `dsh.client.inject` 的唯一用途是激活排序，且宿主对查不到的包静默跳过：

`dsh-client-modules/lib/client.js:808-811`：
```js
for (const packageName of row.inject) {
  const dependency = this.graphRows.get(packageName);
  if (dependency !== void 0) await this.arriveDependency(row.id, dependency, [], visited);
}
```
`graphRows.get()` 返回 `undefined` 就跳过，不抛错。

这个值是照抄社区版 `dsh-zcode-connect` 的（它也有这一项，同样不存在）。**建议 M1 时清理成两项**（`dsh-client-ui-slots` + `dsh-client-ui-settings`），但不是 M0 的阻断项。

### R3.4 挂载后验证要点（给 Lead）

`profiles/web/package.json` 里 `"patchReload": "live"` —— 意味着 patch 层可能热重载。但**首次新增 bundle 仍需重启**：新 bundle 要在 `loadProfileDirectory` 阶段解析，那是启动期行为（`app-boot.js:1057` `resolveBundleDir`）。

重启后按顺序看三处：
1. **最先看**：若 client bundle 仍格式错，控制台会先报 `web boot: N entries did not activate`（这次不会了，已 PASS）。
2. 设置页左侧导航出现「ZCode Native」，位置在 `order: 90`（`plugins=15`、`agent-presets=20`、`market=40` 之后）。
3. 点进去，正文是 `dsh-zcode-native · M0 骨架`。

日志仍不可作判据（`slots.inject` 对未声明 slot 静默等待）；但 **host 半身**的 `console.log('[zcode-native] loaded')` 可在 `harness.log` 里确认 host 侧是否加载 —— 这是唯一能从日志确认的信号。

### R3.5 最终判定

**`PASS` —— 可以执行 `scripts/mount-zcode-native.mjs --apply`。**

三处动作全部正确，无需修改即可挂载。两条非阻断建议（可选，不阻塞挂载）：
- 脚本第 3 步注释措辞（"HMR 靠 symlink" → "pnpm 通常已建好，此处为幂等兜底"）
- `dsh.client.inject` 清理掉不存在的 `@deepseek-ai/dsh-client-runtime`（M1 再动）
