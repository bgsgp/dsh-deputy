# CHANGELOG

版本号规则：`主版本.本版本.本版本提交数.总提交数`。
`0.0.9.9` = 主版本 0 / 本版本 0 / 本版本内第 9 次提交 / 仓库累计第 9 次提交。

## 0.0.9.9

### 虚拟桌面执行层（这一版的重点）
- 新增 `src/desktop.mjs`：`DesktopSession` 常驻会话 + 状态机
  `idle → opened → running → closed`，越序调用抛 `ESTATE`，`close()` 幂等。
- 新增 `scripts/windows-desktop.ps1`：**常驻宿主**。一个进程里完成
  `CreateDesktopW` → `SetThreadDesktop` → `CreateProcessW(lpDesktop)` → `BitBlt` / UIA / `SendInput`，
  行分隔 JSON 收发。解决了旧版"建完桌面进程一退桌面就没了"的硬伤。
- 新增 `sessionSensor` / `sessionActuator`：把会话接成 `runner.mjs` 的注入依赖，
  采帧与动作全部落在隔离桌面，算法层零改动。
- 新增 `docs/DESKTOP.md`：常驻的原因、三条硬性约束、与"豆包式虚拟桌面"的差距清单。
- 权限不足时**显式报错**，不降级到主桌面（刻意的安全取舍）。

### 注册成 DSH 插件
- `dsh.plugin.json` 补齐 `entry.main`、`platforms`、`provides.tools/services`、
  `permissions`（admin/screen/input/process 及理由）、`lifecycle.onDispose`。
- `src/index.mjs` 重写：接入 `DesktopSession`，新增第 4 个工具 `deputy_desktop`
  （`status/open/launch/tree/close`），保留 tools 注册的能力探测。
- 新增 `scripts/check-plugin.mjs`：版本四段式、两处版本一致、入口存在、
  工具声明与代码导出对齐、权限声明、平台限定，全部机检。
- 新增 `docs/INSTALL.md`：Git 安装 / 本地 link / MCP 三种方式 + UAC 说明 + 验证步骤。

### 修正
- 署名改为 **第五院 · 沐璃-Zero（设计/实现）** 与 **第一院 · 鬼狗子-Zero（立项/审阅）**，
  移除此前错误的第三方署名；`LICENSE`、`NOTICE`、`package.json` 同步。
- 版本号从语义化三段 `0.1.0` 改为四段式，`package.json` 与 `dsh.plugin.json` 同步。

### 测试
- 自检从 16 项增至 **21 项**，新增：会话生命周期、状态守卫、`close` 幂等、
  关闭后采帧报 `ECLOSED`、闭环跑在虚拟桌面上。

## 0.0.5.5（前序，仓库累计第 1–5 次提交）
- `diff.mjs` 帧差打分（dHash + 8×8 网格变化 → 四档）
- `sheet.mjs` 4×4 联系表 + `png.mjs` 手写灰度 PNG
- `roi.mjs` ROI 三分校验（ok / no-effect / side-effect）
- `budget.mjs` 三档预算降级
- `runner.mjs` observe → act → verify 闭环（依赖全注入）
- `mcp/server.mjs` 最小 MCP stdio 服务 + `DEPUTY_FAKE` 合成帧
- `windows-uia.ps1` / `windows-session.ps1` 早期原型
