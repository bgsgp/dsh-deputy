# CHANGELOG

版本号规则：`主版本.本版本.本版本提交数.总提交数`。当前版本见 `package.json`。

## 0.0.13.13
- README 不再硬编码版本号（改为指向 `package.json`），避免每次提交都要追版本。
- npm 发布映射已稳定：仓库四段 → npm 三段，见 `scripts/publish-npm.mjs`。

## 0.0.12.12
- 新增 `scripts/publish-npm.mjs`：四段版本 → 三段 semver，舞台目录重新打包后发布。
- `docs/INSTALL.md` 补 npm 章节，含 `Invalid version` 报错的成因与对策。

## 0.0.10.10
- **`cordis.patch.yml` 结构修正**：旧版多包一层 `apply:`，与 bundle patch 层格式不符，会导致挂载失败。
- `docs/INSTALL.md` 改为真实命令 `dsh plugin --profile web add github:bgsgp/dsh-deputy`。
- 依赖数为 0，不需要 `allowBuilds`。

## 0.0.9.9
- 新增 `src/desktop.mjs`：`DesktopSession` 常驻会话 + 状态机，`close()` 幂等。
- 新增 `scripts/windows-desktop.ps1`：常驻宿主，一个进程完成建桌面 / 启动 / BitBlt / UIA / SendInput。
- 新增 `sessionSensor` / `sessionActuator`，采帧与动作全落在隔离桌面。
- 新增 `docs/DESKTOP.md`。权限不足显式报错，不降级主桌面。
- `dsh.plugin.json` 补齐 `entry/provides/permissions/lifecycle`；新增 `deputy_desktop` 工具。
- 签名改为 **第五院 · 沐璃-Zero** 与 **第一院 · 鬼狗子-Zero**；版本改四段式。
- 自检 16 项 → **21 项**。

## 0.0.5.5（前序，仓库累计第 1–5 次提交）
- `diff.mjs` 帧差打分、`sheet.mjs` 4×4 拼图、`png.mjs` 手写 PNG、`roi.mjs` 三分校验
- `budget.mjs` 三档降级、`runner.mjs` 闭环、`mcp/server.mjs` 最小 MCP 服务
- `windows-uia.ps1` / `windows-session.ps1` 早期原型
