# 桌面执行层：真实桌面（默认）与隔离桌面两种模式

这篇是两个模式的执行层。`ISOLATION.md` 讲隔离原理；这一版把它做成**活着的会话**，
并且承认一个事实：**想「像人一样正常操作电脑」，就必须在真实桌面上做**（整屏 + 注入合成事件），
隔离桌面是「不打扰用户」的那条备选路径，两者共用同一个宿主进程。

## 1. 为什么必须常驻

Windows 的桌面对象是**引用计数**的：

```
CreateDesktopW(...) → handle ──┐
                              ├─→ 还有一个句柄在，桌面就活着
CloseDesktop(handle) ─────────┘   最后一个句柄关闭 → 桌面销毁，里面所有窗口一起没
```

进程退出 = 句柄关闭 = 桌面没了。所以"建桌面拿个 handle 存起来、下次另起进程用"是行不通的。
正确形状是一个**常驻宿主进程**：

```
JS 侧                         宿主进程（windows-desktop.ps1 host）
DesktopSession.open()  ────────▼ CreateDesktopW + SetThreadDesktop
                                                    │
startApp(exe)          ────────► CreateProcessW(lpDesktop="WinSta0\deputy-x")  ← 目标程序
capture()              ────────► 逐窗口 PrintWindow 捕获 ──┐
tree()                 ────────► UIA RootElement 取树   ├─ 都在同一桌面对象里
input(click/type)      ────────► PostMessage(WM_*)       ──┘
close()                ────────► 宿主退出 → 桌面销毁
```

通信是**行分隔 JSON**：一行一条请求，一行一条回执，带 `id` 做多路复用。
这就是"真的在里面操作"与"只是在旁边截图"的区别——采帧、取树、输入、目标进程，
四者处在同一个桌面对象上。

## 1.1 两种模式：`-Mode user`（默认）与 `-Mode isolated`

宿主脚本的参数是 `param([Parameter(Mandatory=$true)][string]$Op, [string]$Name='deputy-default', [ValidateSet('isolated','user')][string]$Mode='isolated')`，
JS 侧的默认值来自 `config.desktop.mode`（**默认 `user`**），经 `createHostTransport({ mode })` 变成命令行参数 `-Mode user`。

| 维度 | `user`（默认） | `isolated` |
|---|---|---|
| 桌面对象 | 无（操作当前输入桌面） | `CreateDesktopW` + `SetThreadDesktop` |
| UAC | 不需要 | 需要管理员（`GENERIC_ALL`） |
| 画面 | 整屏 `Capture([IntPtr]::Zero, ScreenWidth, ScreenHeight)`，回 `source:'screen'` | 逐窗口 `CaptureWindow`，回 `source:'window'` |
| 点击 | `WindowFromPoint` → `SetForegroundWindow` → `SetCursorPos` → `SendInput`（`MOUSEEVENTF_*`） | `PostMessage` `WM_MOUSEMOVE/LBUTTONDOWN/UP` |
| 打字 | `SendInput` + `KEYEVENTF_UNICODE`（逐字符 down/up，IME 与自绘窗口都认） | `PostMessage` `WM_CHAR` |
| 快捷键 | `SendInput` `VK` down/up（`GetKeyState` 型快捷键也认） | `PostMessage` `WM_KEYDOWN/UP`（部分浏览器不认） |
| 启动程序 | `CreateProcessW`；随后 `RaiseProcessWindow` 用 `SetWindowPos`(TOPMOST→NOTOPMOST, NOACTIVATE) 抬到 z-order 顶部（前台锁下 `SetForegroundWindow` 无效），单实例程序按 exe 名找已有窗口 | `CreateProcessW` 到目标桌面，`PrintWindow` 抓它 |
| 关会话 | 只退出宿主，**不** `CloseDesktop`、**不**杀 `$launched` 里的进程 | 退出即销毁桌面与里面所有窗口 |
| 抢不抢用户 | 抢（点击会把目标窗口提到前台） | 不抢 |

为什么默认改成 `user`：豆包那类「电脑操作」= **当前用户会话整屏截图 + 合成鼠标键盘事件**。
隐藏桌面拿不到 DWM 合成（桌面级 `BitBlt` 全黑，只能逐窗口 `PrintWindow`，用户看起来"只有左上角一块"），
它不是输入桌面（`SendInput` 实测 0/N），`PostMessage` 又会被 Chromium 这类自绘输入的窗口丢掉 ——
三条叠起来就是"点不动"。

