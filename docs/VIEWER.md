# 虚拟桌面面板（DSH「应用」侧栏里的一页）

> 目标：在 DSH 界面里像豆包电脑控制那样，**看着桌面、手动点**。
> 入口固定在左侧「应用」栏里，名字叫「DSH操作电脑」，点开占满中央面板——不是浮窗胶囊。
> 本文说明它挂在哪里、数据怎么走、以及当下阶段的硬限制。

## 结构：两半

| 半 | 文件 | 职责 |
|---|---|---|
| 宿主（Node） | `src/viewer.mjs` | 在 `127.0.0.1:17872` 起一个极小 HTTP 端点，把 `DesktopSession` 的采样/输入暴露为 JSON |
| 浏览器 | `client.js` | lazy-CJS 工厂，通过 `ctx.slots` 往 `sidebar.panellist` 注册一行（图标 + 名字），往 `main` 注册同 key 的整页组件 |

`package.json` 必须同时声明才能被加载：

```json
"exports": { "./client": "./client.js" },
"dsh": {
  "client": {
    "platform": "web",
    "inject": ["@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-ui-sidebar"]
  }
}
```

0.2.x 里 `dsh-client-runtime` 已不存在（拆成 connection / modules / ui-renderer / ui-slots），
插槽服务 `slots` 由 `@deepseek-ai/dsh-client-ui-renderer` 提供；
`sidebar.panellist` / `main` 这两个座位由 `@deepseek-ai/dsh-client-ui-sidebar` 声明，所以两个都列。

`dsh.client.inject` 列的是**包名**（浏览器模块依赖），不是 Cordis 服务名；
服务名写在 client bundle 里的 `export const inject`（这里只等 `slots`）。

## 挂载点：sidebar.panellist + main

0.2.2 的侧栏契约（`@deepseek-ai/dsh-client-ui-sidebar` 的 SlotMap）：

| 座位 | 形态 | 注册项 | 说明 |
|---|---|---|---|
| `sidebar.panellist` | list 槽 | `{ name, id, order, label }` + 组件 | 「应用」列表里的全局项；每项的 `id` 对应 `main` 里同 key 的一页，行文字由侧栏从 `label` 读 |
| `main` | keyed 槽 | `{ name, key }` + 组件 | 中央面板；`key` 必须与侧栏 `id` 相同。保留 key `conversation` 是会话本身，别的 key 没有 Session 绑定 |

`client.js` 就是这么挂的：

```js
ctx.slots.inject('sidebar.panellist', () =>
  ctx.slots.register(
    { name: 'sidebar.panellist', id: 'dsh-deputy-desktop', order: 40, label: 'DSH操作电脑' },
    DeputyIcon, // 收 { size, active }
  ),
)
ctx.slots.inject('main', () =>
  ctx.slots.register({ name: 'main', key: 'dsh-deputy-desktop' }, DeputyPage),
)
```

点这一行时，侧栏自己调 `ctx.layout.selectPanel(id)`，中央区切到同 key 的页——插件不需要
自己记「当前在哪页」，也不需要碰 layout 服务。

**不要注册进 `sidebar`**：整列被 ui-sidebar 的 SidebarRoot 占了，只接受 `sidebar.panellist`
这种内层座位。`shell.overlay` 浮层仍然存在，但本插件不再用它——用户要的是跟
「新建 / 搜索 / 免费搜索 / 定时任务」并列的常驻项，不是左下角浮窗。

## 数据面

```
client.js  ──GET /api/health ──► viewer.mjs ──► DesktopSession.state
           ──GET /api/status ──► status.mjs 的合成快照（os + browser 两段 + level）
           ──GET /api/frame  ──► capture() → 灰度 → encodeGrayPng → base64
           ──POST /api/input ──► 归一化坐标 → 像素 → 宿主 SendInput
           ──POST /api/open  ──► CreateDesktopW（Windows 上弹 UAC）
           ──POST /api/launch ► 宿主 CreateProcessW（支持 app 预设：edge / notepad）
           ──POST /api/close ──► 宿主退出，桌面销毁
```

