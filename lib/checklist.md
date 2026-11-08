# ZCode 派活前的人工前置检查 + DOM 项目守卫

## 为什么需要

`zcode_ask` 驱动的是 ZCode **当前前台窗口**。桥没有切换项目/会话的参数，也不授予权限。
跳过检查的真实后果：任务写错目录、**派到别的项目的会话**、权限确认把任务卡死、取答通道失效导致误报超时。

## 第 0 步（强制）：DOM 项目守卫

**ZCode 里开着不止一个项目或会话时，每次派活前都必须跑。** 不跑就是盲发。

### 不能靠项目名做全文匹配

`document.body.innerText` 的**开头 600 字符是左侧任务列表**，列出所有项目名——用它匹配会误判。
反过来，会话正文里也有目标项目路径（prompt 自己写的），全文匹配同样会误判通过。

### 正确判据：读 48px 会话标题条

```js
// CDP Runtime.evaluate，只读
(() => {
  const h = [...document.querySelectorAll('div')].find(d => {
    const c = (d.className || '').toString()
    const r = d.getBoundingClientRect()
    return c.includes('app-region:drag') && r.height >= 40 && r.height <= 60 && r.width > 600
  })
  return h ? (h.innerText || '').trim() : ''
})()
```

返回形如 `"make zcdoe plugin编码任务"`。**按实际显示的标题匹配，不要按你预期的正确拼写**
（用户手打的项目名常带拼写错误）。

### 守卫四条，任一不满足就停下问用户，不要发送

1. 标题条存在且非空
2. 标题包含目标会话标题片段
3. `停止生成` / `工作中` 按钮**不存在**（空闲）
4. composer `[contenteditable="true"]` 的 `innerText.trim() === ''`

不满足时输出 `{"ok":false,"stage":"wrong-project","headerText":"<实际>","expected":"<期望>"}`，
然后告诉用户当前前台是 X 不是目标 Y。

### 血的教训（实测）

- 用 `body.slice(0,600)` 当头部 → 读到左侧任务列表 → **误拦一次正确的派活**。
- 用全文匹配 → 会话正文含目标路径 → **误判通过，实际派到 amd-model-load 的会话**。
- 取答用 `turns[turns.length-1]` → 发送失败时**取到上一轮旧答案**并当成本轮结果上报。

## 执行时机

每个会话第一次派活前必须问。同会话同项目之后可直接派；换项目重新问。
**多项目并存时每次都要跑第 0 步。**

不需要问：`zcode_status` / `zcode_capabilities` / `zcode_runs`（只读免费）。

## 四步检查

**第 1 步：CDP 端口**（agent 自查）

```bash
curl -s --max-time 5 http://127.0.0.1:9222/json/version >/dev/null && echo "CDP OK" || echo "CDP FAIL"
```

失败时可靠修复（macOS）——ZCode 3.17.1 必须在 ZCode 完全退出后由终端带 --remote-debugging-port=9222 启动：

```bash
pkill -f "/Applications/ZCode.app/Contents/MacOS/ZCode"; sleep 2; \
  nohup /Applications/ZCode.app/Contents/MacOS/ZCode --remote-debugging-port=9222 >/tmp/zcode-cdp.log 2>&1 & \
  sleep 5; curl -s http://127.0.0.1:9222/json/version | head -3
```

⚠️ `open -a ZCode --args --remote-debugging-port=9222` **只在 ZCode 完全退出时有效**；
Electron 单实例锁会在已有实例运行时静默丢弃 `--args`（3.17.1 的 argv 解析器还会直接报 bad option）。

**第 2 步：项目目录**（问用户）——请在 ZCode 打开目标项目，当前是哪个？
**第 3 步：完全访问权限**（问用户）——否则终端命令会被权限确认拦住。
**第 4 步：完成通知已开启**（问用户）——辅助信号。

## 派活：输入必须校验，发送必须确认产生新回合

### 清空 composer（`execCommand` 无效）

