# CHANGELOG

版本号规则：`主版本.本版本.总提交数`（标准三段 semver，pnpm/npm 可直接安装）。当前版本见 `package.json`。

## 1.3.49

### 观察层：先看控件树，再决定怎么动（`deputy_see`）
- 新增 `deputy_see`：`op: "windows"` 列出可见顶层窗口，`op: "tree"` 取某个窗口的 UIA 控件树；每行带类型、名字、`aid`、可用模式（Invoke/Value/Toggle…）、路径 `@1.0.2`，以及「密码框/禁用/不可见」旗标。
- 新增 `scripts/windows-uia.ps1`（一次性进程，UTF-8 BOM + CRLF）：`windows` / `tree` / `act` / `capture`，输出统一走 UTF-8 字节流，中文标题不乱码；排版在 `src/see.mjs`（纯函数，可单测），桥在 `src/uia-bridge.mjs`（`-STA`）。
- `deputy_act` 的 `kind: "uia"` 在 `user` 模式下改走这条桥：`payload: { hwnd|title|process, ref: { path }, action: "invoke"|"setValue"|"click"|"focus", text }`；回包新增 `method`，说明实际走的是 `invoke` / `bm-click` / `wm-settext` / `coordinate`。
- 语义优先：UIA 模式（`Invoke`→`Toggle`→`SelectionItem`→`ExpandCollapse`、`ValuePattern`）→ 窗口消息（按类名 `BM_CLICK` / `WM_SETTEXT`）→ 坐标点击；坐标点击前校验顶层窗口 `== GetForegroundWindow`，否则抛 `NOT_FOREGROUND`（防止把字打进别的窗口）。
- 已知限制（真机实测，如实记录）：Chromium 系窗口渲染进程 a11y 默认关，树里只有标题栏，这类窗口请走 `browser_*` 的 CDP 工具；UWP（设置/计算器）`FromHandle` 只回空 `Pane`，暂不支持；WinForms 子控件全报 `Pane`，靠类名消息兜底（实测可用）。
- 端到端验证（走真实工具层，`scripts/see-e2e.mjs` + WinForms 夹具 `scripts/uia-fixture.ps1`）：`deputy_see tree` → `act setValue`（`wm-settext`）→ `act invoke 确定`（`bm-click`）→ 回读文件得到 `clicked:deputy tool ok 7`。
- 自检 61 → 67 项（观察层 6 项）。

## 1.3.48

### 落盘回读：保存类动作由文件系统做最终裁判
- `deputy_act` 新增参数 `verifyFile: { path, minBytes? }`：动作跑完立刻回读磁盘，文件存在（且不小于 `minBytes`）才算保存成功。
- 起因：保存一次文档，ROI 里变化的多半只是保存对话框的消失或状态栏一闪；反过来对话框挡住 ROI 时画面没变化、文件其实已经写好。像素在这两个方向上都会误判，唯一可靠的证据是文件系统本身。
- 判定顺序（`src/verify-file.mjs`）：动作本身硬失败（`halt`/`error`）时保留原判、不被文件结论翻案；像素 `no-effect` 但文件已落盘 → `ok: true, verdict: 'file-ok'`；像素说生效但文件不在 → `ok: false, verdict: 'file-missing'`（另有 `file-too-small` / `file-not-a-file` / `file-no-path`）。
- 回包新增 `file: { path, bytes, verified, reason }`，`render` 里显示「文件已落盘/未落盘 · N B」。
- MCP 形态（`src/mcp/server.mjs`）同步支持，语义一致。
- 自检 56 → 61 项（新增 5 项：够大/缺失/非文件/空路径、双向覆盖与硬失败保护、参数表、handler 改写）。

## 1.3.47

默认桌面模式从 `virtual` 改成 `user`：**直接操作你现在的这张桌面**。

- 起因：任务视图虚拟桌面虽然能跑（彩色整屏 + `SendInput` 都验证过），但它会把你切到另一块桌面，不符合「就是我现在这张桌面」。
  真实桌面路线已真机验证：`SendInput` 点开记事本正文打出 `deputy desktop ok 123`，整屏彩色 1920×1080。
- `config.desktop.mode` 默认 `user`；未知值归一化到 `user`（配错不会退回虚拟桌面）。
- 新增运行时切换：`deputy_desktop({ op: 'open', mode: 'user' | 'virtual' | 'isolated' })`、面板 `POST /api/open {"mode": ...}`；
  `DesktopSession.setMode()` 关旧宿主 → 换 transport → 回 `idle`，对象身份不变（面板闭包持有的引用继续有效），下一次 `ensureOpen()` 用新模式重开。
- `deputy_desktop` 的 `status`/`open` 回包里带 `mode`，模型能确认当前在哪张桌面上。
- 自检 55 → 56 项（新增「桌面模式可运行时切换」）；`scripts/check-plugin.mjs` 断言改成"默认必须是 user + 支持运行时切换"。

## 1.3.46

### 默认桌面模式改为 `virtual`（任务视图里的临时虚拟桌面）
- `config.desktop.mode` 默认值 `user` → `virtual`：动作用的是**另开的一块干净虚拟桌面**，
  用户原来的窗口全部留在上一张桌面，不会被误点、也不会被我们开的程序堆满；关会话桌面即收回。
  取 `mode` 的归一化改成"只认 `isolated`/`user`，其余一律 `virtual`"，配错也不会退回"直接动你的桌面"。
