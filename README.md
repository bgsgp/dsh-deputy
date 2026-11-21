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
| **版本** | 三段 semver（主.本.总提交数），以 `package.json` 为准 |

---

## 安装

```powershell
# 从 GitHub（不需 npm 登录）
dsh plugin --profile web add github:bgsgp/dsh-deputy

# 或 npm 发布后
npm i -g dsh-deputy
dsh plugin --profile web add dsh-deputy
```

环境要求：Windows x86_64、Node ≥ 22.12、DSH **0.2.2-rc.1 ≤ 版本 < 0.2.3**、管理员权限（虚拟桌面必需）。
依赖数为 **0**，不需要 `allowBuilds`。插件清单写在 `package.json` 的 `dsh` 字段
（`bundle.patch` / `client` / `icon`），**不再有 `dsh.plugin.json`**——0.2.x 已不读取它。
详细步骤与验证见 [docs/INSTALL.md](docs/INSTALL.md)。

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
capture()              ──► 宿主: PrintWindow 逐窗口捕获该桌面画面
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
SESSION  attachments.saveImage → 工具结果 image block（一次只花一张图的钱）
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
node test/run-tests.mjs        # 50 项自检：算法 / 闭环 / 桌面状态机 / 附件图片 / 浏览器等待、遮挡、多标签、幂等、下载 / 监视窗缩放与点击 / HTTP 面板
node scripts/check-plugin.mjs  # 插件自检：0.2.2 清单、engines.dsh、两个组件、9 个工具 ABI、image block、icon
node scripts/publish-npm.mjs   # npm 发布 dry-run（版本已是标准三段）

