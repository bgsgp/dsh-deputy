# 虚拟桌面执行层：从"能开"到"真的在里面操作"

这篇是 0.0.x 阶段最要紧的一层。前面几版（`ISOLATION.md`）只讲了原理，
`windows-session.ps1` 也只是"建桌面 / 启动 / 关掉"的碎片；这一版把它做成**活着的会话**。

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
capture()              ────────► BitBlt 取该桌面画面  ──┐
tree()                 ────────► UIA RootElement 取树   ├─ 都在同一桌面对象里
input(click/type)      ────────► SendInput             ──┘
close()                ────────► 宿主退出 → 桌面销毁
```

通信是**行分隔 JSON**：一行一条请求，一行一条回执，带 `id` 做多路复用。
这就是"真的在里面操作"与"只是在旁边截图"的区别——采帧、取树、输入、目标进程，
四者处在同一个桌面对象上。

## 2. 三个硬性约束（写代码前必须先接受）

| 约束 | 后果 | 本项目的做法 |
|---|---|---|
| `SetThreadDesktop` 只能在线程**尚未创建任何窗口**前调用 | 中途切桌面一定失败 | 宿主进程启动时立即切，之后所有操作都在该桌面做 |
| 非活动桌面不能用 `Windows.Graphics.Capture` | 拿不到硬件加速界面，Electron/WPF 可能拍成黑块 | 用 `BitBlt`（`GetDC(0)` + `CreateCompatibleBitmap`），接受这个损失 |
| `CreateDesktopW` 用 `GENERIC_ALL` 需要管理员 | 普通权限直接被拒 | **显式报错**，绡不静默降级到主桌面 |

第三条是刻意的：降级到主桌面意味着"用户正在用的界面被自动化乱动"，这比任务失败严重得多。
`DesktopSession` 里没有任何"悄悄退回主桌面"的分支。

## 3. 状态机

```
idle ──open()──► opened ──startApp()──► running ──close()──► closed
  ▲                 │                      │                   │
  └─ 构造            └─ capture/tree/input 都可（不在 idle 时） └─ close 幂等
```

越序调用一律抛 `DesktopError(code=ESTATE)`，而不是"帮你猜一个合理行为"。
`close()` 幂等、不抛：任务失败路径上也要能干净收场。

## 4. UIA 树为什么在宿主里取

`AutomationElement.RootElement` 不是"整个系统"，而是**调用线程所在桌面的根节点**。
宿主线程已经 `SetThreadDesktop` 到隔离桌面，所以它拿到的树天然就是隔离桌面里的窗口。
副作用：PowerShell 自身的隐藏控制台窗口也会出现在树里（`pid` 字段可用于过滤）——
这是原型阶段的已知噪声，生产版应换成无窗口的编译 worker。

## 5. 与"豆包式虚拟桌面"的差距清单

已经对齐的部分：独立桌面、不抢焦点、目标程序整体隔离、采帧与输入都在隔离域内。

还没对齐的：

1. **无窗口 worker** —— 去掉 PowerShell 的隐藏控制台，UIA 树才干净。
2. **毫秒级输入时序** —— 现在每次 `SendInput` 都是走 PS 的一轮调用，延迟在 10ms 量级；
   高频拖动、IME 组合键会力不从心。
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
  onEvidence: (ev) => attachments.add(ev.png),
})
```

感知、打分、拼图、ROI 校验全部不变——它们本来就不认识"桌面"是什么，这正是分层的价值。
