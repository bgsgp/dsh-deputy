# dsh-deputy

> DSH 的桌面副官：**变化即证据**，默认在**任务视图里另开的一块临时虚拟桌面**上动手（用完收回，不碰你原来的窗口）。
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
| **三种桌面模式** | `user`（默认）：整屏彩色截图 + `SendInput`，和你手动操作是**同一张桌面**；`virtual`：任务视图里新建一块临时桌面，彩色整屏 + `SendInput`，关会话即收回；`isolated`：常驻宿主握独立 Desktop，`PrintWindow` + `PostMessage`，不抢焦点 |

---

## 三种桌面模式

`config.desktop.mode` 决定动作落在哪张桌面上（默认 `user`，也就是**你现在正看着的这张桌面**）；运行时也能换（`deputy_desktop` 的 `open` 带 `mode`，或面板 `POST /api/open {"mode":"virtual"}`）：

| 模式 | 桌面 | 你看到的 | 采帧 | 点击 / 打字 | 会抢你的鼠标吗 |
|---|---|---|---|---|---|
| `user`（默认） | 你自己的真实桌面 | 整屏（真机 1920×1080，含任务栏、其它窗口） | 桌面级 `BitBlt` | `SendInput` 合成事件 | 会：点击前把目标窗口提到前台 |
| `virtual` | 任务视图里**新建的临时桌面**（`Win+Ctrl+D`） | 整屏彩色、完整，但只有壁纸和图标——你原来那些窗口都留在上一张桌面上 | 桌面级 `BitBlt` | `SendInput` 合成事件 | 会：操作期间你的屏幕就在这张新桌面上 |
| `isolated` | 宿主 `CreateDesktopW` 新建的隐藏桌面 | 该桌面里的窗口（不是整屏） | 逐窗口 `PrintWindow`（无 DWM，桌面级 BitBlt 全黑） | `PostMessage` 直投窗口 | 不会 |

`virtual` 就是「豆包虚拟桌面」那套观感：真机实测开出来的新桌面是完整彩色壁纸 + 图标 + 任务栏，
里面没有任何用户窗口；启动记事本、点正文、打字（`deputy virtual desktop ok 789`）、彩色整屏截图全部正常，
`close()` 之后桌面数回到 1、当前桌面 GUID 回到用户原来那块（`a94b74c5-…`）。
两个必须知道的点：① 新桌面靠合成 `Win+Ctrl+D` 建（Windows 没有公开 API），GUID 从注册表
`HKCU\…\Explorer\VirtualDesktops` 读出校验；② **关闭顺序不能反**——必须停在临时桌面上直接按 `Win+Ctrl+F4`，
先切回原桌面再按 F4 删掉的是用户自己的桌面（真机踩过一次，窗口被并到了剩余桌面）。
另外 DSH 面板窗口本身在你的原桌面上（`MoveWindowToDesktop` 对别人的窗口返回 `E_ACCESSDENIED`），
所以操作期间你看不到侧栏那一页，只能看到被操作的新桌面；中途切走桌面时输入会被拒绝并回 `VDESK_NOT_ACTIVE`。

为什么默认是 `user`：你要的是「操作我现在这张桌面」——同一个壁纸、同一个任务栏、你已经开着的那些窗口，点下去就是你自己看到的那块屏幕，不用切桌面、也没有观感落差。
`virtual`（新桌面）和 `isolated`（隐藏桌面）都保留为可选：前者适合"别动我开着的窗口"，后者适合"完全别碰我的鼠标"。
而隐藏桌面为什么"点不动、只有左上角"：`CreateDesktop` 出来的桌面没有 DWM 合成（只能逐窗口抓），也不是输入桌面（`SendInput` 实测接受 0/N 个事件），这才逼出了「真实输入桌面 + 整屏 BitBlt」这条路。
而 `CreateDesktop` 隐藏桌面拿不到合成画面（只能逐窗口抓，所以看起来"只有左上角"），它不是输入桌面、
`SendInput` 实测接受 0/N 个事件，Chromium 这类自绘输入的窗口还会丢 `PostMessage` —— 表现就是"点不动"。

