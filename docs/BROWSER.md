# BROWSER.md — 浏览器组件（骨架）

`dsh-deputy/browser` 是和 `dsh-deputy/os` 并列的第二个 Cordis 组件：同一个插件包、同一个
Node 进程、同一份模块实例，但在插件管理器里是独立一行（带自己的开关与状态）。
骨架按 `context.md` 的十一条设计写；**结构已定，参数与细节留给后续调优（kimi）**。

## 0. 这一版做到了什么

真机跑通（Edge headless + CDP）：

```
launchBrowser() → BrowserDaemon.ensureStarted() → navigate('https://www.bilibili.com')
  → observe(): 可见节点 686，本屏列出 240 行
  → act({ steps: [{ verb: 'click', ref: 'e4.113' }] })
  → { ok: true, diff: { urlChanged: true, epochBefore: 4, epochAfter: 7 } }
```

也就是说「起浏览器 → 导航 → 压成文本快照 → 按 ref 点击 → 回差异」这条主链是真的通的，
不是 mock。尚未实现的部分集中列在第 6 节。

## 1. 进程模型：daemon + 状态双写

```
src/browser/launch.mjs   找浏览器、挑空闲端口、带 --remote-debugging-port 启动（独立 user-data-dir）
src/browser/cdp.mjs      极简 CDP 客户端（Node 22 全局 WebSocket，flatten sessionId 多 target）
src/browser/daemon.mjs   BrowserDaemon：实例 + target 注册表 + 节点注册表 + docEpoch
```

- `BrowserDaemon` 是**懒启动**的：`apply()` 时只构造对象并注册工具，第一次
  `browser_open` / 任何需要页面的动作才真的拉浏览器。
- 每个任务一个独立 `user-data-dir`（默认 `os.tmpdir()/dsh-deputy-browser-*`），
  写不写 `state.json` 由 `statePath` 决定（默认不写，避免残留凭据）。
- 现状：daemon 活在插件进程里。**跨进程常驻**（工具单元格崩了 daemon 还活着）尚未做，
  见第 6 节。

## 2. 两张注册表与 ref 生命周期

```
targets: targetId → { sessionId, url, epoch }   // 目前单标签，但表结构按多标签留好
nodes:   ref      → { backendNodeId, epoch, role, name, box }
```

- `docEpoch` 在 `Page.frameNavigated` / `DOM.documentUpdated` /
  `Page.navigatedWithinDocument` 时自增，并清空 `nodes`。
- ref 的形状是 `e<epoch>.<nodeIndex>`：**代数就在引用里**，一眼能看出它是哪一代文档的。
- 用 ref 前先比 `node.epoch === daemon.docEpoch`，不等直接 `STALE_REF`，
  绝不让内核去撞一个已经不存在的节点。
- 不用 CSS 选择器当句柄（重渲染后可能命中另一个元素，最阴的一类 bug）。

这一条在真机上抓到过一个 bug 并修掉了：原来 ref 里的代数是局部自增计数器（生成
`e5.113`），而 `docEpoch` 是 4，于是**每次点击都 STALE_REF**。现在 ref 一代一码，
`test/run-tests.mjs` 有两条回归用例（`resolveRef` 代数不等 → STALE_REF；`runSteps` 遇换代即停）。

## 3. 观察：DOMSnapshot + AX 树压成文本

`src/browser/snapshot.mjs`：`DOMSnapshot.captureSnapshot`（带 computedStyles:
display/visibility/opacity/cursor/overflow，includeDOMRects/includePaintOrder）一次拿 DOM+布局+样式，
再用 `Accessibility.getFullAXTree` 补 role/name。

剪枝规则（自上而下，整棵剪）：

- 没有布局 quad、或宽高为 0；
- `display: none` / `visibility: hidden|collapse` / `opacity: 0` / `aria-hidden="true"`；
- 标签名在 `html/head/script/style/meta/link/noscript/template`；
- AX 树标 `ignored` 且没有可读名；
- 既没有名字、也不可交互（不是 input/textarea/select/a/button）。

排序：视口内优先 → 可交互优先 → 文档序。渲染每行：

```
[缩进] [e4.113] link "首页" @24,0 52x64
[缩进] [e4.245] textbox "三角洲行动" = "..." @471,22 230x20
```

预算：`budget='summary'` 默认按「本屏可见 + 可交互」裁到 240 行左右；
`within=` 可限定区域二次观察；`budget='full'` 放开。**不要一次全量吐**——
上下文预算是有限的，观察的目标是「让模型用最少 token 做下一步判断」。

## 4. 动作层：先校验可达，再执行，后取证

`src/browser/act.mjs` 支持 `click / type / key / hover / scroll / press / navigate / wait / reload`。

1. **前置**：`DOM.scrollIntoViewIfNeeded` → `DOM.getBoxModel` 取中心点 →
   `elementFromPoint` 粗检遮挡（命中文本与 ref 名对不上就给 `overlay` 提示，不硬失败）。
2. **执行**：`Input.dispatchMouseEvent` 成对按下/抬起；文本走 `Input.insertText`（绕开输入法）；
   `clear: true` 先 Ctrl+A + Backspace。