- `cordis.patch.yml` 的 `dsh-deputy-os` 同步写 `mode: virtual`（注释改成"默认 virtual，可切 user/isolated"）。
- 文档：README 头部、三种模式表、默认值说明与代价段全部改为 virtual 默认；`docs/DESKTOP.md` §1.1
  改成"三种模式（默认 virtual）"，并写清为什么不默认 `user`、也不默认 `isolated`。
- 行为不变：`user`/`isolated` 仍可显式配置；`virtual` 的关闭顺序、`VDESK_NOT_ACTIVE` 守卫、
  `$vdLaunched` 只杀自己进程等约束与原实现一致。
- **自检**：`node test/run-tests.mjs` = **55 项全部通过**；`node scripts/check-plugin.mjs` 全部通过。

## 1.3.45

### 对齐豆包那套闭环：应用白名单精确启动 + 布局变化后强制重截
- **应用白名单**（`Get-StartApps` + `apps`/`launch-app` op）：枚举用户与全局开始菜单里的 `.lnk`/`.url`，
  再补 `shell:AppsFolder` 的打包应用（Win11 记事本之类没有快捷方式），按显示名去重；真机 207 项。
  `launch-app` 只认**精确名称**，找不到回 `APP_NOT_FOUND` + 候选名；`.url` 回 `APP_NOT_LAUNCHABLE`；
  目标缺失回 `APP_TARGET_MISSING`。`.lnk` 用 `WScript.Shell.CreateShortcut` 解出 `TargetPath/Arguments`
  再 `CreateProcessW`，打包应用走 `explorer.exe shell:AppsFolder\<AppID>`。
- **不许随手跑 exe/URI**：`deputy_desktop` 新增 `apps` / `launch-app`，面板新增 `GET /api/apps`、
  `POST /api/launch-app`；`DesktopSession.listApps()` / `launchApp(name)`。启动回执只代表已受理，
  "已受理但还没窗口"时不重试（避免开出两个实例）。
- **rescan**（豆包第②条）：`runner.step` 在画面尺寸/布局变化时回 `rescan: true`（含尺寸变化分支），
  调用方必须重新截图再算坐标 —— 旧截图里的坐标在新界面上根本不存在。
- **真机验证**：虚拟桌面里 `op:"apps"` 拿到 207 项 → `launch-app "Google Chrome"` 拉起 Chrome 新标签页
  （截图 `deputy-app-launch.png`）→ `launch-app "记事本"` 走打包应用通道回 `packaged:true`；
  `close()` 后桌面数回到 1。
- **自检**：`node test/run-tests.mjs` = **55 项全部通过**（新增「应用白名单：只按精确名称启动，找不到抛
  `APP_NOT_FOUND`」与「动作后画面尺寸变化 → rescan=true」）；`check-plugin` 增补应用白名单与 rescan 断言。

## 1.3.44

### 新增 `virtual` 桌面模式：任务视图里开一块临时桌面（豆包式观感）
- **三种模式**：`config.desktop.mode` 现在认 `user`（默认，当前桌面）/ `virtual`（任务视图临时桌面）/
  `isolated`（独立 Win32 桌面）。`src/os.mjs` 只白名单这两个新值，其余一律回落 `user`。
- **宿主实现**（`scripts/windows-desktop.ps1`）：C# 侧新增 `keybd_event` 绑定的 `WinCtrlCombo`、
  注册表读取器 `VdValue`、`CurrentDesktopGuid` / `DesktopCount` / `OnTempDesktop`；PS 侧 `NewVirtualDesktop`
  （记原 GUID → `Win+Ctrl+D` → 等 1.8 s → 读回校验）与 `CloseVirtualDesktop`（停在新桌面上直接 `Win+Ctrl+F4`，
  等 1.6 s → 用 GUID 确认已离开）。启动分支回 `mode:'virtual'` 与原/临时 GUID，新增 `vdesk-status` op。
- **输入守卫**：`virtual` 的 `input` 先校验当前桌面仍是临时桌面，否则回 `VDESK_NOT_ACTIVE`；
  `DesktopSession.input` 遇到宿主 `ok:false` 现在会抛错（以前 viewer 会把 `ok:true` 一路回给面板，点了等于没点）。
  启动程序的 pid 记在独立的 `$vdLaunched`，`close`/`finally` 只杀这一批，**绝不**碰用户自己的进程。
- **screen 快照/捕获**：`virtual` 与 `user` 一样走整屏（彩色 PNG），窗口分支仅 `isolated` 使用。
- **真机验证**：探针开 `virtual` 会话 → 空桌面彩色整屏（任务栏「桌面 2」）→ 启动记事本 → 点正文 → 打出
  `deputy virtual desktop ok 789`；`close()` 之后注册表 `count=1`、`CurrentVirtualDesktop` 回到原 GUID。
- **已知边界**：DSH 面板窗口无法挪到临时桌面（`MoveWindowToDesktop` 对别的进程返回 `E_ACCESSDENIED`），
  操作期间用户看到新桌面而看不到侧栏页；切换桌面瞬间屏幕会闪一下。
