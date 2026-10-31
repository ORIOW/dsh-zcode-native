# dsh-zcode-native · M0 完成说明

日期：2026-10-25

## 文件清单（行数）

| 文件 | 行数 | 说明 |
| --- | --- | --- |
| `package.json` | 36 | 包描述 + exports 四项 + dsh.bundle.patch / dsh.client 注入 + peerDependencies |
| `cordis.patch.yml` | 10 | 一条 insert 补丁（id: zcode-native，`- insert:` 下挂列表） |
| `lib/index.js` | 14 | ESM 入口：name / inject / Config / apply |
| `lib/client.js` | 46 | ESM 客户端：`export const inject = ['slots']` + 注册 settings.section 设置卡 |
| `README.md` | 5 | 骨架简介 |

> 行数为 Lead 修复后的实测值。ZCode 初稿的行数（patch 6 / client 11）是估算，已按 `wc -l` 更正；同轮修复内容见下节「Lead 修复记录」。

## 两个关键点的处理方式

### 1. package.json 的 exports 四项

`exports` 同时声明四项，缺一不可：

- `"."` → `./lib/index.js`：主入口，供宿主加载插件主进程侧逻辑；
- `"./client"` → `./lib/client.js`：客户端入口，供 DSH web 客户端 bundle；
- `"./cordis.patch.yml"` → `./cordis.patch.yml`：让宿主能按字面路径解析到补丁文件（配合顶层 `dsh.bundle.patch: ./cordis.patch.yml`）；
- `"./package.json"` → `./package.json`：允许运行时读包信息（版本号等）。

同时 `files` 里包含了 `lib`、`cordis.patch.yml`、`README.md`，保证打包/发布时这些文件不会漏掉。

### 2. 设置卡插槽用 settings.section，而不是 settings.plugin.item

`lib/client.js` 通过 `ctx.slots.inject('settings.section', ...)` 注册设置卡（id: `zcode-native`，order: 90，label: `ZCode Native`），卡片内容目前只渲染一行文字 `dsh-zcode-native · M0 骨架`。

明确**没有**使用 `settings.plugin.item`：该插槽名在 DSH 0.2.1-rc.2 宿主里不存在（count=0），用了设置卡永远不显示。M0 阶段只验证注册链路可用，后续再往卡片里填真实配置 UI。

## Lead 修复记录（ZCode 初稿 → 可加载状态）

ZCode 初稿有 5 处会导致加载失败或误导，均已修复并取证：

| # | 文件 | 初稿问题 | 证据 | 修复 |
|---|---|---|---|---|
| F1 | `cordis.patch.yml` | 写成 `- type: insert` + 平铺字段 | 宿主 asar 内 `- insert:`=36、`type: insert`=**0**；`amd-model-load` 与社区版均为 `- insert:` 下挂列表 | 改为 `- insert:` 下挂列表 |
| F2 | `lib/client.js` | `slots.register` 把 `render:` 当 spec 字段 | 宿主 397 处调用均为 `register(spec, Component)`，spec 无 `render` 键 | 组件改作第二参数 |
| F3 | `lib/client.js` | **缺 `inject = ['slots']`**（阻断） | cordis 代理对未声明属性抛 `cannot get property "slots" without inject`；`dsh.client.inject` 只决定激活顺序，不能替代 | 补 `exports.inject = ['slots']` |
| F4 | `lib/client.js` | **写成 ESM（`import React from 'react'` + `export`）**（阻断） | client 半身不做转译：`exports["./client"]` 的字节被原样当**经典脚本**注入（无 `type="module"`、无 importmap、`prepareSource` 只剥 sourceMappingURL）。asar 内 86 个 `dsh.client` 包 **86/86** 用 `__ModuleLoader__.load` 信封，含 ESM 顶层语法的 **0** 个。后果不是卡片不显示，而是 `web boot: N entries did not activate`，**整个 web 端插件启动失败** | 改为 `window.__ModuleLoader__.load({ id, factory: (require) => {...} })` 信封，`React` 由 `factory` 的 `require` 取得 |
| F5 | `README.md` | 写作 "DeepSeek Hub" | 正确全称 DeepSeek Harness | 已改 |

### client 半身的两条硬契约（M1+ 继续适用）

1. **必须是 `__ModuleLoader__.load` 信封，不能有顶层 `import`/`export`。** 文件字节按经典脚本执行，`require` 的合法性来自它是 `factory` 的参数。
2. **`inject` 只需 `['slots']`**（最小集）：`ctx.effect` 是 cordis 内建 verb（走 `fiber.effect`，不经 service 解析），React 来自 platform seed。对照 `settings-plugins` 写 `["slots","locale"]` 是因为它调 `ctx.locale.bind(NS)`；M0 没碰 locale，**不要加**。
