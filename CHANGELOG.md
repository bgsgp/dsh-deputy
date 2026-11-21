# CHANGELOG

版本号规则：`主版本.本版本.总提交数`（标准三段 semver，pnpm/npm 可直接安装）。当前版本见 `package.json`。

## 1.2.31

### 对齐 DSH 0.2.2 的插件 ABI
- 版本号从四段 `1.2.0.31` 改为标准三段 semver `1.2.31`：pnpm/npm 本地 link 安装同样校验版本，
  四段会直接 `ERR_PNPM_BAD_PACKAGE_JSON: Invalid version`，导致装不进真实 profile。
- `package.json.repository` 改为 SSH（`git+ssh://git@github.com/bgsgp/dsh-deputy.git`），git remote 本来就是 SSH。
- 清单迁移：删除 `dsh.plugin.json`（0.2.x 已不读取），bundle / client / icon / `engines.dsh`
  全部写进 `package.json` 的 `dsh` 字段；新增 `assets/icon.svg`。
- `engines.dsh = ">=0.2.2-rc.1 <0.2.3-0"`、`engines.node = ">=22.12.0"`；
  peer 从 0.1.x 的 `dsh-client-runtime` / `dsh-client-ui-layout` 换成 `@deepseek-ai/cordis` + `@deepseek-ai/dsh`。
- `dsh.client.inject` 改为 `@deepseek-ai/dsh-client-ui-renderer`（`slots` 服务提供方）。
- 图片出口按新契约重写：`deputy_sheet` 调 `ctx.attachments.saveImage()` 拿 `ImageAttachmentRef`，
  `render()` 返回 `{ type: 'image', attachment }` content block；不再在 `apply()` 里偷推附件
  （`attachments.add` 在 0.2.x 已不存在）。
- 工具注册去掉 0.1.x 的 `define(name, desc, schema, handler)` 回退，只走 `tools.register(defineTool(...))`；
  `deputy_sense` 标记 `isConcurrencySafe`，其余桌面类工具保持独占。
- `inject` 去掉未使用的 `sessionController`（其 `prompt()` 是 gateway 远程 API，不适合插件自推）。
- `check-plugin.mjs` 重写为 0.2.2 机检：清单字段、`engines.dsh`、内联 required、
  工具 `output.schema/render`、`isConcurrencySafe`、`saveImage` + image block、icon 尺寸。
- 自检 24 项 → **29 项**，新增附件图片出口、attachments 缺失降级、0.2.x 注册签名、schema 形态四组断言，
  以及用 stub `window.__ModuleLoader__` 真加载 `client.js` 校验 `sidebar.panellist` + `main` 注册。

### 真机装载暴露的三处 ABI 修正（0.2.2-rc.5）
- **output.schema 必须用标准 JSON Schema**：`required` 是对象上的字符串数组，
  不能像参数表那样内联成字段上的 `required: true`。真实注册会抛
  `JsonSchemaError: unsupported JSON schema: schema.properties.ok.required is not supported on type "boolean"`，
  整个插件入口不激活。四个工具的 output 全部改写，`check-plugin.mjs` 增加子集校验。
- **parameters 的 object 字段必须显式 `additionalProperties`**：author 参数表编译时抛
  `parameters.payload.additionalProperties must be explicitly true or false`，
  不是等到工具调用才报。已补 `deputy_act.payload`。
- **清理走 `ctx.effect`**：Cordis 4 的 ctx 是严格 getter，读未注入的 `ctx.onDispose`
  直接抛 `cannot get property "onDispose" without inject`；改为 `ctx.effect(() => () => ...)`。
- 以上三条都用真实 DSH 运行时验证：同一份 `@deepseek-ai/dsh-tools` 的
  `validateArgs` / `assertSupportedJsonSchema` 跑过 4 个工具；测试 profile 冷启动
  `dsh --profile deputy-live` 不再出现 `1 entry did not activate`。

### 界面入口：从浮窗胶囊改为侧栏「DSH操作电脑」一页
- 用户要的是跟「新建 / 搜索 / 自定义 / QQ机器人 / 定时任务 / 上下文洞察 / 主题 / 免费搜索」
  并列的常驻项，不是左下角 `shell.overlay` 浮窗，所以挂载点整体换掉。
- `client.js` 重写：`ctx.slots.inject('sidebar.panellist')` 注册 `{ id: 'dsh-deputy-desktop',
  order: 40, label: 'DSH操作电脑' }` + 显示器/指针图标（收 `{ size, active }`）；
  `ctx.slots.inject('main')` 注册同 `key` 的整页组件。侧栏点击由 ui-sidebar 自己调
  `ctx.layout.selectPanel(id)`，插件不碰 layout。