- **自检**：`node test/run-tests.mjs` = **53 项全部通过**（新增「virtual 不要求 attached、宿主拒绝输入抛
  `VDESK_NOT_ACTIVE`」）；`scripts/check-plugin.mjs` 增加 virtual 断言（`$isVirtual`、`WinCtrlCombo`、
  `CurrentDesktopGuid`、`CloseVirtualDesktop`、`VDESK_NOT_ACTIVE`、`vdesk-status`、关闭顺序注释、
  `os.mjs` 认 `virtual`）。

## 1.3.43

### 面板改成彩色整屏，启动程序抬到最前
- **面板不再只有灰度**：`/api/frame` 优先走宿主新增的 `snapshot` op —— 宿主侧 `BitBlt/PrintWindow` 后直接编码成
  **彩色 PNG** 返回（`SnapshotScreen` / `SnapshotWindow` + `ToPngBase64`/`EncodePng`）。老宿主或测试假宿主没有
  `snapshot` 就自动退回原来的灰度帧，行为不变。
- **体积**：1080p 彩色 PNG 一帧约 0.4–0.6 MB；`maxWidth: 1600` 让宿主先等比缩小再编码（面板显示宽度本来就只有
  1000 出头），把帧压到一半以下。实测 1600×900 一帧约 230 ms、400–500 KB。
- **点击坐标**：帧被缩小后，`/api/frame` 额外回 `frameWidth/frameHeight`（**缩放前**像素），
  `viewer.mjs` 的点击换算改用它们（之前用显示宽高，缩放后会整体点偏）；窗口帧仍叠加 `originX/originY`。
  假宿主补了 `state.inputLog`，自检里断言「发到宿主的坐标已经加上窗口原点」。
- **启动后抬到最前**：user 模式 `launch` 之后调 `RaiseProcessWindow(pid, 2500)` —— Windows 前台锁不允许后台进程
  `SetForegroundWindow`（实测 `AttachThreadInput` 绕法也被拒），但允许用
  `SetWindowPos(HWND_TOPMOST→HWND_NOTOPMOST, SWP_NOACTIVATE)` 把窗口抬到 z-order 顶部：
  截图里它就是最前的，点它时鼠标消息会落到它身上，**点击本身完成激活**。单实例程序（Win11 记事本）会把窗口交给
  已有进程，启动的 pid 随即退出，所以还有一层「按 exe 名找已有窗口再抬」的兜底，回执多一个 `focused`。
- **风险如实说明**：user 模式是在用户自己的桌面上注入输入。启动的程序若抬不到最前，点击会落到当时该坐标下的窗口
  （真机测试时就曾把测试文字打进用户正在编辑的 Excel 公式栏）。所有动作前后都能用 `deputy_sense`/面板截图核对；
  不确定时先用 `isolated` 模式。
- **自检**：`node test/run-tests.mjs` = **52 项全部通过**（新增「彩色快照优先，点击按缩放前像素换算」）；
  `check-plugin.mjs` 新增彩色快照与 `frameWidth` 断言（并禁止回退到绝对定位的旧状态点）。

## 1.3.42

### 默认改在「真实桌面」上操作（对齐豆包式电脑操作）
- **为什么改**：旧实现用 `CreateDesktop` 建隐藏桌面 —— 该桌面没有 DWM 合成，桌面级 `BitBlt` 全黑，
  只能逐窗口 `PrintWindow`，所以面板里看到的永远"只有窗口、不是桌面"；它也不是输入桌面，
  `SendInput` 被接受 `0/N`，退而用 `PostMessage` 又会被 Chromium 这类自绘输入的窗口丢掉 —— 表现就是**点不动**。
  豆包/UI-TARS 那一套是**在当前用户会话里整屏截图 + 注入合成事件**，这才是"正常用户桌面"。
- **宿主双模式**：`windows-desktop.ps1` 新增 `-Mode isolated|user`（JS 侧 `config.desktop.mode`，**默认 `user`**）。
  `user`：不建桌面，整屏 `Capture`、`ClickUser`（`WindowFromPoint` → `SetForegroundWindow` → `SetCursorPos` → `SendInput`）、
  `TypeUser`（`KEYEVENTF_UNICODE` 逐字符）、`KeyUser`（`VK` down/up）、`LaunchUser`；
  `isolated`：保留原 `CreateDesktop` + `PrintWindow` + `PostMessage` 路径。
  `user` 模式的 `close` **绝不** `CloseDesktop`、**绝不**杀 `$launched` 里的进程。
- **DPI 修正**：宿主启动即 `SetProcessDPIAware`（150% 缩放下 `GetSystemMetrics` 会只给 1280×720，
  与实际 1920×1080 帧错位，点击整体偏）。
- **接线**：`createHostTransport({ mode })` 追加 `-Mode`；`DesktopSession.mode` 以宿主回执为准，
  `user` 模式下不校验 `attached`；`cordis.patch.yml` 的 `dsh-deputy-os` 写 `mode: user`。
- **真机证据**：`user` 模式整屏 1920×1080 捕获（任务栏、DSH 窗口、防火墙浮窗都在），点击记事本正文后
  打出 `deputy user desktop ok 123`（截图 `deputy-user-3.png`）；`isolated` 模式仍能建桌面、开 Edge 到 B 站。
