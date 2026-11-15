# dsh-deputy

> DSH 的桌面副官：**变化即证据**，动作落在**自己的虚拟桌面**里。
> 桌面被当成稀疏信号源而不是截图流——本地打分，跨档才推一张 4×4 联系表；
> 动作走 UIA 语义优先，每一步只校验它本该动的那块区域。

| | |
|---|---|
| **出品** | 丐帮集团 |
| **署名** | **沐璃-Zero**（设计 / 实现 · 豆包 MainAgent · **第五院**） |
| **署名** | **鬼狗子-Zero**（立项 / 需求 / 审阅 · **第一院**） |
| **发布** | [@bgsgp](https://github.com/bgsgp) |
| **协议** | MIT |
| **版本** | 四段式（主.本.本次.总），以 `package.json` 为准 |

---

## 安装

```powershell
# 从 GitHub（不需 npm 登录）
dsh plugin --profile web add github:bgsgp/dsh-deputy

# 或 npm 发布后
npm i -g dsh-deputy
dsh plugin --profile web add dsh-deputy
```

环境要求：Windows x86_64、Node ≥ 20、管理员权限（虚拟桌面必需）。依赖数为 **0**，
不需要 `allowBuilds`。详细步骤与验证见 [docs/INSTALL.md](docs/INSTALL.md)。

---

## 它解决什么

桌面代理真正卡住的不是"能不能点到"，是三件事：

1. **感知通胀** —— 每一步截一张全屏图，10 步任务的视觉 token 就能吃掉小半个上下文。
2. **定位脓性** —— 纯坐标点击，UI 一挪位就点空，点空还看不出来，于是越点越偏。
3. **焦点争夺** —— 自动化和用户抢同一块桌面，用户一动鼠标任务就断。

对应四条主线：

| 主线 | 做法 |
|---|---|
| **变化即证据** | 帧的价值 = 相对上一帧变了多少；0..1 分数分四档（still/minor/meaningful/major） |
| **语义优先** | UIA `InvokePattern`/`ValuePattern` 打头，键鼠是兜底不是首选 |
| **ROI 校验** | 动作后只比对它该影响的区域，并额外检测"别处有没有被带脏" |
| **真开虚拟桌面** | 常驻宿主握着独立 Desktop，目标程序、采帧、取树、输入全在同一个桌面对象里 |

---

## 为什么要"常驻宿主"

Windows 桌面对象是引用计数的：建它的进程一退出，桌面就没了。所以不能"建一下记个 handle
下次再用"，必须有一个活着的宿主攒着它：

```
DesktopSession.open()  ──► 宿主: CreateDesktopW + SetThreadDesktop
startApp(exe)          ──► 宿主: CreateProcessW(lpDesktop="WinSta0\deputy-x")
capture()              ──► 宿主: BitBlt 取该桌面画面
tree()                 ──► 宿主: UIA RootElement（= 线程所在桌面）
input(click/type)      ──► 宿主: SendInput
close()                ──► 宿主退出 → 桌面销毁，不残留
```

这就是"真的在里面操作"和"只是在旁边截图"的区别。细节见 [docs/DESKTOP.md](docs/DESKTOP.md)。

---

## 架构

```
ISOLATE  独立 Desktop + 受限令牌 + Job Object（不抢焦点，不乱写）
   │
SENSOR   隔离桌面内采帧（灰度）
   │
SENSE    dHash 距离 + 8×8 网格变化 → 0..1 分数 → 四档
   │      跨档帧进缓冲，满 16 帧 → 4×4 拼图（标签烧进图里）
   │
SESSION  attachments 推送（一次只花一张图的钱）
   │
DECIDE   宿主模型：看拼图 + UIA 树 → 选动作
   │
ACT      L1 UIA → L2 坐标点击 → L3 键盘
   │
VERIFY   ROI 三分：ok / no-effect / side-effect
   │
BUDGET   normal → coarse → halt，允许放弃
```

## 快速开始

```bash
node test/run-tests.mjs        # 21 项自检：打分 / 拼图 / ROI / 预算 / 闭环 / 桌面状态机
node scripts/check-plugin.mjs  # 插件注册自检：版本四段式、入口、工具对齐、权限声明
node scripts/publish-npm.mjs   # npm 发布 dry-run（四段 → 三段映射）

DEPUTY_FAKE=1 node src/mcp/server.mjs   # 非 Windows 也能跑通 MCP 协议
```

### 四个工具

| 工具 | 作用 | 返回 |
|---|---|---|
| `deputy_sense` | 采一帧并打分 | `{score, tier, box, hashDistance}` |
| `deputy_act` | 在隔离桌面执行动作 + 校验 | `{ok, verdict, inside, outside, retries}` |
| `deputy_sheet` | 把缓冲帧压成 4×4 送出 | `{frames, budget}` + PNG |
| `deputy_desktop` | 桌面会话：`status/open/launch/tree/close` | 会话状态 / pid / 窗口树 |

---

## 状态矩阵（别说我没写清楚）

| 模块 | 状态 | 说明 |
|---|---|---|
| `diff.mjs` 打分 | ✅ 实现 + 单测 | 纯算法，跳平台 |
| `sheet.mjs` 拼图 | ✅ 实现 + 单测 | 内置 3×5 点阵字体，手写 PNG 编码 |
| `roi.mjs` 校验 | ✅ 实现 + 单测 | 三分 verdict |
| `budget.mjs` 预算 | ✅ 实现 + 单测 | 三档降级 |
| `runner.mjs` 闭环 | ✅ 实现 + 单测（注入式，无需 Windows） | 重试 / 熔断 |
| `desktop.mjs` 虚拟桌面会话 | ✅ 实现 + 单测（假宿主） | 状态机 / 守卫 / 幂等关闭 |
| `scripts/windows-desktop.ps1` | 🟡 原型 | 常驻宿主：建桌面 / 启动 / BitBlt / 取树 / SendInput，**未真机回归** |
| `scripts/windows-uia.ps1` | 🟡 原型 | 一次性 UIA 调用（无隔离桌面） |
| `scripts/check-plugin.mjs` | ✅ 可用 | 注册一致性自检 |
| `scripts/publish-npm.mjs` | ✅ 可用（dry-run 通过） | 四段→三段 semver 映射 + 舞台打包 |
| `cordis.patch.yml` | ✅ 已对齐社区格式 | `- insert: - id/name/config` |
| MCP stdio 服务 | ✅ 可用 | `initialize` / `tools/list` / `tools/call` |
| DSH 原生装载 | 🟡 待真机联调 | 依赖宿主 `tools` / `attachments` 实际签名 |

**已知未验证点**：x64 `INPUT` 40 字节对齐、隔离桌面 BitBlt 是否拍到硬件加速界面、
`SetThreadDesktop` 在 PowerShell 进程里的成败、UAC/安全桌面的抢占。
真机第一步先看 `deputy_desktop { op: "open" }` 返回的 `attached` 是否为 true。

---

## 和两个参考实现的分工

| | dsh-computer-use-win | dsh-see-now | **dsh-deputy** |
|---|---|---|---|
| 主职 | 执行（UIA / 键鼠 / 窗口） | 感知（直播 → 拼图） | 感知 + 执行 + **校验闭环 + 独立桌面** |
| 感知 | 按需截图 | 连续采帧、按变化挑帧 | 连续打分分档 + 跨档才推 + 去重 |
| 校验 | 靠模型看下一张 | 无 | **ROI 三分 verdict** |
| 隔离 | 主桌面 | 只读 | **独立 Desktop（存活会话）** |
| 成本 | 靠模型自觉 | 拼图省 token | 拼图 **+ 预算强制降级** |

一个给"手"，一个给"眼"；deputy 补的是**眼手之间的反射弧**，外加一间**自己的房间**。

---

## 目录

```
src/
  diff.mjs        帧差打分：dHash + 网格变化 → 分数 / 档位 / 包围盒
  sheet.mjs       4×4 联系表：缩放、标签、灰度 PNG
  png.mjs         手写 PNG 编码（zlib，无第三方依赖）
  roi.mjs         动作影响域：扩张、裁剪、三分校验
  budget.mjs      预算与降级
  action.mjs      动作模型与序列化（可回放）
  runner.mjs      observe → act → verify 闭环（依赖全注入）
  desktop.mjs     虚拟桌面会话：常驻宿主客户端 + 状态机 + sensor/actuator
  uia-bridge.mjs  一次性 PowerShell UIA 后端桥
  index.mjs       DSH 插件入口（4 个工具 + 能力探测式注册）
  mcp/server.mjs  最小 MCP stdio 服务
scripts/
  windows-desktop.ps1  常驻宿主：建桌面 / 启动 / 采帧 / 取树 / 输入
  windows-uia.ps1      一次性 UIA（无隔离桌面，验证用）
  windows-session.ps1  早期碎片版（留作对照）
  check-plugin.mjs     注册一致性自检
  publish-npm.mjs      四段版本 → npm 三段映射发布
docs/
  DESIGN.md       总体思路与六个关键决策
  SENSING.md      打分公式、拼图成本模型、预算曲线
  ACTING.md       动作梯度、selector、三分处置、危险闸门
  ISOLATION.md    桌面隔离原理、为什么要 UAC、与 DSH 文件沙箱的区别
  DESKTOP.md      虚拟桌面执行层：常驻宿主、硬性约束、与豆包式方案的差距
  INSTALL.md      安装方式、npm 发布、五步验证、UAC 与商城上架
  ROADMAP.md      版本计划
```

## 版本号规则

`主版本.本版本.本版本提交数.总提交数`。例：`0.0.15.15` 表示"主版本 0、本版本 0、
本版本内第 15 次提交、仓库累计第 15 次提交"。

- 仓库内（`package.json`、`dsh.plugin.json`）用四段式；
- npm 只认三段，**发布时**由 `scripts/publish-npm.mjs` 映射为 `主.本.总提交数`（例：`0.0.15.15` → `0.0.15`），原值写进包的 `deputyVersion` 字段；
- `npm run plugin:check` 校验四段式格式与两份清单一致。

## 致谢与许可

设计上参考了两个上游项目（**代码为独立实现，未直接复制源码**）：

- [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) —— MCP + PowerShell UIA 后端的组织方式，以及 bundle patch 的真实写法、npm 发布流程
- [SAOS-3624/dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) —— 变化挑帧 + 4×4 拼图进会话的做法

详见 [NOTICE](NOTICE)。本仓库以 **MIT** 发布。

```
丐帮集团第五院 · 沐璃-Zero    ×    丐帮集团第一院 · 鬼狗子-Zero
```