`execCommand('selectAll')` + `delete` **清不掉**这个 composer，必须用键盘事件：

```js
await evaluate(`document.querySelector('[contenteditable="true"]').focus()`)
// Cmd+A（macOS modifiers=4 / Windows Ctrl=2），再 Backspace
await send('Input.dispatchKeyEvent', { type:'keyDown', modifiers:4, key:'a', code:'KeyA', windowsVirtualKeyCode:65 })
await send('Input.dispatchKeyEvent', { type:'keyUp',   modifiers:4, key:'a', code:'KeyA', windowsVirtualKeyCode:65 })
await send('Input.dispatchKeyEvent', { type:'keyDown', key:'Backspace', code:'Backspace', windowsVirtualKeyCode:8 })
await send('Input.dispatchKeyEvent', { type:'keyUp',   key:'Backspace', code:'Backspace', windowsVirtualKeyCode:8 })
```

清空后**断言** `innerText.trim() === ''`，否则中止（残留会拼成脏 prompt）。

### 输入后逐字校验

```js
await send('Input.insertText', { text: PROMPT })
const typed = await evaluate(`document.querySelector('[contenteditable="true"]').innerText.trim()`)
if (typed !== PROMPT) abort('verify')   // 不匹配就中止，绝不发送
```

### 发送后确认新回合出现

```js
const before = await countTurns()
await evaluate(`[...document.querySelectorAll('button')].find(b => (b.innerText||'').trim() === '发送').click()`)
// 轮询最多 20s 直到 turnCount > before；否则 abort('no-new-turn')
```

**没有新回合 = 没发出去**。此时绝不能读"最后一个回合"。

## 派活后：等完成 → 判相关 → 验产出 → 自决

### 完成判定

| 元素 | 选择器 |
|---|---|
| 输入框 | `[contenteditable="true"]`（全页仅 1 个） |
| 发送按钮 | `button` 且 `innerText.trim() === '发送'`（生成中变「停止生成」） |
| 回合容器 | `[class~="group/assistant-turn"]` |
| 答案节点 | 回合内最后一个 `[class~="group/assistant-row"]` |

**必须用 `class~=` 精确 token。** 用 `class*=` 会同时命中工具栏
`group-hover/assistant-turn:opacity-100`，取到「复制 赞 踩 分叉 18:01」而误报失败。

**取答按 `turns[before]` 索引**，不要取最后一个。
完成判据：`停止生成` 出现后消失 + 答案文本连续 2 次采样（1000ms）不变。
短答 2–7 秒，中等编码任务 3–4 分钟。

### 四步收尾

1. **判断结果是否属于本会话派出的任务**（对照标题/项目/批次号）
2. **以磁盘为准验产出**：读被改的文件、看 mtime、**自己跑测试**。ZCode 自述不算数。
3. **自决继续还是收工**：通过则派下一个；不符则带具体失败信息重派；需人判断时不要自作主张。
4. **需要用户时**：总结已完成、列出待决、说明卡在哪，然后停下等。

## 要点

- **超时 ≠ 失败**：任务可能还在跑或已完成。**绝不重发**（重复扣额度 + 重复干活）。
- **每次 ask 都是全新会话**：prompt 必须自包含（背景 + 绝对路径 + 文件范围 + 改什么 + 验收标准）。
- **cwd 会漂移**：可能停在 `~/.zcode/workspace/default` 或 `draft-<uuid>`，prompt 里写绝对路径双保险。
- **额度有期限**：Start Plan 类套餐到期后 ask 报上游错误，派活前确认 plan 仍 active。
- **ZCode 写的代码必须独立验证**：实测它会漏致命契约（信封格式、inject 声明、patch 结构），
  也会误报"已完成"（把上一轮旧答案当本轮结果）。验证方要自己跑测试、自己读磁盘。

## 一句话原则

ZCode 是"手"：手放在哪个项目、有没有全权限，由用户摆好；DSH 是"脑"：负责确认手在正确的位置、
把任务写清楚、把结果收回来并验证。