DPI 一条必须记住：`user` 模式启动后立刻调 `[Deputy.Desk2]::MakeDpiAware()`（内部 `SetProcessDPIAware`）。
不声明 DPI 感知时，150% 缩放下 `GetSystemMetrics(SM_CXSCREEN)` 只给 1280×720，而我们截的是物理 1920×1080，
点击坐标会整体偏 —— 真机上第一帧 1280×720、下一帧才变 1920×1080，就是这个坑。

切换方式：`cordis.patch.yml` 里 `dsh-deputy-os` 的 `config.desktop.mode: user`（或安装后在插件配置里改），
改成 `isolated` 即回到"完全不碰你桌面"的老行为。

## 2. 三个硬性约束（写代码前必须先接受）

| 约束 | 后果 | 本项目的做法 |
|---|---|---|
| `SetThreadDesktop` 只能在线程**尚未创建任何窗口**前调用（仅 `isolated`） | 中途切桌面一定失败 | 宿主进程启动时立即切，之后所有操作都在该桌面做；`user` 模式不切桌面 |
| 非活动桌面不能用 `Windows.Graphics.Capture`；也没有 DWM 合成，桌面级 `BitBlt` 全黑（仅 `isolated`；`user` 桌面有合成，整屏 BitBlt 正常） | 直接截隔离桌面永远拿不到画面 | 逐窗口 `PrintWindow(hwnd, memDC, PW_RENDERFULLCONTENT=2)`：枚举该桌面可见窗口取最大者（可限定 pid），失败才回退桌面 BitBlt |
| 隔离桌面不是"输入桌面"，`SendInput` 的事件只会投到用户当前桌面（实测被接受 0/N，仅 `isolated`） | 鼠标键盘在隔离桌面里完全无效 | 点击/输入改为 `PostMessage` 直接投给该桌面里的目标窗口：`WindowFromPoint` 定窗口、`WM_LBUTTONDOWN/UP` 定位、`WM_CHAR` 打字、`WM_KEYDOWN/UP` 组合键 |
| `CreateDesktopW` 用 `GENERIC_ALL` 需要管理员 | 普通权限直接被拒 | **显式报错**，绡不静默降级到主桌面 |

第三条仍然成立：宿主**不会**因为隔离桌面失败就悄悄退回主桌面 —— 想操作真实桌面只有一条路，
就是用户显式把 `mode` 配成 `user`。`user` 模式也不是降级，而是另一种明确的语义：
自动化正在真的动用户界面，所以 `close()` 绝不 `CloseDesktop`、绝不杀 `$launched` 里的进程。

## 3. 状态机

```
idle ──open()──► opened ──startApp()──► running ──close()──► closed
  ▲                 │                      │                   │
  │                 └─ capture/tree/input 都可（不在 idle 时） └─ close 幂等
  └─ ensureOpen()：closed 后创建全新宿主与 Desktop（旧桌面不会复活）
```

越序调用一律抛 `DesktopError(code=ESTATE)`，而不是"帮你猜一个合理行为"。
`close()` 幂等、不抛：任务失败路径上也要能干净收场。

## 4. UIA 树为什么在宿主里取

`AutomationElement.RootElement` 不是"整个系统"，而是**调用线程所在桌面的根节点**。
宿主线程已经 `SetThreadDesktop` 到隔离桌面，所以它拿到的树天然就是隔离桌面里的窗口。
副作用：PowerShell 自身的隐藏控制台窗口也会出现在树里（`pid` 字段可用于过滤）——
这是原型阶段的已知噪声，生产版应换成无窗口的编译 worker。

## 5. 与"豆包式电脑操作"的差距清单

`user` 模式已经对齐的部分：**整屏截图、在你当前会话里注入合成事件、点击会切前台** —— 这正是豆包/UI-TARS
那一套的主路径（需要隔离时它们用远端虚拟机/VNC，而不是 `CreateDesktop`）。另外还保留了 `isolated` 这条
不打扰用户的路径，这是豆包不给的选项。

还没对齐的：

1. **无窗口 worker** —— 去掉 PowerShell 的隐藏控制台，`isolated` 的 UIA 树才干净。
2. **毫秒级输入时序** —— 现在每次点击/打字都是走 PS 的一轮调用，延迟在 10ms 量级；
   `WM_CHAR` 逐字符投递，高频拖动、IME 组合输入会力不从心。
