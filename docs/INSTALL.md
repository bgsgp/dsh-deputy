# 装成 DSH 插件

三种方式，按环境挑。

## 方式 A：从 Git 直接装（推荐）

```bash
dsh plugin install https://github.com/bgsgp/dsh-deputy
dsh plugin list           # 应能看到 dsh-deputy，版本 0.0.9.9
```

装完先跑一次自检，确认注册文件和代码对得上：

```bash
cd <插件目录>/dsh-deputy
node scripts/check-plugin.mjs
```

## 方式 B：本地目录链接（改代码时用）

```bash
git clone https://github.com/bgsgp/dsh-deputy
cd dsh-deputy
dsh plugin link .         # 或 dsh plugin add --path .
```

`dsh.plugin.json` 里声明了：

| 字段 | 值 | 含义 |
|---|---|---|
| `entry.main` | `src/index.mjs` | 插件入口，导出 `apply(ctx)` |
| `entry.inject` | `sessionController, tools, attachments` | 需要的宿主能力 |
| `provides.tools` | `deputy_sense / deputy_act / deputy_sheet / deputy_desktop` | 注册给模型的工具 |
| `platforms` | `win32` | 只在 Windows 上可用 |
| `permissions.admin` | `required: true` | 虚拟桌面必须提权 |

## 方式 C：当 MCP 服务用（宿主没有插件能力时）

```json
{
  "mcpServers": {
    "dsh-deputy": {
      "command": "node",
      "args": ["<路径>/dsh-deputy/src/mcp/server.mjs"]
    }
  }
}
```

非 Windows 环境加 `"env": { "DEPUTY_FAKE": "1" }` 可以跑合成帧，只验证协议。

---

## 提权说明（第一次装会弹 UAC）

虚拟桌面需要管理员权限，原因是 `CreateDesktopW(GENERIC_ALL)` 与 `SetThreadDesktop`
都在受保护的操作范围内。**插件不会静默降级到主桌面**：权限不足时 `desktop.mjs`
直接抛 `DesktopError`，任务停下并说明原因，而不是偷偷在你正在用的屏幕上乱点。

最小权限集合（如果你要自建宿主做审计）：

| 权限 | 用途 |
|---|---|
| `SeCreateGlobalPrivilege` 上下文下的桌面对象创建 | `CreateDesktopW` |
| 普通用户令牌 | 在隔离桌面里 `CreateProcessW` 目标程序 |
| `SeDebugPrivilege` | **不需要**，插件刻意不申请 |

## 验证装好了没

1. `dsh plugin list` 里有 `dsh-deputy`；
2. `node scripts/check-plugin.mjs` 全绿；
3. 让模型调一次 `deputy_desktop { op: "status" }`，应返回 `state: "idle"`；
4. 调 `deputy_desktop { op: "open" }`，成功则 `state: "opened"`，UAC 被拒则返回明确错误；
5. 调 `deputy_desktop { op: "close" }`，再 `status` 应为 `closed`。

## 卸载

```bash
dsh plugin remove dsh-deputy
```

插件在任务结束时会走 `onDispose` 自动关桌面，不会留后台进程。
若异常退出，手动清一下：

```powershell
Get-Process powershell | Where-Object { $_.CommandLine -like '*windows-desktop.ps1*' } | Stop-Process
```