- 页面改成整页布局（`.ddp-*`）：标题栏（状态 / 桌面名 / 打开 / 刷新 / 收起）、
  中央画面（`object-fit: contain`，点画面发归一化坐标 `POST /api/input`）、
  底部尺寸 / pid / 安全提示。组件卸载即停轮询，切页不空转。
- 删掉旧的 `ViewerWindow` / `Toggle` 浮窗体与 `.ddp-pill/.ddp-win` 样式。
- `dsh.client.inject` 补 `@deepseek-ai/dsh-client-ui-sidebar`（`sidebar.panellist` / `main`
  两个座位的声明方）；`ui-renderer` 保留（`slots` 服务）。
- `check-plugin.mjs` 的客户端段重写：断言注册 `sidebar.panellist` + `main`、侧栏名是
  「DSH操作电脑」、且**不允许**再出现 `shell.overlay`（防回退）。
- docs/VIEWER.md 整节改写（座位契约表、点行如何切页、防误注册 `sidebar`）。

## 1.1.2.30

### 质量与可靠性
- 保留用户补充的 `package.json.repository` 元数据。
- 面板合并并发采帧；断线后清除旧画面；打开按钮增加进行中状态，标题栏按钮不再触发拖窗。
- HTTP 输入校验补齐：点击坐标必须在 0..1，启动参数必须合法，错误方法返回 405，畸形 JSON 返回 400。
- 会话并发 `open/close` 合并；关闭后的 capture/tree/input 明确报 `ECLOSED`；`running` 状态允许继续启动程序。
- 工具输出 schema 对齐真实返回值；拼图预算耗尽不再访问不存在的 `frames`。
- 自检由 21 项增至 **24 项**，新增真实 HTTP 面板回归；测试失败时不再误报“全部通过”。
- 发布前检查增加工具 output、bundle patch、client 入口校验。

## 0.0.16.16

### 虚拟桌面面板（把桌面放进 DSH 界面，可手动点）
- 新增 `client.js`：浏览器半（lazy-CJS factory），注册进 `shell.overlay`，
  左下角一个「桌面」胶囊 + 可拖拽/可缩放浮窗，画面 700ms 采样，点画面即在隔离桌面里点一下。
- 新增 `src/viewer.mjs`：只绑 `127.0.0.1:17872` 的极小 HTTP 数据面（health / frame / input / open / close / launch）。
- `src/index.mjs`：`apply()` 启动面板端点，`onDispose` 同时收端点与桌面；端口冲突只警告不阻断工具。
- `package.json` 补 `exports["./client"]`、`dsh.client.platform/inject`、`peerDependencies`（react + 两个 client 运行时）。
- `dsh.plugin.json` 的 `provides.services` 增加 `viewer`。
- 新增 `docs/VIEWER.md`（插槽选择理由、数据面、安全边界、已知限制）。
- 满烟实测（假宿主）：health → open → frame（PNG 签名校验）→ click 归一化坐标换算 → close 全部通过。

## 0.0.13.13
- README 不再硬编码版本号（改为指向 `package.json`）。
- npm 发布映射稳定：仓库四段 → npm 三段，见 `scripts/publish-npm.mjs`。

## 0.0.12.12
- 新增 `scripts/publish-npm.mjs`：四段版本 → 三段 semver，舞台目录重新打包后发布。
- `docs/INSTALL.md` 补 npm 章节，含 `Invalid version` 报错的成因与对策。

## 0.0.10.10
- **`cordis.patch.yml` 结构修正**：旧版多包一层 `apply:`，与 bundle patch 层格式不符。
- `docs/INSTALL.md` 改为真实命令；依赖数 0，不需 `allowBuilds`。

## 0.0.9.9
- 新增 `src/desktop.mjs`：`DesktopSession` 常驻会话 + 状态机，`close()` 幂等。
- 新增 `scripts/windows-desktop.ps1`：常驻宿主，一个进程完成建桌面 / 启动 / BitBlt / UIA / SendInput。
- 新增 `sessionSensor` / `sessionActuator`。权限不足显式报错，不降级主桌面。
- 自检 16 项 → **21 项**。

## 0.0.5.5（前序，第 1–5 次提交）
- `diff.mjs` 帧差打分、`sheet.mjs` 4×4 拼图、`png.mjs` 手写 PNG、`roi.mjs` 三分校验
- `budget.mjs` 三档降级、`runner.mjs` 闭环、`mcp/server.mjs` 最小 MCP 服务