代价也说清楚：`user` 模式是在你真桌上直接注入合成键鼠事件，点击前会先把目标窗口提到前台——跑任务时别抢鼠标，重要窗口（Excel、IDE）请先存盘。
不想被打断就切 `virtual`（全程在另一块临时桌面上跑，你自己的窗口留在原桌面），要完全不碰鼠标就用 `isolated`（能力受限：无 DWM、只能窗口级截图 + `PostMessage`）。

## 对照豆包那套「截图 → 点击」闭环

豆包（字节 UI-TARS 系）自述的实现有六条设计；本插件在它们之上又加了观察层（⑦）。对照到本插件：

| 豆包的规矩 | 本插件现状 |
|---|---|
| ① 坐标归一化到 0–1000 | ✅ 面板把 0..1 归一化坐标换成帧像素，再按 `frameWidth`（缩放前）换算，附窗口 `origin` 偏移 |
| ② 改布局的动作之后必须重新截图再算坐标 | ✅ `runner.step` 发现画面尺寸/布局变化就回 `rescan: true`，模型据此重新 `deputy_sense`/`/api/frame`，不许照旧图连点 |
| ③ 会话隔离用另一块桌面 | ✅ `mode: user`（默认，你现在的真实桌面）/`virtual`（任务视图新桌面）/`isolated`（独立 Win32 桌面），运行时可用 `open` 的 `mode` 切换 |
| ④ 登录、验证码、扫码、MFA 一律交人 | 🟡 只做到"失败不硬撑"：动作校验不过就停、回 `verdict`；**没有**自动识别登录页并交还控制权（见 [docs/ROADMAP.md](docs/ROADMAP.md)） |
| ⑤ 应用必须按开始菜单清单的精确名称启动 | ✅ `deputy_desktop { op: "apps" }` 枚举开始菜单（`.lnk`/`.url` + `shell:AppsFolder` 打包应用，真机 207 项），`op: "launch-app", name: "Google Chrome"` 只认精确名称；找不到回 `APP_NOT_FOUND` + 候选名 |
| ⑥ 落盘类操作用文件系统回读校验 | ✅ `deputy_act` 的 `verifyFile: { path, minBytes }` 动作后立刻回读磁盘；文件是最终裁判（见 [docs/DESKTOP.md](docs/DESKTOP.md#61-落盘回读保存类动作的最终裁判)） |
| ⑦ 观察先取控件树，不靠像素猜控件 | ✅ `deputy_see` 读 UIA 语义树（类型/名字/模式/路径），`deputy_act` 的 `kind: "uia"` 直接按路径 invoke/setValue；拿不到语义才退回像素（见 [docs/DESKTOP.md](docs/DESKTOP.md#62-观察层deputy_see-与语义动作)） |

本插件的取舍是「先语义、后像素」：`deputy_see` 读 UIA 控件树（`InvokePattern`/`ValuePattern`），能按控件路径走就走；
拿不到语义（Chromium/UWP）才退回像素 + 键鼠。真正的取舍写在 [docs/DESIGN.md](docs/DESIGN.md)。

## 为什么要"常驻宿主"

Windows 桌面对象是引用计数的：建它的进程一退出，桌面就没了。所以不能"建一下记个 handle
下次再用"，必须有一个活着的宿主攒着它。两种模式共用同一个宿主进程，只是桌面对象不同：

```
DesktopSession.open()  ──► 宿主: user → 无桌面对象（操作当前桌面）
                                isolated → CreateDesktopW + SetThreadDesktop
startApp(exe)          ──► 宿主: CreateProcessW（isolated 带 lpDesktop="WinSta0\deputy-x"）
capture()              ──► 宿主: user → 整屏 BitBlt；isolated → PrintWindow 逐窗口
tree()                 ──► 宿主: UIA RootElement（= 线程所在桌面）
input(click/type)      ──► 宿主: user → SendInput；isolated → PostMessage(WM_*)
close()                ──► 宿主: isolated 退出即销毁桌面；user 只退出，不碰你的窗口
```

这就是"真的在里面操作"和"只是在旁边截图"的区别。细节见 [docs/DESKTOP.md](docs/DESKTOP.md)。

---

## 架构

```
DESKTOP  user：真实桌面（整屏 + SendInput）／isolated：独立 Desktop + 受限令牌
   │
SENSOR   目标桌面内采帧（面板用彩色 PNG：user 整屏／isolated 逐窗口；感知链路仍用灰度）
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
node test/run-tests.mjs        # 67 项自检：算法 / 闭环 / 桌面状态机与模式切换 / 附件图片 / 浏览器等待、遮挡、多标签、幂等、下载 / 监视窗缩放与点击 / 宿主输入投递 / HTTP 面板
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
**桌面（os）五个工具**

| 工具 | 作用 | 返回 |
|---|---|---|
| `deputy_sense` | 采一帧并打分 | `{score, tier, box, hashDistance}` |
| `deputy_see` | 看窗口与控件树（UIA 语义）：`op: "windows"` / `op: "tree"` | `{kind, count, text, lines, hwnd?, window?, truncated?}` |
| `deputy_act` | 执行动作 + ROI 校验；`kind: "uia"` 按控件路径走语义动作；保存类动作传 `verifyFile` 做磁盘回读 | `{ok, verdict, inside, outside, retries, method?, file?}` |
| `deputy_sheet` | 把缓冲帧压成 4×4 送出 | `{frames, budget, image}` + image content block |
| `deputy_desktop` | 桌面会话：`status/open/apps/launch-app/launch/tree/close` | 会话状态 / pid / 开始菜单应用清单 / 窗口树 |

保存类动作必须回读磁盘，别只信像素：`deputy_act({ kind: 'input', payload: { op: 'key', combo: 'Ctrl+S' },
verifyFile: { path: 'D:/out/report.xlsx', minBytes: 1024 } })`。文件存在且够大才算保存成功 —— 见
[docs/DESKTOP.md](docs/DESKTOP.md#61-落盘回读保存类动作的最终裁判)。

先看再动：`deputy_see({ op: 'windows' })` 找窗口，`deputy_see({ op: 'tree', title: 'XXX' })` 拿控件行和 `@1.0.2` 路径，
再 `deputy_act({ kind: 'uia', payload: { title: 'XXX', ref: { path: [1, 0] }, action: 'invoke' } })`；
回包里的 `method` 说明走的是 UIA 模式、窗口消息还是坐标兜底。Chromium/UWP 的限制见
[docs/DESKTOP.md](docs/DESKTOP.md#62-观察层deputy_see-与语义动作)。

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
**「DSH操作电脑」**。点它，中央面板切到整页的桌面画面：

- 每 0.7 秒拉一帧**彩色画面**（宿主直接编码 PNG；超过 1600 宽先等比缩小，省一半以上体积），按宿主真实帧尺寸与窗口可用区域等比完整显示；点画面 = 在目标桌面里点一下（缩放、居中留白与 1600 宽缩放均已换算，原生拖图已禁用）；
- 「打开桌面」起会话（`isolated` 模式要建桌面所以弹 UAC，`user` 模式不弹）、「收起桌面」回收；
- `isolated` 桌面里还没窗口时（`NOWINDOW`）不再给一张全黑图，而是提示 + 「启动 Edge / 启动记事本」按钮（`user` 模式永远有整屏画面，不会 `NOWINDOW`）；
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
| 应用白名单（开始菜单） | ✅ 真机验证 | `op: "apps"` 枚举 `.lnk`/`.url` + `shell:AppsFolder`（真机 207 项）；`op: "launch-app"` 只认精确名称，真机拉起 Chrome 到虚拟桌面新标签页、记事本走打包应用通道 |
| `desktop.mjs` 桌面会话 | ✅ 实现 + 单测（假宿主） | 状态机 / 守卫 / 幂等关闭；`mode=user\|virtual\|isolated` 透传给宿主，`setMode()` 运行时换宿主但保留对象身份；宿主拒绝输入时抛 `VDESK_NOT_ACTIVE` |
| `scripts/windows-desktop.ps1` | ✅ 三模式真机验证 | 常驻宿主 `-Mode user\|isolated`。`user`：整屏 1920×1080 捕获 + `SendInput`，实测点开记事本正文打出 `deputy user desktop ok 123`；`isolated`：建桌面 + 逐窗口 `PrintWindow` + `PostMessage`，实测打开 Edge 拍到 B 站首页并打出 `deputy desktop hello 123`；`virtual`：`Win+Ctrl+D` 新桌面 + 彩色整屏 + `SendInput`，实测记事本里打出 `deputy virtual desktop ok 789` 且关会话后桌面数回到 1 |
| `scripts/windows-uia.ps1` | 🟡 原型 | 一次性 UIA 调用（无隔离桌面） |
| `scripts/check-plugin.mjs` | ✅ 可用 | 按 DSH 0.2.2 插件 ABI 机检（清单 / 工具 / 图片 / icon） |
| `scripts/publish-npm.mjs` | ✅ 可用 | 舞台打包 + 直接 npm publish（标准三段版本） |
| `cordis.patch.yml` | ✅ 一个包两个组件 + 包根锚点 | 一条 `- insert:` 下 `dsh-deputy/os` + `dsh-deputy/browser`，外加无 id 的包根 row `dsh-deputy`（客户端发现用，不占组件行） |
| `status.mjs` 状态总线 | ✅ 实现 + 单测 | 两组件各写一段，合成 `error > running > idle` 一个点 |
| MCP stdio 服务 | ✅ 可用 | `initialize` / `tools/list` / `tools/call` |
| 侧栏入口（`client.js`） | ✅ 真机验证（0.2.2-rc.5） | 侧栏「应用」一行「DSH操作电脑」+ 中央整页；`sidebar.panellist` / `main` 同 id 注册，`check-plugin` 防回退到 `shell.overlay` |
| DSH 原生装载 | ✅ 真机验证（0.2.2-rc.5） | 在测试 profile 里冷启动激活、无 `entry did not activate`；工具用真实 `dsh-tools` 的 `validateArgs` / `assertSupportedJsonSchema` 校验（参数表 + output schema + image block），两种桌面模式均已真机跑通 |
| 浏览器组件（`src/browser/`） | 🟡 代码补全，待真机回归 | 1.3.39 已加入结构化等待、真实遮挡阻断、多标签、上传下载、截图附件、幂等和异常状态恢复；保持五工具 ABI。OOPIF iframe 仍是边界。本轮按用户要求未启动浏览器实测，详见 [docs/BROWSER.md](docs/BROWSER.md) |

**已知未验证点**：`isolated` 模式下 UAC/安全桌面抢占、靠 `GetKeyState` 判断修饰键的快捷键
（部分浏览器 `Ctrl+L` 之类不认投递的按键）；`user`/`virtual` 模式在高 DPI 多屏、缩放非 100% 的副屏上坐标换算；
`virtual` 模式下把 DSH 面板窗口钉到临时桌面（Windows 拒绝跨进程 `MoveWindowToDesktop`）尚未实现。
**已知代价**：`user` 模式会占用真实鼠标键盘（点击先把目标窗口提到前台），跑任务时别抢鼠标。
已解决（真机）：`SetThreadDesktop` 在 PowerShell 里必须放到"从未建过窗口"的后台 STA 线程；
`isolated` 桌面拍画面必须用逐窗口 `PrintWindow`（桌面级 BitBlt 全黑）、输入必须用 `PostMessage`；
`user` 模式必须先 `SetProcessDPIAware`，否则 150% 缩放下 `GetSystemMetrics` 只给 1280×720、截图与点击错位。
真机第一步先看 `deputy_desktop { op: "status" }` 的 `state` 与宿主回执里的 `mode`。

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
  os.mjs          组件 dsh-deputy/os：桌面会话（默认虚拟桌面）+ 4 个 deputy_* 工具
  browser.mjs     组件 dsh-deputy/browser：浏览器 daemon + 5 个 browser_* 工具
  browser/        launch / cdp / daemon / snapshot / act / wait / tools / cookies / errors
  index.mjs       兼容入口：只 `export * from './os.mjs'`
  mcp/server.mjs  最小 MCP stdio 服务
scripts/
  windows-desktop.ps1  常驻宿主：user（整屏 + SendInput）／isolated（建桌面 + PrintWindow + PostMessage）
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