- 仍是 51 项自检（宿主测试改为「user 走 SendInput、isolated 走 PostMessage，且保留 UTF-8 BOM」）；
  `check-plugin` 的宿主段改为双模式断言（`ValidateSet`/`$isUser`/`ClickUser`/`TypeUser`/`SendChecked`/
  `SetForegroundWindow`/`SetProcessDPIAware` + 原 `PostMessage` 系列 + BOM + `-not $isUser` 保护）。
- 代价与边界：`user` 模式会真的占用鼠标键盘（点击会切前台）；高 DPI 多屏/非 100% 缩放的副屏坐标换算未验证。

## 1.3.41

### 隔离桌面里的点击与打字真正可用（真机）
- **根因**：隔离桌面不是「输入桌面」，`SendInput` 注入的事件只会落到用户当前活动桌面，
  实测被接受 `0/N`；`SetCursorPos` 先成功，于是报错显示成「操作成功完成」。
- **修法**：宿主改为 `PostMessage` 直接投递给该桌面里的目标窗口 —— `WindowFromPoint` +
  `ScreenToClient` 定位，`WM_MOUSEMOVE`/`WM_LBUTTONDOWN`/`WM_LBUTTONUP`（右键 `0x0204`/`0x0205`）点击，
  `WM_CHAR` 逐字符打字，组合键改投 `WM_KEYDOWN`/`WM_KEYUP`（逆序释放）。
- **工具返回值不再触发宿主校验**：`deputy_desktop` 的 `status`/`launch` 不再回 `null` ——
  0.2.2 会用 `output.schema` 校验返回值，`pid`/`error` 给 `null` 会直接报
  `invalid output: "value.pid" must be a number`。没值就整个字段省掉（子集不支持 nullable）。
- **真机证据**：隔离桌面里启动记事本 → 点击正文 → 打字，窗口标题与正文都出现
  `deputy desktop hello 123`（截图 `deputy-type-check.png`）。
- 已知边界：靠 `GetKeyState` 判断修饰键的快捷键（部分浏览器）可能不认投递的按键。
- 自检 50 → 51 项，新增「宿主脚本输入不走 `SendInput` 且保留 UTF-8 BOM」；
  `check-plugin` 增加 BOM、`PostMessage`/`WindowFromPoint`/`ScreenToClient`/`WM_CHAR`/`GetGUIThreadInfo`
  与「禁止回退 SendInput」断言。
## 1.3.40

### 监视窗完整等比显示与可点击修复
- **不再裁掉画面**：`ResizeObserver` 读取监视窗实际可用宽高，结合宿主真实帧尺寸计算等比缩放，显式设置图片宽高；居中留白，底部显示源尺寸、渲染尺寸与比例。
- **不再把点击变成拖图**：禁用 HTML 图片原生拖拽并阻止 `dragstart`，移除 `cursor:crosshair`，左右键仍分别发送到隔离桌面。
- **缩放后坐标准确**：按实际渲染图片的 bounding rect 做归一化，留白不会进入远程坐标；既有 `originX/originY` 窗口偏移转换保持不变。
- 客户端回归用例扩展横竖比例、零尺寸、越界点击和禁拖断言。按用户要求未运行测试或 DSH 真机。

## 1.3.39

### 浏览器控制从单标签骨架补全为可恢复实现
- **结构化等待**：导航同时检查 readyState、当前 target 在途请求与网络静默；新增元素等待和动作后最小静默，后台标签请求不再阻塞当前页。
- **遮挡不再放行**：用真实 `elementFromPoint` 命中关系判断遮挡，默认返回 `OVERLAY`；只自动点击明确的关闭/取消控件，不自动点确定、支付、发布或删除。
- **多标签与表单**：新增 target 列表/新建/切换/关闭、`waitFor`、`select`、组合键 modifiers、文件上传与下载完成事件。
- **截图与注册 ABI**：`browser_observe` 可通过 `attachments.saveImage` 返回真实 image content block；五工具统一走公共 `tools.register` 适配层，output schema 与 author 参数表保持 0.2.x 约束。
- **快照质量**：AX 补齐 disabled/readonly/value，`within` 支持 ref/id/区域名及后代，新增 `maxChars` 预算。
- **写操作保护**：`external/irreversible` 步骤要求用户批准后的 `confirmed=true`；`idempotencyKey` 对进行中和最近 50 条结果去重，降低表单重复提交风险。
- **恢复与重连**：状态原子落盘且 URL 去掉 query/hash；启动恢复上次标签，CDP 断线/浏览器退出后下一次调用重连或重启。
- 自检用例 **42 → 50 项**，新增等待、禁用、遮挡、确认、多标签、幂等、下载与截图附件覆盖。本轮按用户要求只写代码和测试，**未启动 DSH 或浏览器做真机实测**。

## 1.3.38

### 桌面控制真机审计与闭环修复
- **面板收起后可重开**：`DesktopSession.ensureOpen()` 不再把 `closed` 当成永久终态；
  旧桌面仍按原规则销毁，重新打开时新建宿主与 Desktop。运行中的 DSH 已复现旧版固定返回
  `ECLOSED` 的问题，本版补了「open → close → ensureOpen」回归。
- **窗口局部帧坐标归一**：宿主回传窗口 `originX/originY`，`DesktopSession.input()` 把帧内点击
  平移为桌面绝对坐标；旧版窗口不在 `(0,0)` 时点击会整体偏移。