刷新率 700ms：足够手动点选，又不会把宿主的 BitBlt 打满。**这不是直播**，是有节奏的采样。
切到别的页就不再拉帧（组件卸载时清定时器），不会在后台空转。

点击是**归一化坐标**（0..1）：页面被缩放、窗口宽窄变化，命中点不变。宿主协议要像素，
换算在 `viewer.mjs` 里做（见 `POST /api/input`）。

## 状态点：一个点代表两个组件

`/api/status` 返回 `src/status.mjs` 的合成快照：

```json
{ "ok": true, "level": "running",
  "os": { "state": "opened", "running": true, "error": null },
  "browser": { "state": "stopped", "running": false, "error": null } }
```

`level` 的优先级是 `error > running > idle`：任一组件最近出过错就是红，任一组件在跑就是绿，
都没开是灰。`client.js` 每 2 秒拉一次（没人订阅就停），把它渲染成侧栏那一行右侧的小圆点。

`dsh-deputy/os` 与 `dsh-deputy/browser` 是两个 Cordis 条目、互不 inject，
所以状态放在**模块级总线**而不是 ctx 服务里——同进程、同一份模块实例，两边都写得到。

## 空桌面不再回黑图

隔离桌面里一个窗口都没有时，宿主回 `{ code: 'NOWINDOW' }`（不再回退到桌面级 BitBlt 的黑图）。
面板把它渲染成「桌面里还没有窗口」+「启动 Edge」「启动记事本」两个按钮，
点按钮走 `POST /api/launch { app: 'edge' | 'notepad' }`，宿主按预设路径与参数起进程。

## 安全边界

- 端点只绑 `127.0.0.1`，不监听 `0.0.0.0`；
- 所有动作都落在**隔离桌面**里，不会碰到你正在用的主桌面；
- 没有中间人入口：不提供任意 shell 命令路由，只有 `open/close/launch/capture/input`；
- 风险点：本机进程，以及浏览器里能够请求回环地址的页面，都可能访问这个端口。
  当前为兼容 DSH WebView 保留了跨域响应，因此不要把它当成认证后的远程控制接口；
  不需要面板时请设置 `config.view.enabled = false`，或修改 `config.view.port` 降低误暴露。

## 已知限制

| 项 | 现状 |
|---|---|
| 真实画面 | 只在 Windows 上才有（宿主是 PowerShell + 逐窗口 `PrintWindow`）；其它平台 `/api/frame` 会明确回"桌面未打开"，并告诉客户端 `platform` |
| 鼠标移动 / 滚动 / 键盘 | 目前面板只发了 `click` 与 `type`；滚轮与拖拽需要给宿主加 `input.op` |
| 帧率 | 700ms 采样，不是流；拖窗口、拖动控件这类连续操作观感一般 |
| 中央面板 | 打开这页时中央区被整页占用，会话在另一个 key；靠侧栏切回对话 |
| 契约版本 | `window.__ModuleLoader__.load` / `ctx.slots.*` 是 rc 阶段契约，DSH 升级后可能需要跟改 |

## 验证

```bash
node --check client.js
node --check src/viewer.mjs
node test/run-tests.mjs
node scripts/check-plugin.mjs
```

测试中的 HTTP 面板用例会启动随机空闲端口，真实走一遍：
health → open → 三个并发 frame（只采一次）→ click 坐标换算 → 非法输入 400 → 错误方法 405 → close。
它使用内存假宿主，因此 Linux/macOS 也能验证协议；Windows 真实桌面仍需在目标机回归。
`check-plugin.mjs` 另外断言 client.js 注册的是 `sidebar.panellist` + `main`、侧栏名是「DSH操作电脑」、
且不再出现 `shell.overlay`，防止改回浮窗胶囊。