3. **WGC 快路径** —— 前台/可见场景切换回 `Windows.Graphics.Capture`，画质与 CPU 都好得多；
   只在非活动桌面回落 BitBlt。
4. **输入桌面切换（`OpenInputDesktop` 所有权）** —— 需要处理"隔离桌面里冒出 UAC / 安全桌面"
   的情形，否则任务会看起来卡死。
5. **会话复用** —— 现在是一任务一桌面（干净但慢）；后续做一个受控的桌面池，
   用"任务签名 + 重置策略"保证任务间不串味。

这五条已经进 `ROADMAP.md` 的执行层专项。

## 6. 怎么接进闭环

`runner.mjs` 的依赖是注入式的，所以只要换 sensor / actuator：

```js
const session = new DesktopSession({ transport: createHostTransport(), name: 'deputy-x' })
await session.open()
const deputy = createDeputy({
  sensor: sessionSensor(session),      // 采帧 → 隔离桌面
  actuator: sessionActuator(session),  // 动作 → 隔离桌面
})
// 图片出口：deputy_sheet 的 render() 返回 image content block，
// PNG 由 DSH 0.2.x 的 ctx.attachments.saveImage() 变成 ImageAttachmentRef。
```

感知、打分、拼图、ROI 校验全部不变——它们本来就不认识"桌面"是什么，这正是分层的价值。

## 7. 宿主实现的五个坑（真机踩出来的）

1. **`SetThreadDesktop` 要在无窗口线程里调**。PowerShell 主线程已经有控制台窗口，
   切换返回 `ERROR_BUSY(170)`，之后所有 EnumWindows / UIA / 捕获都落在用户桌面上
   （症状：树里出现用户自己的窗口，截图是用户桌面）。现在的做法是每个操作都扔进
   一个新起的 STA 线程：先 `SetThreadDesktop`，再干活，join 后把异常抛回调用方。
2. **非活动桌面必须逐窗口 `PrintWindow`**。没有 DWM 合成，`GetDC(NULL)` + `BitBlt`
   只能得到纯黑图。`PrintWindow(..., PW_RENDERFULLCONTENT=2)` 会让窗口自己绘制到内存 DC，
   Electron/Chromium 也能出画面。真机实测：隔离桌面里的 Edge 打开 B 站，
   取到 1946×1106 的完整页面帧。
3. **`CreateProcessW` 的 exe 要加引号**。命令行是整串字符串再解析的，
   `C:/Program Files (x86)/.../msedge.exe` 不加引号会被按空格拆开，
   浏览器把 `files`、`(x86)` 当网址打开（表现为 `DNS_PROBE_FINISHED_NXDOMAIN`）。
4. **点击/打字不能用 `SendInput`**。`SendInput` 注入到的是**当前输入桌面**，不是调用线程
   所在桌面；隔离桌面里实测 `SendInput` 接受 0/N 个事件，`SetCursorPos` 还会先成功，
   于是报错信息看着像"操作成功完成"。改法：`WindowFromPoint` + `ScreenToClient` 定目标窗口后
   用 `PostMessage` 投 `WM_MOUSEMOVE/WM_LBUTTONDOWN/WM_LBUTTONUP`（右键 0x0204/0x0205）、
   `WM_CHAR`（逐字符）、`WM_KEYDOWN/WM_KEYUP`（组合键，先后顺序与逆序释放）。
   已知边界：靠 `GetKeyState` 判断修饰键的快捷键（部分浏览器 Ctrl+L 之类）可能不认投递的按键。
   真机实测：隔离桌面里启动记事本 → 点击正文 → 打字 `deputy desktop hello 123`，
   标题栏与正文都出现该文本，截图可见。
5. **脚本得是 UTF-8 with BOM**。UTF-8 无 BOM 时 Windows PowerShell 按 CP936 解码，
   中文注释尾部的字节会吞掉换行，后面的 C# 成员被并进注释，报
   `类、结构或接口成员声明中的标记"="无效`。另外 `Add-Type` 不要同时给
   `-TypeDefinition` 和 `-Namespace`/`-Name`（参数集冲突，报 `AmbiguousParameterSet`）。

诊断入口：`{ "op": "debug" }` 返回线程所在桌面名、桌面句柄、该桌面窗口数、UIA 根子元素数。