- **Windows 启动参数正确转义**：按 `CommandLineToArgvW` 规则处理空格、空参数、引号和尾部
  反斜杠，不再直接 `args.join(' ')`；`CreateProcessW` 返回的进程/线程句柄立即关闭。
- **宿主失败不再静默**：桌面附着改在干净 STA 线程中验证，UIA 也在同一路径执行；
  PowerShell 使用 `%SystemRoot%` 下的绝对路径，避免精简 PATH 中 `spawn ENOENT`；
  `SendInput` 校验实际接受的事件数，点击支持 `clicks`，补齐已声明的 `input.op=key` 组合键。
- **ROI 与帧尺寸修正**：区域外差分直接按像素数扣除 ROI，修掉 `full > inside` 闸门造成的
  副作用漏报；动作每次尝试前重新采基线；动作/观察前后尺寸变化不再跨尺寸索引旧缓冲区。
- 自检 **35 → 42 项**，新增关闭重开、参数转义、帧原点、ROI 外部污染、尺寸变化与重试基线覆盖。

## 1.3.37

### 修 npm 发布脚本在 Windows 上跑不起来
- `scripts/publish-npm.mjs` 原来用 `execFileSync('npm', …)`：Windows 的 npm 是 `npm.cmd`，
  Node 18.20+ 不允许免 shell spawn `.cmd`，于是 `npm publish --dry-run` 直接
  `ENOENT: spawnSync npm`，dry-run 都没法验打包。
- 改成 `execSync(`npm ${args.join(' ')}`, { cwd: stage, stdio: 'inherit' })`，交给 shell 解析
  `npm` / `npm.cmd`；参数里没有空格，不需要转义。顺带消掉 `shell: true + args` 的 DEP0190 警告。
- 现在 dry-run 正常打包：`dsh-deputy@1.3.36` → 46 files / 112.0 kB。真实发布仍需
  `npm login`（本机 `npm whoami` 报 ENEEDAUTH，仓库版本 1.3.37 而 registry 还是 1.1.30）。
- `check-plugin` 增加断言：发布脚本必须用 `execSync` 调 npm，防止回退。

## 1.3.36

### 侧栏状态点跟到行文字右边
- 之前圆点挂在图标容器里（图标和文字之间），看起来更像「图标角标」；现在改成
  `[class*="_panelTitle"]::after` 画在**标题文字右边**（6px 圆点、margin-left 6px），
  颜色由 `:has(.ddp-glyph[data-level=…])` 从同一个 `data-level` 取（绿 #22c55e / 红 #ef4444 / 灰 #9ca3af）。
- 不改侧栏自己的 React 树、也不绝对定位：圆点随标题的省略号截断一起收缩，窄栏（只显示图标）
  时标题隐藏、圆点自然不出现，也不会撞悬停才显形的大头针（`.panelUnpin{right:0;width:28px}`）。
- `check-plugin` 断言改为「必须含 `_panelTitle` + `::after`，且不得再出现 `ddp-dot`」。

### 浏览器组件继承本机登录态（cookies）
- 新增 `src/browser/cookies.mjs`：启动浏览器**之前**把本机 Edge/Chrome 的
  `<User Data>/Local State` + `<profile>/Network/Cookies`（含 -journal/-wal/-shm）只读复制进
  daemon 自己的 `user-data-dir`；自动找源目录与 profile（Default 优先，其次 cookie 库最新），
  也可用 `cookiesSource` / `cookiesProfile` 指定。复制失败不阻断启动，只标
  `cookies.reason`（`NO_SOURCE` / `NO_PROFILE` / `COPY_FAILED`…）。
- 接线：`launch.mjs` 传 `loginState` 并回 `loginState`；`daemon.mjs` 起完后用 CDP
  `Storage.getCookies` 数实际条数（`status().cookies.count`）；`browser_open` / `browser_status`
  的返回与 output schema 增加 `cookies`，并给一句中文提示；`browser.mjs` 增加
  `cookies` / `cookiesProfile` / `cookiesSource` / `persistProfile` 配置，`user-data-dir`
  默认固定在 `%LOCALAPPDATA%\dsh-deputy\browser-profile`，所以在面板里登录一次能跨启动保留。
- 真机结论（必须如实知道）：本机 Edge 的 cookie 库 403 行、成功复制 1.26 MB，但新实例里
  `Storage.getCookies` 读到 **0 条**——Edge/Chrome 127+ 的 App-Bound Encryption 让复制出来的
  cookie 解不开（试过 `--disable-features=msEdgeAppBoundEncryption` / `AppBoundEncryption` 及
  两者组合、非 headless，均 0 条）。因此插件**不会**把「复制成功」当成「已登录」，
  只以 `count` 为准。
- 风险写在 [docs/BROWSER.md](docs/BROWSER.md) 的「5.1 登录态（cookies）与风险」：等于把登录身份
  交给自动化（`cookies:false` 可关）、凭据落盘、ABE 静默失效、退出登录不同步、
  `--remote-debugging-port` 本机任意进程可连。
- 自检 34 → 35 项（新增登录态复制：正常复制 / `NO_SOURCE` / `NO_PROFILE` / `NO_DEST` 均不抛错）。

## 1.3.35