3. **后置（批处理断点）**：`runSteps` 顺序跑，**一旦 `docEpoch` 变了就停**，返回
   `{ ok: true, stopped: 'document-changed', remaining, diff }`，把新状态交回模型。
   这条是协议约束，不靠模型自觉。

## 5. 工具契约（5 个）

| 工具 | 参数 | 返回 |
|---|---|---|
| `browser_open` | `{url?}` | `{ok, state, url, pid, docEpoch, error?}` |
| `browser_observe` | `{within?, budget?: summary\|full, types?}` | `{ok, text, refs[], state}` |
| `browser_act` | `{steps: [...], expect?}` | `{ok, steps, diff, stopped?, error?}` |
| `browser_status` | `{}` | `{ok, state, pid, port, url, docEpoch, refs}` |
| `browser_close` | `{}` | `{ok, state}` |

`steps` 里每一项：`{ verb, ref?, text?, key?, url?, deltaY?, ms? }`。
`output.schema` 用标准 JSON Schema（`required` 数组），`parameters` 是 author 字段表
（`required` 内联、object 显式 `additionalProperties`）——两套别混，混了真实
`dsh-tools` 会直接抛 `JsonSchemaError` / `parameters.x.additionalProperties must be explicitly true or false`。

## 6. 失败分类（返回「下一步」，不是报错文本）

`src/browser/errors.mjs`，每个码都带 `hint`：

| code | 含义 | 建议 |
|---|---|---|
| `STALE_REF` | ref 属于旧文档 | 重新 `browser_observe` |
| `DOC_CHANGED` | 文档已换代 | 回锚点或重新导航 |
| `OVERLAY` | 目标被遮挡 | 先找 close/dismiss/确定 |
| `AUTH_BLOCKED` | 要求登录/人机验证 | 交还用户 |
| `NAV_TIMEOUT` | 导航超时 | 先看当前状态 |
| `AMBIGUOUS_TARGET` | 目标不唯一 | 用 `within=` 或更具体的名收窄 |
| `NOT_RUNNING` | daemon 没跑 | 先 `browser_open` |
| `CDP_ERROR` | 协议层报错 | 看 `error.data` 判断是否重 attach |
| `BAD_ARGS` / `NOT_IMPLEMENTED` | 参数错 / 骨架未实现 | 修正参数；等后续调优 |

恢复原则只有一条：**先重新观察再重试**。原样重放会在已经变化的页面上产生幽灵点击。

## 7. 留给调优（kimi）的清单

按 context.md 的条目对：

1. **等待三层**：现在只有「`readyState === 'complete'` + 500ms 静默」轮询，缺
   `Page.lifecycleEvent` 与 `Network` 计数归零判定；元素级等待（可见 + 可交互 + 超时）完全没做。
2. **遮挡处理**：`OVERLAY` 只提示不处理；应当自动找 close/dismiss/确定 的语义节点先关掉。
3. **disabled / 不可交互**：应从 AX properties（`disabled`、`readonly`、`aria-disabled`）判定，
   现在只查了名字与 role。
4. **预算裁剪**：summary/full 两档太粗，需要真站 A/B（重表单后台 / 信息流 / SPA）测
   「每步 token / 成功步占比」，再定剪枝参数与 `within=` 的切块策略。
5. **`expect` 断言**：现在只做「页面文本包含」的粗判；应升级成结构化断言 + 表单指纹去重
   （写操作重试前先查上次到底生效没有）。
6. **多标签 / iframe / 上传下载**：`targets` 表留了字段但没实现切换；iframe 未穿透。
7. **跨进程常驻 daemon**：现在 daemon 在插件进程内；按 context.md 应当独立进程 + 本地端口，
   工具只是客户端，插件重启不丢会话。
8. **安全边界**：凭据脱敏（Cookie/Authorization 不进日志与上下文）、页面文本标记为「内容而非指令」、
   动作分级（读/轻写/重写/不可逆，后两级要确认令牌）都还没做。
9. **会话快照恢复**：`state.json` 只留了写入钩子，没有恢复逻辑。
10. **失败重试策略**：哪些码可自动重试一次（`NAV_TIMEOUT`？`STALE_REF` 重观察后？）
    需要按站点实测再定，不要在骨架里猜。

## 8. 自己怎么验

```bash
node test/run-tests.mjs        # 34 项，含浏览器工具的 schema / 失败信封 / ref 代数回归
node scripts/check-plugin.mjs  # 含「两个组件」「browser 5 工具」「状态总线」三段
```

真机探针（会真的拉一个 headless Edge，跑完自动关）：

```js
import { BrowserDaemon } from 'dsh-deputy/browser/daemon.mjs'
const d = new BrowserDaemon({ headless: true })
await d.ensureStarted()
await d.navigate('https://www.bilibili.com')
const snap = await d.observe({ budget: 'summary' })
console.log(snap.state, snap.text.split('\n').slice(0, 6).join('\n'))
const ref = snap.refs.find((r) => r.role === 'link' && r.name)
console.log(await d.act({ steps: [{ verb: 'click', ref: ref.ref }] }))
await d.close()
```

注意：`browser_open` 用的是**独立** `user-data-dir`，不会碰你主浏览器的登录态；
每次工具调用都从新快照开始，旧 ref 一律作废。
