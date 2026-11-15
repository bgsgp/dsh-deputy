# 虚拟桌面面板（把隔离桌面放进 DSH 界面）

> 目标：在 DSH 界面里像豆包电脑控制那样，**看着桌面、手动点**。
> 本文说明它挂在哪里、数据怎么走、以及当下阶段的硬限制。

## 结构：两半

| 半 | 文件 | 职责 |
|---|---|---|
| 宿主（Node） | `src/viewer.mjs` | 在 `127.0.0.1:17872` 起一个极小 HTTP 端点，把 `DesktopSession` 的采样/输入暴露为 JSON |
| 浏览器 | `client.js` | lazy-CJS 工厂，通过 `ctx.slots` 注册到 `shell.overlay` 插槽：一个「桌面」按钮 + 一个可拖拽/可缩放浮窗 |

`package.json` 必须同时声明才能被加载：

```json
"exports": { "./client": "./client.js" },
"dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-client-ui-layout"] } }
```

`dsh.client.inject` 列的是**包名**（浏览器模块依赖），不是 Cordis 服务名；
服务名写在 client bundle 里的 `export const inject`（这里只等 `slots`）。

## 为什么挂 shell.overlay，不挂左侧导航

DSH 的左侧导航（插件 / 自动化任务 / 上下文洞察 / 学习 / 更多）不是公开插槽，
三方插件没有可靠位置往里塞一页。官方给插件的位置里，`shell.overlay` 是**整帧浮层**，
官方文档自己就把它描述为“always-on-top window 该待的地方”，正是这个需求的正确席位：

- 浮层默认 `pointer-events: none`，所以不挡界面；里面自己的按钮/窗口才开 `auto`；
- 与会话无关，切会话不消失；
- 可以拖、可以拉大——等价于“侧边一个窗口”。

左下角那个「桌面」小胶囊就是开关；点开就是窗。

## 数据面

```
client.js  ──GET /api/health ──► viewer.mjs ──► DesktopSession.state
           ──GET /api/frame  ──► capture() → 灰度 → encodeGrayPng → base64
           ──POST /api/input ──► 归一化坐标 → 像素 → 宿主 SendInput
           ──POST /api/open  ──► CreateDesktopW（Windows 上弹 UAC）
           ──POST /api/close ──► 宿主退出，桌面销毁
```

刷新率 700ms：足够手动点选，又不会把宿主的 BitBlt 打满。**这不是直播**，是有节奏的采样。

点击是**归一化坐标**（0..1）：面板被缩放、被拖大，命中点不变。宿主协议要像素，
换算在 `viewer.mjs` 里做（见 `POST /api/input`）。

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
| 真实画面 | 只在 Windows 上才有（宿主是 PowerShell + BitBlt）；其它平台 `/api/frame` 会明确回“桌面未打开”，并告诉客户端 `platform` |
| 鼠标移动 / 滚动 / 键盘 | 目前面板只发了 `click` 与 `type`；滚轮与拖拽需要给宿主加 `input.op` |
| 帧率 | 700ms 采样，不是流；拖窗口、拖动控件这类连续操作观感一般 |
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