### 侧栏入口消失的真机根因（包根锚点 row）
- 现象：拆成 `dsh-deputy/os` + `dsh-deputy/browser` 之后，重启 DSH，侧栏「DSH操作电脑」整行消失。
- 根因在 0.2.2 的 `@deepseek-ai/dsh-client-modules`：客户端把 Loader 行的 `options.name`
  交给 `resolveMeta` → `locatePkgJson`，那里用 `exactPackageSpecifier` 校验——它只认
  `@scope/name` 或不含 `/`、`:` 的包根名，**子路径一律返回 `undefined`**
  （源码注释：builtins 与 subpath entries "land here — not a client row"）。于是
  `name: 'dsh-deputy/os'` 这些 row 都不产生客户端行，`client.js` 从不被加载，
  `window.__DSH_BOOT__.entries` 里也没有 `dsh-deputy`。
- 修法：`cordis.patch.yml` 增加一条**不带 id** 的包根 row `name: 'dsh-deputy'`，由它触发
  客户端发现；不带 id 所以插件管理器「包含的组件」仍是两行（`dsh-deputy/os` / `dsh-deputy/browser`）。
  `src/index.mjs` 相应改成空组件：`name = 'dsh-deputy'`、`inject = []`、`apply() {}`，
  但继续 re-export `toolSpecs` / `registerTools` / `toParameters`，老路径与测试照旧。
- 验证：测试 profile 冷启动 → `__DSH_BOOT__.entries` 出现
  `{id:'dsh-deputy', url:'plugins/??dsh-deputy/client.js&rev=…'}`，侧栏出现「DSH操作电脑」
  （图标 + 状态点），点开中央面板正常出页面；`check-plugin` 增加锚点断言（缺锚点直接失败），
  自检 33 → 34 项。

## 1.3.34

### 侧栏状态点挪到图标旁边
- 之前的状态点是 `position:absolute;right:7px`，落在侧栏那一行的最右端；而侧栏自己的
  unpin（大头针）按钮正是 `.panelUnpin{position:absolute;right:0;width:28px}`，悬停时两者重叠。
- 现在状态点内联进图标容器（`.ddp-glyph` = 图标 + 4px gap + 6px 圆点），随 glyph 走，
  不再碰行右端；窄栏（36px 图标座）时也仍是图标右侧一点。删掉「悬停隐藏状态点」的补偿规则。
- `check-plugin` 增加防回退断言：必须出现 `ddp-glyph`，且不得再出现 `position:absolute;right:7px`
  或 `.panelEntry:hover`。

## 1.3.33

### 一个包拆成两个组件（插件管理器里两行）
- `dsh-deputy/os`（`src/os.mjs`）：隔离桌面这一半，4 个 `deputy_*` 工具与原样行为不变。
- `dsh-deputy/browser`（`src/browser.mjs`）：新的浏览器操作组件，5 个 `browser_*` 工具。
- `cordis.patch.yml` 改成一条 `- insert:` 下两条 entry（`dsh-deputy-os` / `dsh-deputy-browser`），
  `exports` 增加 `./os` 与 `./browser` 子路径；`src/index.mjs` 退化成 `export * from './os.mjs'`
  的兼容入口（测试、MCP、外部 import 的老路径照旧）。
- 抽公共层：`src/registry.mjs`（`toParameters` / `text` / `registerTools` 的唯一实现）、
  `src/status.mjs`（两个组件共享的状态总线）。

### 侧栏：状态点 + 不再全黑
- 侧栏「DSH操作电脑」一行右侧加状态点：**绿 = 有桌面/浏览器在跑，红 = 最近一次操作失败，
  灰 = 都没开**。读 `GET /api/status`（`status.mjs` 合成，优先级 `error > running > idle`），
  无人订阅时 2 秒轮询自动停。
- 修掉「能打开桌面但画面全黑」：根因是宿主在找不到窗口时回退到桌面级 `BitBlt`，
  而隔离桌面没有 DWM 合成，必然全黑；而且 `wantPid=0` 时会把宿主自己的黑底控制台当成
  最大窗口拍下来。现在 `CaptureWindow(desk, wantPid, excludePid)` 会排除宿主自身进程，
  找不到就回 `NOWINDOW`，**绝不回退黑图**。
- 面板对 `NOWINDOW` 给出「桌面里还没有窗口」+「启动 Edge」「启动记事本」按钮，
  走新的 `POST /api/launch { app: 'edge' | 'notepad' }` 预设。

### 浏览器组件（骨架，按 `context.md` 写，调优留后续）
- `browser/launch.mjs`：找 Edge/Chrome、挑空闲端口、`--remote-debugging-port` + 独立
  `user-data-dir` 启动，轮询 `/json/version` 拿 ws 端点。
- `browser/cdp.mjs`：Node 22 全局 WebSocket 上的极简 CDP 客户端（flatten sessionId 多 target）。
- `browser/daemon.mjs`：`BrowserDaemon`，懒启动；target/节点两张注册表 + `docEpoch`
  （`Page.frameNavigated` / `DOM.documentUpdated` / `navigatedWithinDocument` 时自增并清空节点）。
