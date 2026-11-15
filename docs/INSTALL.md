# 装成 DSH 插件 / 发布到 npm

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

## 方式 B：从 npm 装（发布后可用）

```powershell
npm i -g dsh-deputy          # 或 npm i dsh-deputy
dsh plugin --profile web add dsh-deputy
```

### 发布者：为什么不能直接 npm publish

npm 只认**三段 semver**，而本仓库版本是四段 `主.本.本次提交数.总提交数`。
直接 `npm publish` 会报：

```
npm error Invalid version: "0.0.12.12"
```

这是格式问题，和登录无关，必须先映射。仓库自带脚本做这件事：

```powershell
node scripts/publish-npm.mjs            # 默认 dry-run，只打印会发布什么
node scripts/publish-npm.mjs --publish  # 真发布（需先 npm login）
```

映射规则：

| 仓库（四段） | npm（三把） | 说明 |
|---|---|---|
| `0.0.12.12` | `0.0.12` | patch 位取**总提交数**，单调递增；原四段值保留在包的 `deputyVersion` 字段 |

总提交数天然递增 → 正好满足 npm“每次发布必须换版本号、不能重复发布”的硬约束。

发布前检查：

```powershell
npm whoami                  # 必须是 doghostzero
npm view dsh-deputy version --registry=https://registry.npmjs.org   # 应报 404（名字可用）
```

注意：本机或 CI 的 registry 若指向 npmmirror，必须以
`--registry=https://registry.npmjs.org` 发布（脚本已写死）。

## 方式 C：本地开发（改代码时用）

```powershell
git clone https://github.com/bgsgp/dsh-deputy
cd dsh-deputy
dsh plugin --profile web add .
```

## 方式 D：当 MCP 服务用（宿主没有插件能力时）

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

| 工具 | 首次调用 |
|---|---|
| `deputy_desktop` | `{ "op": "status" }` → `state: "idle"` |
| `deputy_sense` | 采一帧打分（未开桌面会报错） |
| `deputy_act` | 在隔离桌面执行动作 + ROI 校验 |
| `deputy_sheet` | 推一张 4×4 联系表 |

## 提权说明（第一次开桌面会弹 UAC）

虚拟桌面需要管理员权限，原因是 `CreateDesktopW(GENERIC_ALL)` 与 `SetThreadDesktop`
都在受保护的操作范围内。**插件不会静默降级到主桌面**：权限不足时 `desktop.mjs`
直接抛 `DesktopError`，任务停下并说明原因。

| 权限 | 用途 |
|---|---|
| 管理员令牌 | `CreateDesktopW` |
| 普通用户令牌 | 在隔离桌面里 `CreateProcessW` 目标程序 |
| `SeDebugPrivilege` | **不需要**，插件刻意不申请 |

## 五步验证

1. `dsh plugin --profile web list` 能看到 `dsh-deputy`；
2. `node scripts/check-plugin.mjs` 全绿；
3. `deputy_desktop { op: "status" }` → `idle`；
4. `deputy_desktop { op: "open" }` → `opened`，**看返回里的 `attached` 是不是 true**；
5. `deputy_desktop { op: "close" }` → 再 `status` 为 `closed`。

第 4 步是真正的分水岭：`attached: true` 才说明 `SetThreadDesktop` 成功，
否则后面的采帧和输入都会落在错误桌面上。

## 上架商城（可选，要提 PR）

商城 CI 三个硬条件：`dsh.bundle` 已声明（✅）、仓库满 1 天且提交数 ≥ 10（✅）、
仓库带 `dsh-plugin` topic（需手动加）：

```powershell
gh repo edit bgsgp/dsh-deputy --add-topic dsh-plugin
```

## 卸载

```powershell
dsh plugin --profile web remove dsh-deputy
```

异常退出后手动清理残留宿主：

```powershell
Get-Process powershell | Where-Object { $_.CommandLine -like '*windows-desktop.ps1*' } | Stop-Process
```
