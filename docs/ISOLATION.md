# 隔离层：为什么单开一个桌面，以及为什么它要提权

## 1. 三个必须解决的问题

1. **不能抢用户焦点**：自动化一跑，用户就不能用电脑 = 产品不可用。
2. **不能让脏进程乱写**：桌面里的程序（浏览器、脚本）不该能改系统盘。
3. **不能留下痕迹**：任务结束，环境应该是"没发生过"。

三层隔离分别对应这三条。

## 2. 桌面级隔离（对照 Windows 的 GUI 对象树）

Windows 的 GUI 管理是三级结构：

```
Session（登录会话，用户在主桌面 = Session 1；系统服务在 Session 0）
  └─ Window Station（WinSta0 是可交互的那个，唯一能收到物理输入）
       └─ Desktop（Default 是用户看到的；可以再建任意多个命名桌面）
```

每个 Desktop 拥有**独立的输入队列、窗口列表、剪贴板**，跳桌面 `SendMessage/PostMessage` 默认不通。
所以：

```
CreateDesktopW("deputy-<uuid>", ...)      // 建一个隔离桌面
  → CreateProcessW(..., STARTUPINFO.lpDesktop = "WinSta0\\deputy-<uuid>")
      // 目标进程及其所有子进程都生在隔离桌面里
  → 采集/输入线程 SetThreadDesktop(handle) // 让后续 GUI 调用作用于该桌面
```

用户继续在 `Default` 上工作，deputy 在 `deputy-<uuid>` 里干活，鼠标键盘焦点互不干扰。

**限制（必须知道）**：
- `SetThreadDesktop` 只能在线程**尚未创建任何窗口**时调用——所以实际做法是每个操作起一个干净
  worker 进程，而不是在主进程里反复切。
- 非活动桌面不能走 `Windows.Graphics.Capture`（WGC 需要目标桌面处于前台/可见状态），
  隔离桌面里只能用 `BitBlt`（`GetDC(0)` + `CreateCompatibleBitmap`）拿帧，代价是拿不到
  硬件加速界面、CPU 占用更高。
- 这是 deputy 0.1.0 选择 BitBlt 的原因，也是 `docs/SENSING.md` 里降采样到 320 宽的原因。

## 3. 为什么开这个功能要输密码（UAC）

不是豆包/插件要你的账号密码，而是 Windows 在拦以下几件事：

| 动作 | 为什么非要管理员 |
|---|---|
| `CreateDesktopW` 带 `GENERIC_ALL` | 普通令牌创建桌面会被拒（需要一整套桌面对象权限） |
| 安装/注册系统级组件（如文件微过滤驱动） | 驱动加载需要管理员 + 驱动签名 |
| 改系统级目录 ACL | `SetNamedSecurityInfo` 对系统对象要求 owner/管理员 |
| 处理隔离桌面里冒出来的 UAC 弹窗 | UAC 自己跑在 `Winlogon` 安全桌面，不提权会被卡住，任务看起来"卡死" |

密码只在本机做权限提升校验，不落盘、不上传——这一点和 `sudo` 一样，是操作系统的机制，
不是应用层的设计。

## 4. 进程级收束（比桌面隔离更细的一层）

桌面隔离只解决"看不见"，还要解决"乱写"：

- **受限令牌**（`CreateRestrictedToken`）：去掉 `SeDebugPrivilege`、`SeTakeOwnershipPrivilege` 等；
- **完整性级别**（MIC）：把沙箱进程压到中/低完整性，写不了高完整性对象；
- **Job Object**（`NtCreateJobObject`）：限内存、CPU、并发进程数，防止一个失控脚本拖垓机器；
- **缓解策略**（`SetProcessMitigationPolicy`）：DEP/ASLR/CFG 等。

## 5. 和 DSH 的"工作区沙箱"不是一回事

| | DSH 工作区沙箱 | deputy 隔离层 |
|---|---|---|
| 隔离对象 | 子进程的**文件写入** | **整个桌面 GUI 交互** |
| 层级 | 进程级权限裁剪（用户态） | 会话级对象隔离（内核 GUI 对象） |
| 维度 | 只限写文件 | 输入、窗口、剪贴板、文件、资源 |
| 提权 | 不需要 | 需要（UAC） |
| 干扰用户 | 共享主桌面，会弹窗抢焦点 | 独立桌面，完全不干扰 |

一句话：**一个是"别乱写文件"，一个是"别碰我的桌面"**。两者叠加才完整——deputy 的
`ISOLATE` 层里同时用了受限令牌（文件收束）和独立桌面（交互收束）。

## 6. 生命周期

```
create → launch(目标程序) → attach(worker) → 采帧/动作 → …
    → close：任务结束 CloseDesktop，进程结束，隔离桌面对象销毁
```

不做"常驻桌面池"：Windows 的桌面对象本身很轻，但常驻会让"任务间互相污染"成为可能，
宁可每次重开。