DEPUTY_FAKE=1 node src/mcp/server.mjs   # 非 Windows 也能跑通 MCP 协议
```

### 两个组件、九个工具

插件管理器里这个包显示成**两行**（一个包、两个 Cordis 组件，和 billion-context 一样）：

| 组件 | 入口 | 职责 |
|---|---|---|
| `dsh-deputy/os` | `src/os.mjs` | 隔离桌面：会话、采帧、拼图、输入 |
| `dsh-deputy/browser` | `src/browser.mjs` | 浏览器：独立实例 + CDP + 快照/动作 |

**包根锚点 row**：`cordis.patch.yml` 里除两条组件 row 外，还有一条**不带 `id`** 的
`name: 'dsh-deputy'`。0.2.2 的 `client-modules` 只对「Loader 行 name 恰好等于包根名」的包做
客户端发现（`exactPackageSpecifier` 遇到子路径直接返回 `undefined`），没有这条 row，`client.js`
就永远进不了 `__DSH_BOOT__`，侧栏「DSH操作电脑」整行不会出现。它不带 id，所以插件管理器的
「包含的组件」仍然是两行。
**桌面（os）四个工具**

| 工具 | 作用 | 返回 |
|---|---|---|
| `deputy_sense` | 采一帧并打分 | `{score, tier, box, hashDistance}` |
| `deputy_act` | 在隔离桌面执行动作 + 校验 | `{ok, verdict, inside, outside, retries}` |
| `deputy_sheet` | 把缓冲帧压成 4×4 送出 | `{frames, budget, image}` + image content block |
| `deputy_desktop` | 桌面会话：`status/open/launch/tree/close` | 会话状态 / pid / 窗口树 |

**浏览器（browser）五个工具**（完整 CDP 实现，细节见 [docs/BROWSER.md](docs/BROWSER.md)；1.3.39 待真机回归）

| 工具 | 作用 | 返回 |
|---|---|---|
| `browser_open` | 起独立浏览器（独立 user-data-dir + CDP + 复制本机登录态），可选直接导航 | `{ok, state, url, pid, docEpoch, cookies}` |
| `browser_observe` | DOM+AX 快照、区域过滤、状态与可选截图 | `{ok, text, refs, state, image?}` + 可选 image block |
| `browser_act` | 基本动作、三层等待、遮挡检查、多标签、上传下载、幂等 | `{ok, steps, diff, stopped?, error?}` |
| `browser_status` | daemon 状态（pid/端口/epoch/最近错误/cookies） | `{ok, state, pid, port, url, cookies}` |
| `browser_close` | 关浏览器并清 daemon | `{ok, state}` |

### 界面：侧栏里的一页

左侧「应用」栏（新建 / 搜索 / 自定义 / QQ机器人 / 定时任务 / …）底部会多一行
**「DSH操作电脑」**。点它，中央面板切到整页的隔离桌面：

- 每 0.7 秒拉一帧灰度画面，按宿主真实帧尺寸与窗口可用区域等比完整显示；点画面 = 在隔离桌面里点一下（缩放与居中留白均正确换算，原生拖图已禁用）；
- 「打开桌面」起会话（Windows 上弹 UAC）、「收起桌面」回收；
- 桌面里还没窗口时（`NOWINDOW`）不再给一张全黑图，而是提示 + 「启动 Edge / 启动记事本」按钮；
- 这页不是浮窗，也不占会话；切回对话在侧栏点一下即可。

行文字右边还有一个小状态点（跟着标题走，避开悬停出现的大头针），读 `/api/status`（两个组件共用一条状态总线）：
**绿 = 有桌面/浏览器在跑，红 = 最近一次操作失败，灰 = 都没开**。

0.2.x 的挂载点是 `sidebar.panellist`（侧栏行）+ `main`（同 key 的整页），细节见 [docs/VIEWER.md](docs/VIEWER.md)。

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
| `scripts/windows-desktop.ps1` | ✅ 真机验证（0.2.2-rc.5 宿主） | 常驻宿主：建桌面 / 启动 / 逐窗口 `PrintWindow` 捕获 / 取树；`SendInput` 仍待回归。已实测在隔离桌面打开 Edge 并拍到 B 站首页 |
| `scripts/windows-uia.ps1` | 🟡 原型 | 一次性 UIA 调用（无隔离桌面） |
| `scripts/check-plugin.mjs` | ✅ 可用 | 按 DSH 0.2.2 插件 ABI 机检（清单 / 工具 / 图片 / icon） |
| `scripts/publish-npm.mjs` | ✅ 可用 | 舞台打包 + 直接 npm publish（标准三段版本） |
| `cordis.patch.yml` | ✅ 一个包两个组件 + 包根锚点 | 一条 `- insert:` 下 `dsh-deputy/os` + `dsh-deputy/browser`，外加无 id 的包根 row `dsh-deputy`（客户端发现用，不占组件行） |
| `status.mjs` 状态总线 | ✅ 实现 + 单测 | 两组件各写一段，合成 `error > running > idle` 一个点 |
| MCP stdio 服务 | ✅ 可用 | `initialize` / `tools/list` / `tools/call` |
| 侧栏入口（`client.js`） | ✅ 真机验证（0.2.2-rc.5） | 侧栏「应用」一行「DSH操作电脑」+ 中央整页；`sidebar.panellist` / `main` 同 id 注册，`check-plugin` 防回退到 `shell.overlay` |
| DSH 原生装载 | ✅ 真机验证（0.2.2-rc.5） | 在测试 profile 里冷启动激活、无 `entry did not activate`；工具用真实 `dsh-tools` 的 `validateArgs` / `assertSupportedJsonSchema` 校验（参数表 + output schema + image block），桌面自动化仍待真机回归 |
| 浏览器组件（`src/browser/`） | 🟡 代码补全，待真机回归 | 1.3.39 已加入结构化等待、真实遮挡阻断、多标签、上传下载、截图附件、幂等和异常状态恢复；保持五工具 ABI。OOPIF iframe 仍是边界。本轮按用户要求未启动浏览器实测，详见 [docs/BROWSER.md](docs/BROWSER.md) |

**已知未验证点**：x64 `INPUT` 40 字节对齐、`SendInput` 在非活动桌面的实际效果、
UAC/安全桌面对隔离桌面的抢占。已解决：`SetThreadDesktop` 在 PowerShell 里必须放到
"从未建过窗口"的后台 STA 线程；隔离桌面拍画面必须用逐窗口 `PrintWindow`（桌面级 BitBlt 全黑）。
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
  status.mjs      两组件共享的状态总线（合成侧栏那个状态点）
  registry.mjs    toParameters / registerTools（0.2.x 工具注册的公共层）
  os.mjs          组件 dsh-deputy/os：隔离桌面 + 4 个 deputy_* 工具
  browser.mjs     组件 dsh-deputy/browser：浏览器 daemon + 5 个 browser_* 工具
  browser/        launch / cdp / daemon / snapshot / act / wait / tools / cookies / errors
  index.mjs       兼容入口：只 `export * from './os.mjs'`
  mcp/server.mjs  最小 MCP stdio 服务
scripts/
  windows-desktop.ps1  常驻宿主：建桌面 / 启动 / 采帧 / 取树 / 输入
  windows-uia.ps1      一次性 UIA（无隔离桌面，验证用）
  windows-session.ps1  早期碎片版（留作对照）
  check-plugin.mjs     注册一致性自检
  publish-npm.mjs      舞台打包 + npm 发布（版本已是标准三段）
docs/
  DESIGN.md       总体思路与六个关键决策
  SENSING.md      打分公式、拼图成本模型、预算曲线
  ACTING.md       动作梯度、selector、三分处置、危险闸门
  ISOLATION.md    桌面隔离原理、为什么要 UAC、与 DSH 文件沙箱的区别
  DESKTOP.md      虚拟桌面执行层：常驻宿主、硬性约束、与豆包式方案的差距
  BROWSER.md      浏览器组件：daemon/ref/等待/遮挡/多标签/上传下载/截图/恢复/风险
  INSTALL.md      安装方式、npm 发布、五步验证、UAC 与商城上架
  ROADMAP.md      版本计划
```

## 版本号规则

`主版本.本版本.总提交数`（标准三段 semver，例 `1.2.31`）。总提交数单调递增，
正好满足 npm「每次发布必须换版本号」的约束。

- 仓库与 npm 用同一个三段版本，不再做四段→三段映射；
- 四段版本（如 `1.2.0.31`）会被 pnpm/npm 直接拒绝（`ERR_PNPM_BAD_PACKAGE_JSON`），
  这也是本地 `link:` 安装失败的原因；
- `npm run plugin:check` 校验三段格式、`engines.dsh`、工具 ABI 与图片出口。

## 致谢与许可

设计上参考了两个上游项目（**代码为独立实现，未直接复制源码**）：

- [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) —— MCP + PowerShell UIA 后端的组织方式，以及 bundle patch 的真实写法、npm 发布流程
- [SAOS-3624/dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) —— 变化挑帧 + 4×4 拼图进会话的做法

详见 [NOTICE](NOTICE)。本仓库以 **MIT** 发布。

```
丐帮集团第五院 · 沐璃-Zero    ×    丐帮集团第一院 · 鬼狗子-Zero
```
