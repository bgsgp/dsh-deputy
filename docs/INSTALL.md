# 装成 DSH 插件

> 命令形式来自 `dsh-computer-use-win` 的 PUBLISH.md（社区商城 dshmarket 的通用形式）：
> `dsh plugin --profile <profile> add github:<owner>/<repo>`。

## 环境要求

| 项 | 要求 |
|---|---|
| 系统 | Windows x86_64（插件 `os: ["win32"]`） |
| Node | ≥ 20 |
| DSH | 能加载 `dsh.bundle.patch` 的版本 |
| 权限 | 管理员（虚拟桌面必须，见下） |

依赖数为 **0**，不需要 `allowBuilds` 构建授权。

## 方式 A：从 GitHub 直装（推荐）

```powershell
dsh plugin --profile web add github:bgsgp/dsh-deputy
dsh plugin --profile web list
```

装完验证：

```powershell
cd <插件目录>\dsh-deputy
node scripts\check-plugin.mjs
node test\run-tests.mjs
```

两项都应全绿（前者 11 项断言，后者 21 项）。

## 方式 B：本地开发（改代码时用）

```powershell
git clone https://github.com/bgsgp/dsh-deputy
cd dsh-deputy
# 让 DSH 指向本地目录（具体子命令以 dsh plugin --help 为准）
dsh plugin --profile web add .
```

退出后记得 `dsh plugin --profile web remove dsh-deputy`。

## 方式 C：当 MCP 服务用（宿主没有插件能力时）

```json
{
  "mcpServers": {
    "dsh-deputy": {
      "command": "node",
      "args": ["C:/path/to/dsh-deputy/src/mcp/server.mjs"]
    }
  }
}
```

非 Windows 想只验证协议：加 `"env": { "DEPUTY_FAKE": "1" }`。

---

## 装完会看到什么

`cordis.patch.yml` 把插件挂进 profile 后，模型侧多出 4 个工具：

| 工具 | 首次调用 |
|---|---|
| `deputy_desktop` | `{ "op": "status" }` → `state: "idle"` |
| `deputy_sense` | 采一帧打分（未开桌面会报错） |
| `deputy_act` | 在隔离桌面执行动作 + ROI 校验 |
| `deputy_sheet` | 推一张 4×4 联系表 |

## 提权说明（第一次开桌面会弹 UAC）

虚拟桌面需要管理员权限，原因是 `CreateDesktopW(GENERIC_ALL)` 与 `SetThreadDesktop`
都在受保护的操作范围内。**插件不会静默降级到主桌面**：权限不足时 `desktop.mjs`
直接抛 `DesktopError`，任务停下并说明原因，而不是偷偷在你正在用的屏幕上乱点。

| 权限 | 用途 |
|---|---|
| 管理员令牌 | `CreateDesktopW` |
| 普通用户令牌 | 在隔离桌面里 `CreateProcessW` 目标程序 |
| `SeDebugPrivilege` | **不需要**，插件刻意不申请 |

## 五步验证

1. `dsh plugin --profile web list` 能看到 `dsh-deputy 0.0.10.10`；
2. `node scripts/check-plugin.mjs` 全绿；
3. `deputy_desktop { op: "status" }` → `idle`；
4. `deputy_desktop { op: "open" }` → `opened`（看返回里的 UAC 与 `attached`）；
5. `deputy_desktop { op: "close" }` → 再 `status` 为 `closed`。

第 4 步是真正的分水岭：`attached: true` 才说明 `SetThreadDesktop` 成功，
否则后面的采帧和输入都会落在错误桌面上——先解决它，再谈跑任务。

## 上架商城（可选，要提 PR）

商城 CI 的三个硬条件：`dsh.bundle` 已声明（✅）、仓库满 1 天且提交数 ≥ 10（✅ 已到 10）、
仓库带 `dsh-plugin` topic（需手动加）：

```powershell
gh repo edit bgsgp/dsh-deputy --add-topic dsh-plugin
```

然后在 `awesome-dsh-plugin` 仓库提一个 `data/plugins/bgsgp__dsh-deputy.yml` 的 PR。

## 卸载

```powershell
dsh plugin --profile web remove dsh-deputy
```

插件任务结束时会走 `onDispose` 自动关桌面。若异常退出，手动清一下：

```powershell
Get-Process powershell | Where-Object { $_.CommandLine -like '*windows-desktop.ps1*' } | Stop-Process
```
