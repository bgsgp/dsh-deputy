# CHANGELOG

版本号规则：`主版本.本版本.本版本提交数.总提交数`。
`0.0.10.10` = 主版本 0 / 本版本 0 / 本版本内第 10 次提交 / 仓库累计第 10 次提交。

## 0.0.10.10

### 修包（影响能否装上）
- **`cordis.patch.yml` 结构修正**：旧版多包了一层 `apply:`，与 DSH bundle patch 层的实际格式不符，
  会导致插件挂载不上。改为社区通用形式 `- insert: - id/name/config`
  （依据 `dsh-computer-use-win` 与 `dsh-see-now` 两个已上架/可安装插件的实际文件）。
- `docs/INSTALL.md` 重写为真实可用命令：`dsh plugin --profile web add github:bgsgp/dsh-deputy`，
  并补充环境要求、五步验证、`attached` 分水岭说明、上架商城的三个硬条件。
- 确认依赖数为 0，安装不需要 `allowBuilds` 构建授权。

## 0.0.9.9

### 虚拟桌面执行层
- 新增 `src/desktop.mjs`：`DesktopSession` 常驻会话 + 状态机
  `idle → opened → running → closed`，越序调用抛 `ESTATE`，`close()` 幂等。
- 新增 `scripts/windows-desktop.ps1`：**常驻宿主**。一个进程里完成
  `CreateDesktopW` → `SetThreadDesktop` → `CreateProcessW(lpDesktop)` → `BitBlt` / UIA / `SendInput`。
- 新增 `sessionSensor` / `sessionActuator`：采帧与动作全落在隔离桌面，算法层零改动。
- 新增 `docs/DESKTOP.md`：常驻的原因、三条硬性约束、与"豆包式虚拟桌面"的差距清单。
- 权限不足时**显式报错**，不降级到主桌面。

### 注册成 DSH 插件
- `dsh.plugin.json` 补齐 `entry.main`、`platforms`、`provides`、`permissions`、`lifecycle`。
- `src/index.mjs` 重写：接入 `DesktopSession`，新增第 4 个工具 `deputy_desktop`。
- 新增 `scripts/check-plugin.mjs` 与 `docs/INSTALL.md`。

### 修正
- 署名改为 **第五院 · 沐璃-Zero（设计/实现）** 与 **第一院 · 鬼狗子-Zero（立项/审阅）**。
- 版本号改为四段式。

### 测试
- 自检 16 项 → **21 项**。

## 0.0.5.5（前序，仓库累计第 1–5 次提交）
- `diff.mjs` 帧差打分（dHash + 8×8 网格变化 → 四档）
- `sheet.mjs` 4×4 联系表 + `png.mjs` 手写灰度 PNG
- `roi.mjs` ROI 三分校验（ok / no-effect / side-effect）
- `budget.mjs` 三档预算降级
- `runner.mjs` observe → act → verify 闭环
- `mcp/server.mjs` 最小 MCP stdio 服务 + `DEPUTY_FAKE` 合成帧
- `windows-uia.ps1` / `windows-session.ps1` 早期原型
