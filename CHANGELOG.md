# CHANGELOG

版本号规则：`主版本.本版本.本版本提交数.总提交数`。当前版本见 `package.json`。

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