- `browser/snapshot.mjs`：`DOMSnapshot.captureSnapshot` + `Accessibility.getFullAXTree` 压成文本，
  剪枝（无 quad / 零尺寸 / `display:none` / `visibility:hidden` / `opacity:0` / `aria-hidden` /
  装饰容器），视口内与可交互优先，ref 形如 `e<docEpoch>.<nodeIndex>`。
- `browser/act.mjs`：click/type/key/hover/scroll/press/navigate/wait/reload；
  前置 `scrollIntoViewIfNeeded` + 中心点 `elementFromPoint` 粗检遮挡，执行用成对
  `Input.dispatchMouseEvent` 与 `Input.insertText`；批处理**遇 `docEpoch` 变化即停**。
- `browser/errors.mjs`：失败分类带 `hint`（`STALE_REF` / `DOC_CHANGED` / `OVERLAY` /
  `AUTH_BLOCKED` / `NAV_TIMEOUT` / `AMBIGUOUS_TARGET` / `NOT_RUNNING` / `CDP_ERROR` / …），
  工具与 HTTP 共用 `{ ok:false, error:{code,message,hint} }` 信封。
- 真机跑通主链：headless Edge → `https://www.bilibili.com` → 快照 686 节点 / 列出 240 行 →
  `act({steps:[{verb:'click',ref:'e4.113'}]})` → `{ok:true, diff:{urlChanged:true, epoch 4→7}}`。
- 修掉两个只有真机才暴露的快照 bug：① ref 里的代数是局部自增计数器，与 `docEpoch` 不等，
  导致**每次点击都 STALE_REF**；② 元素节点的 `nodeValue` 是数字 `-1`，原来被输出成 `= "-1"`。
- 明确未做（列在 `docs/BROWSER.md` 第 7 节）：等待三层（lifecycle + 网络静默 + 元素级）、
  遮挡自动处理、`disabled` 判定走 AX properties、多标签/iframe/上传下载、跨进程常驻 daemon、
  凭据脱敏与动作分级、`state.json` 恢复、重试策略。

### 自检
- `test/run-tests.mjs` 29 → **33 项**：新增状态总线合成、浏览器 5 工具注册与
  `STALE_REF` 信封、`runSteps` 遇布局变化即停、`resolveRef` 代数校验四条。
- `scripts/check-plugin.mjs` 增加三段：两个组件（`cordis.patch.yml` 两条 entry +
  `exports ./os ./browser` 可解析）、`browser_*` 五个工具的 output schema 与 author 参数表、
  状态总线语义（idle → running → error → 清错回 running）。
- 新增 `docs/BROWSER.md`；`docs/VIEWER.md` 补 `/api/status`、`NOWINDOW`、`/api/launch` 预设。

## 1.2.32

### 常驻宿主的真机修复（隔离桌面里真的打开浏览器并能拍到画面）
- **窗口捕获取代全桌面 BitBlt**：隔离桌面没有 DWM 合成，桌面级 `BitBlt(GetDC(NULL))` 必然全黑。
  新增 `CaptureWindow(desk, wantPid)`：在已 `SetThreadDesktop` 的宿主里枚举该桌面的可见窗口，
  按面积取最大（可限定 pid），`PrintWindow(hwnd, memDC, PW_RENDERFULLCONTENT=2)` 后转灰度。
  找不到窗口才回退桌面 BitBlt，并在回执里标 `source: "desktop"` 说明降级原因。
- **启动命令要给 exe 加引号**：`CreateProcessW(exe, exe + " " + args)` 会把
  `C:/Program Files (x86)/...` 按空格拆开，浏览器于是把 `files`、`(x86)` 当成网址打开
  （现场表现是 `DNS_PROBE_FINISHED_NXDOMAIN`）。改为 `"\"" + exe + "\" " + args`。
- **桌面相关操作移进无窗口的 STA 后台线程**：主线程已有控制台窗口，`SetThreadDesktop` 返回
  `ERROR_BUSY(170)`，一切操作都落在用户桌面上（树里能看到用户自己的窗口）。
  新增 `OnDesktop(desk, action)`，在从未建过窗口的新线程里切桌面再执行。
- **传输握手补 `create` 回执**：`transport.start` 发的 `{op:'create'}` 原先无人应答。
- **控制台编码改 UTF-8**：窗口标题里的中文不再输出成 GBK 乱码（`无标题` 不再变 `�ޱ���`）。
- **脚本必须存成 UTF-8 with BOM**：UTF-8 无 BOM 时 Windows PowerShell 按 CP936 解码，
  中文注释尾部字节会吞掉换行，后续 C# 成员被并进注释行，报
  `类、结构或接口成员声明中的标记"="无效`。`Add-Type` 也去掉了与 `-TypeDefinition`
  冲突的 `-Namespace`/`-Name`（原先报 `AmbiguousParameterSet`，被误读成参数绑定失败）。
- 新增只读诊断 op `debug`：线程桌面名 / 桌面句柄 / 枚举窗口数 / UIA 根子元素数，
  用于确认"到底在哪个桌面"。
- 真机回归：隔离桌面里启动 Edge 打开 `https://www.bilibili.com`，
  窗口标题与 1946×1106 灰度帧（`bright=44022`，PNG 756 KB）都取到，画面确认是 B 站首页。

## 1.2.31

### 对齐 DSH 0.2.2 的插件 ABI
- 版本号从四段 `1.2.0.31` 改为标准三段 semver `1.2.31`：pnpm/npm 本地 link 安装同样校验版本，
  四段会直接 `ERR_PNPM_BAD_PACKAGE_JSON: Invalid version`，导致装不进真实 profile。
- `package.json.repository` 改为 SSH（`git+ssh://git@github.com/bgsgp/dsh-deputy.git`），git remote 本来就是 SSH。
- 清单迁移：删除 `dsh.plugin.json`（0.2.x 已不读取），bundle / client / icon / `engines.dsh`
  全部写进 `package.json` 的 `dsh` 字段；新增 `assets/icon.svg`。
- `engines.dsh = ">=0.2.2-rc.1 <0.2.3-0"`、`engines.node = ">=22.12.0"`；
  peer 从 0.1.x 的 `dsh-client-runtime` / `dsh-client-ui-layout` 换成 `@deepseek-ai/cordis` + `@deepseek-ai/dsh`。
- `dsh.client.inject` 改为 `@deepseek-ai/dsh-client-ui-renderer`（`slots` 服务提供方）。
- 图片出口按新契约重写：`deputy_sheet` 调 `ctx.attachments.saveImage()` 拿 `ImageAttachmentRef`，
  `render()` 返回 `{ type: 'image', attachment }` content block；不再在 `apply()` 里偷推附件
  （`attachments.add` 在 0.2.x 已不存在）。
- 工具注册去掉 0.1.x 的 `define(name, desc, schema, handler)` 回退，只走 `tools.register(defineTool(...))`；
  `deputy_sense` 标记 `isConcurrencySafe`，其余桌面类工具保持独占。
- `inject` 去掉未使用的 `sessionController`（其 `prompt()` 是 gateway 远程 API，不适合插件自推）。
- `check-plugin.mjs` 重写为 0.2.2 机检：清单字段、`engines.dsh`、内联 required、
  工具 `output.schema/render`、`isConcurrencySafe`、`saveImage` + image block、icon 尺寸。
- 自检 24 项 → **29 项**，新增附件图片出口、attachments 缺失降级、0.2.x 注册签名、schema 形态四组断言，
  以及用 stub `window.__ModuleLoader__` 真加载 `client.js` 校验 `sidebar.panellist` + `main` 注册。

### 真机装载暴露的三处 ABI 修正（0.2.2-rc.5）
- **output.schema 必须用标准 JSON Schema**：`required` 是对象上的字符串数组，
  不能像参数表那样内联成字段上的 `required: true`。真实注册会抛
  `JsonSchemaError: unsupported JSON schema: schema.properties.ok.required is not supported on type "boolean"`，
  整个插件入口不激活。四个工具的 output 全部改写，`check-plugin.mjs` 增加子集校验。
- **parameters 的 object 字段必须显式 `additionalProperties`**：author 参数表编译时抛
  `parameters.payload.additionalProperties must be explicitly true or false`，
  不是等到工具调用才报。已补 `deputy_act.payload`。
- **清理走 `ctx.effect`**：Cordis 4 的 ctx 是严格 getter，读未注入的 `ctx.onDispose`
  直接抛 `cannot get property "onDispose" without inject`；改为 `ctx.effect(() => () => ...)`。
- 以上三条都用真实 DSH 运行时验证：同一份 `@deepseek-ai/dsh-tools` 的
  `validateArgs` / `assertSupportedJsonSchema` 跑过 4 个工具；测试 profile 冷启动
  `dsh --profile deputy-live` 不再出现 `1 entry did not activate`。

### 界面入口：从浮窗胶囊改为侧栏「DSH操作电脑」一页
- 用户要的是跟「新建 / 搜索 / 自定义 / QQ机器人 / 定时任务 / 上下文洞察 / 主题 / 免费搜索」
  并列的常驻项，不是左下角 `shell.overlay` 浮窗，所以挂载点整体换掉。
- `client.js` 重写：`ctx.slots.inject('sidebar.panellist')` 注册 `{ id: 'dsh-deputy-desktop',
  order: 40, label: 'DSH操作电脑' }` + 显示器/指针图标（收 `{ size, active }`）；
  `ctx.slots.inject('main')` 注册同 `key` 的整页组件。侧栏点击由 ui-sidebar 自己调
  `ctx.layout.selectPanel(id)`，插件不碰 layout。
- 页面改成整页布局（`.ddp-*`）：标题栏（状态 / 桌面名 / 打开 / 刷新 / 收起）、
  中央画面（`object-fit: contain`，点画面发归一化坐标 `POST /api/input`）、
  底部尺寸 / pid / 安全提示。组件卸载即停轮询，切页不空转。
- 删掉旧的 `ViewerWindow` / `Toggle` 浮窗体与 `.ddp-pill/.ddp-win` 样式。
- `dsh.client.inject` 补 `@deepseek-ai/dsh-client-ui-sidebar`（`sidebar.panellist` / `main`
  两个座位的声明方）；`ui-renderer` 保留（`slots` 服务）。
- `check-plugin.mjs` 的客户端段重写：断言注册 `sidebar.panellist` + `main`、侧栏名是
  「DSH操作电脑」、且**不允许**再出现 `shell.overlay`（防回退）。
- docs/VIEWER.md 整节改写（座位契约表、点行如何切页、防误注册 `sidebar`）。

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
