# dsh-deputy · 虚拟桌面宿主（原型）
#
# 用法：powershell -File windows-desktop.ps1 -Op host -Name deputy-xxxx
#   该进程会创建独立 Desktop 并**常驻**，通过 stdin/stdout 收发"行分隔 JSON"：
#   请求 { id, op, ... }  回执 { id, ok, ... }
#   op: launch | capture | tree | input | uia | close
#
# 为什么必须常驻：桌面对象是引用计数的，创建者进程退出 → 桌面销毁。
# 所以「建桌面」和「后续所有操作」必须在同一个活着的进程里。
#
# 已知限制（真机回归时要逐条验）：
#  1) PowerShell 自身带隐藏控制台窗口，UIA 树里会出现宿主自己的节点；
#     生产版应换成编译好的 worker.exe（无窗口），这里用 pid 过滤兜底。
#  2) SetThreadDesktop 只能在该线程未创建窗口前调用；本进程在 create 之后立即切换。
#  3) 非活动桌面不能用 Windows.Graphics.Capture，只能用 BitBlt，硬件加速界面会拍成黑块。
#  4) 整个流程需要管理员（CreateDesktopW 用 GENERIC_ALL）。权限不足会直接报错，不静默降级。
#
# 三种模式（-Mode）：
#   isolated  独立 Win32 Desktop（CreateDesktopW）：窗口截图 + PostMessage，全黑问题与"点不动"的根源就在这里。
#   user      当前用户桌面：整屏截图 + SendInput，正常但它就是用户正在用的桌面。
#   virtual   任务视图虚拟桌面：用 Win+Ctrl+D 新建一块干净的虚拟桌面（壁纸/图标/任务栏都在、没有用户窗口），
#             整屏截图 + SendInput 都正常；关闭时 Win+Ctrl+F4 收掉并回到原桌面。豆包那种"独立的彩色桌面"就是这个。
#             Windows 没有公开的"创建虚拟桌面"API，只能合成快捷键，所以要求系统输入法/键盘没被拦截。

param(
    [Parameter(Mandatory = $true)][string]$Op,
    [string]$Name = 'deputy-default',
    [ValidateSet('isolated', 'user', 'virtual')][string]$Mode = 'isolated'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms

Add-Type -Language CSharp -ReferencedAssemblies 'System.Drawing', 'WindowsBase', 'UIAutomationClient', 'UIAutomationTypes' -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Deputy {

public class Desk2 {
    public static int CapWidth, CapHeight, CapX, CapY;
    public static string LaunchNote = "";

    // 关键：主线程（PowerShell 控制台）已经创建过窗口，SetThreadDesktop 会报 ERROR_BUSY(170)。
    // 所以在一条从未创建窗口的新线程上切桌面，再在该线程里做 GDI 捕获 / 注入输入。
    private static void OnDesktop(IntPtr desk, Action body) {
        // desk 为 0 = 用户桌面模式：当前线程本来就在输入桌面上，不需要（也不能）再切换。
        if (desk == IntPtr.Zero) { body(); return; }
        Exception err = null;
        Thread t = new Thread(delegate() {
            try {
                if (!SetThreadDesktop(desk)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
                body();
            } catch (Exception e) { err = e; }
        });
        t.IsBackground = true;
        t.SetApartmentState(ApartmentState.STA);
        t.Start();
        t.Join();
        if (err != null) throw err;
    }

    public static void Attach(IntPtr desk) {
        // 不切换 PowerShell 主线程：它可能已经有窗口，SetThreadDesktop 会 ERROR_BUSY。
        // 在一个干净 STA 线程里验证附着，后续 UIA 也走同样的 OnDesktop 路径。
        OnDesktop(desk, delegate() {
            if (GetThreadDesktop(GetCurrentThreadId()) != desk)
                throw new InvalidOperationException("线程未能附着到隔离桌面");
        });
    }

    public static void UiaOn(IntPtr desk, int[] path, string op, string text) {
        OnDesktop(desk, delegate() {
            System.Windows.Automation.AutomationElement el = System.Windows.Automation.AutomationElement.RootElement;
            var walker = System.Windows.Automation.TreeWalker.ControlViewWalker;
            if (path != null) {
                foreach (int idx in path) {
                    var child = walker.GetFirstChild(el);
                    for (int i = 0; i < idx && child != null; i++) child = walker.GetNextSibling(child);
                    if (child == null) throw new InvalidOperationException("UIA path 索引 " + idx + " 无子节点");
                    el = child;
                }
            }
            if (op == "invoke") {
                var pattern = el.GetCurrentPattern(System.Windows.Automation.InvokePattern.Pattern)
                    as System.Windows.Automation.InvokePattern;
                if (pattern == null) throw new InvalidOperationException("目标控件不支持 InvokePattern");
                pattern.Invoke();
            } else if (op == "setValue") {
                var pattern = el.GetCurrentPattern(System.Windows.Automation.ValuePattern.Pattern)
                    as System.Windows.Automation.ValuePattern;
                if (pattern == null) throw new InvalidOperationException("目标控件不支持 ValuePattern");
                pattern.SetValue(text ?? "");
            } else {
                throw new ArgumentException("不支持的 uia.op " + op);
            }
        });
    }

    public static byte[] Capture(IntPtr desk, int w, int h) {
        byte[] gray = null;
        OnDesktop(desk, delegate() {
            IntPtr screenDc = GetDC(IntPtr.Zero);
            IntPtr memDc = CreateCompatibleDC(screenDc);
            IntPtr bmp = CreateCompatibleBitmap(screenDc, w, h);
            IntPtr old = SelectObject(memDc, bmp);
            try {
                BitBlt(memDc, 0, 0, w, h, screenDc, 0, 0, SRCCOPY);
                using (var img = System.Drawing.Image.FromHbitmap(bmp)) {
                    using (var b = new System.Drawing.Bitmap(img)) {
                        var rect = new System.Drawing.Rectangle(0, 0, w, h);
                        var data = b.LockBits(rect, System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
                        try {
                            byte[] raw = new byte[data.Stride * h];
                            Marshal.Copy(data.Scan0, raw, 0, raw.Length);
                            gray = new byte[w * h];
                            for (int y = 0; y < h; y++) {
                                int row = y * data.Stride;
                                int o = y * w;
                                for (int x = 0; x < w; x++) {
                                    int i = row + x * 4;
                                    gray[o + x] = (byte)((raw[i + 2] * 77 + raw[i + 1] * 151 + raw[i] * 28) >> 8);
                                }
                            }
                        } finally { b.UnlockBits(data); }
                    }
                }
            } finally {
                SelectObject(memDc, old);
                DeleteObject(bmp);
                DeleteDC(memDc);
                ReleaseDC(IntPtr.Zero, screenDc);
            }
            CapWidth = w; CapHeight = h;
        });
        return gray;
    }

    // 面板要的是"用户看到的画面"：彩色 PNG 直接由宿主编码（灰度帧留给出 diff 的感知链路）。
    private static string ToPngBase64(System.Drawing.Bitmap b) {
        using (var ms = new System.IO.MemoryStream()) {
            b.Save(ms, System.Drawing.Imaging.ImageFormat.Png);
            return Convert.ToBase64String(ms.ToArray());
        }
    }

    private static string EncodePng(System.Drawing.Bitmap b, int maxW) {
        System.Drawing.Bitmap scaled = null;
        try {
            System.Drawing.Bitmap enc = b;
            if (maxW > 0 && b.Width > maxW) {
                int nh = (int)Math.Round(b.Height * (double)maxW / b.Width);
                if (nh < 1) nh = 1;
                scaled = new System.Drawing.Bitmap(b, maxW, nh);
                enc = scaled;
            }
            CapWidth = enc.Width; CapHeight = enc.Height;
            return ToPngBase64(enc);
        } finally {
            if (scaled != null) scaled.Dispose();
        }
    }

    public static string SnapshotScreen(IntPtr desk, int w, int h, int maxW) {
        string png = null;
        OnDesktop(desk, delegate() {
            IntPtr screenDc = GetDC(IntPtr.Zero);
            IntPtr memDc = CreateCompatibleDC(screenDc);
            IntPtr bmp = CreateCompatibleBitmap(screenDc, w, h);
            IntPtr old = SelectObject(memDc, bmp);
            try {
                BitBlt(memDc, 0, 0, w, h, screenDc, 0, 0, SRCCOPY);
                using (var img = System.Drawing.Image.FromHbitmap(bmp)) {
                    using (var b = new System.Drawing.Bitmap(img)) { png = EncodePng(b, maxW); }
                }
            } finally {
                SelectObject(memDc, old);
                DeleteObject(bmp);
                DeleteDC(memDc);
                ReleaseDC(IntPtr.Zero, screenDc);
            }
            CapX = 0; CapY = 0;
        });
        return png;
    }

    public static string SnapshotWindow(IntPtr desk, int wantPid, int excludePid, int maxW) {
        string png = null;
        OnDesktop(desk, delegate() {
            IntPtr target = PickWindow(wantPid, excludePid);
            if (target == IntPtr.Zero && wantPid != 0) target = PickWindow(0, excludePid);
            if (target == IntPtr.Zero) throw new InvalidOperationException("隔离桌面里没有可捕获的窗口");
            RECT wr; GetWindowRect(target, out wr);
            int w = wr.Right - wr.Left, h = wr.Bottom - wr.Top;
            if (w <= 0 || h <= 0) throw new InvalidOperationException("窗口尺寸非法");
            IntPtr screenDc = GetDC(IntPtr.Zero);
            IntPtr memDc = CreateCompatibleDC(screenDc);
            IntPtr bmp = CreateCompatibleBitmap(screenDc, w, h);
            IntPtr old = SelectObject(memDc, bmp);
            try {
                PrintWindow(target, memDc, 2);
                using (var img = System.Drawing.Image.FromHbitmap(bmp)) {
                    using (var b = new System.Drawing.Bitmap(img)) { png = EncodePng(b, maxW); }
                }
            } finally {
                SelectObject(memDc, old);
                DeleteObject(bmp);
                DeleteDC(memDc);
                ReleaseDC(IntPtr.Zero, screenDc);
            }
            CapX = wr.Left; CapY = wr.Top;
        });
        return png;
    }

    public static string[] Tree(IntPtr desk) {
        string[] rows = null;
        OnDesktop(desk, delegate() {
            var list = new System.Collections.Generic.List<string>();
            System.Windows.Automation.AutomationElement root = System.Windows.Automation.AutomationElement.RootElement;
            System.Windows.Automation.TreeWalker walker = System.Windows.Automation.TreeWalker.ControlViewWalker;
            System.Windows.Automation.AutomationElement child = walker.GetFirstChild(root);
            while (child != null) {
                var r = child.Current.BoundingRectangle;
                string nm = (child.Current.Name ?? "").Replace("\t", " ").Replace("\r", " ").Replace("\n", " ");
                list.Add(nm + "\t" + child.Current.ControlType.ProgrammaticName.Replace("ControlType.", "") + "\t" + child.Current.ProcessId + "\t" + (int)r.X + "," + (int)r.Y + "," + (int)r.Width + "," + (int)r.Height);
                child = walker.GetNextSibling(child);
            }
            rows = list.ToArray();
        });
        return rows;
    }

    [DllImport("user32.dll")] public static extern bool EnumDesktopWindows(IntPtr hdesk, EnumWindowsProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr l);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    private static byte[] ToGray(System.Drawing.Bitmap b, int w, int h) {
        var rect = new System.Drawing.Rectangle(0, 0, w, h);
        var data = b.LockBits(rect, System.Drawing.Imaging.ImageLockMode.ReadOnly, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        try {
            byte[] raw = new byte[data.Stride * h];
            Marshal.Copy(data.Scan0, raw, 0, raw.Length);
            byte[] gray = new byte[w * h];
            for (int y = 0; y < h; y++) {
                int row = y * data.Stride;
                int o = y * w;
                for (int x = 0; x < w; x++) {
                    int i = row + x * 4;
                    gray[o + x] = (byte)((raw[i + 2] * 77 + raw[i + 1] * 151 + raw[i] * 28) >> 8);
                }
            }
            return gray;
        } finally { b.UnlockBits(data); }
    }

    // 在该桌面里挑面积最大的可见窗口（wantPid!=0 时限定 pid；始终排除宿主自己的控制台窗口）。
    private static IntPtr PickWindow(int wantPid, int excludePid) {
        IntPtr target = IntPtr.Zero;
        long bestArea = 0;
        EnumWindows(delegate(IntPtr hwnd, IntPtr l) {
            if (!IsWindowVisible(hwnd) || IsIconic(hwnd)) return true;
            RECT r; if (!GetWindowRect(hwnd, out r)) return true;
            int aw = r.Right - r.Left, ah = r.Bottom - r.Top;
            if (aw < 80 || ah < 60) return true;
            uint pid; GetWindowThreadProcessId(hwnd, out pid);
            if (excludePid != 0 && (int)pid == excludePid) return true;
            if (wantPid != 0 && (int)pid != wantPid) return true;
            if ((long)aw * ah > bestArea) { bestArea = (long)aw * ah; target = hwnd; }
            return true;
        }, IntPtr.Zero);
        return target;
    }

    // 隔离桌面没有 DWM 合成，BitBlt 桌面会全黑；改成对该桌面上最大的可见窗口做 PrintWindow(PW_RENDERFULLCONTENT)。
    // excludePid：宿主自己的控制台窗口也是"可见窗口"，黑底窗口会被误当成目标画面，必须排除。
    // wantPid 找不到窗口时退回"该桌面任意窗口（仍排除宿主）"，避免刚 launch 完窗口还没建出来就报空。
    public static byte[] CaptureWindow(IntPtr desk, int wantPid, int excludePid) {
        byte[] gray = null;
        OnDesktop(desk, delegate() {
            IntPtr target = PickWindow(wantPid, excludePid);
            if (target == IntPtr.Zero && wantPid != 0) target = PickWindow(0, excludePid);
            if (target == IntPtr.Zero) throw new InvalidOperationException("隔离桌面里没有可捕获的窗口");
            RECT wr; GetWindowRect(target, out wr);
            int w = wr.Right - wr.Left, h = wr.Bottom - wr.Top;
            if (w <= 0 || h <= 0) throw new InvalidOperationException("窗口尺寸非法");
            IntPtr screenDc = GetDC(IntPtr.Zero);
            IntPtr memDc = CreateCompatibleDC(screenDc);
            IntPtr bmp = CreateCompatibleBitmap(screenDc, w, h);
            IntPtr old = SelectObject(memDc, bmp);
            try {
                PrintWindow(target, memDc, 2);
                using (var img = System.Drawing.Image.FromHbitmap(bmp)) {
                    using (var b = new System.Drawing.Bitmap(img)) { gray = ToGray(b, w, h); }
                }
            } finally {
                SelectObject(memDc, old);
                DeleteObject(bmp);
                DeleteDC(memDc);
                ReleaseDC(IntPtr.Zero, screenDc);
            }
            CapWidth = w; CapHeight = h; CapX = wr.Left; CapY = wr.Top;
        });
        return gray;
    }

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool GetUserObjectInformationW(IntPtr hObj, int index, StringBuilder info, int len, out int needed);

    public static string Debug(IntPtr desk) {
        string report = "";
        OnDesktop(desk, delegate() {
            var sb = new StringBuilder(512);
            int need;
            GetUserObjectInformationW(GetThreadDesktop(GetCurrentThreadId()), 2, sb, 1024, out need);
            int n = 0;
            bool ew = EnumWindows(delegate(IntPtr h, IntPtr l) { n++; return true; }, IntPtr.Zero);
            int ewErr = Marshal.GetLastWin32Error();
            int uia = 0;
            System.Windows.Automation.AutomationElement root = System.Windows.Automation.AutomationElement.RootElement;
            System.Windows.Automation.TreeWalker walker = System.Windows.Automation.TreeWalker.ControlViewWalker;
            System.Windows.Automation.AutomationElement c = walker.GetFirstChild(root);
            while (c != null && uia < 100) { uia++; c = walker.GetNextSibling(c); }
            report = "tid=" + GetCurrentThreadId() + " desk=" + sb.ToString() + " thDesk=" + GetThreadDesktop(GetCurrentThreadId()).ToString()
                + " given=" + desk.ToString() + " enum=" + n + " ew=" + (ew ? 1 : 0) + " err=" + ewErr + " uia=" + uia;
        });
        return report;
    }

    // ---- 用户桌面模式：整屏截图 + SendInput ----
    // 用户桌面（输入桌面）由 DWM 合成，整屏 BitBlt 就是用户看到的画面；
    // 输入必须走 SendInput：PostMessage 投给 Chromium 这类自绘输入的窗口会被丢弃。
    // 进程必须声明 DPI 感知：否则 GetSystemMetrics 返回的是被 150% 缩放后的 1280x720，
    // 截图形状和点击坐标都会跟真实屏幕对不上。
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    public static bool MakeDpiAware() { return SetProcessDPIAware(); }
    public static int ScreenWidth() { return GetSystemMetrics(0); }
    public static int ScreenHeight() { return GetSystemMetrics(1); }

    private static INPUT MouseInput(int flag) {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.mi.dwFlags = flag;
        return input;
    }

    private static INPUT UnicodeInput(char ch, bool up) {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.ki.wVk = 0;
        input.ki.wScan = (short)ch;
        input.ki.dwFlags = KEYEVENTF_UNICODE | (up ? KEYEVENTF_KEYUP : 0);
        return input;
    }

    public static void ClickUser(int x, int y, bool right, int clicks) {
        OnDesktop(IntPtr.Zero, delegate() {
            POINT p = new POINT(); p.X = x; p.Y = y;
            IntPtr target = WindowFromPoint(p);
            // 先把这个窗口提到前台，否则点击会落在用户当前的活动窗口上。
            if (target != IntPtr.Zero) { SetForegroundWindow(target); Thread.Sleep(80); }
            if (!SetCursorPos(x, y)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            Thread.Sleep(30);
            int count = Math.Max(1, Math.Min(3, clicks));
            for (int i = 0; i < count; i++) {
                SendChecked(new INPUT[] { MouseInput(right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN) });
                Thread.Sleep(30);
                SendChecked(new INPUT[] { MouseInput(right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP) });
                Thread.Sleep(80);
            }
            LastInputWindow = target;
        });
    }

    public static void TypeUser(string text) {
        OnDesktop(IntPtr.Zero, delegate() {
            foreach (char ch in text ?? "") {
                SendChecked(new INPUT[] { UnicodeInput(ch, false) });
                SendChecked(new INPUT[] { UnicodeInput(ch, true) });
                Thread.Sleep(8);
            }
        });
    }

    public static void KeyUser(string combo) {
        OnDesktop(IntPtr.Zero, delegate() {
            string[] parts = (combo ?? "").Split('+');
            var keys = new System.Collections.Generic.List<ushort>();
            foreach (string part in parts) keys.Add(KeyCode(part));
            foreach (ushort key in keys) SendChecked(new INPUT[] { KeyInput(key, false) });
            for (int i = keys.Count - 1; i >= 0; i--) SendChecked(new INPUT[] { KeyInput(keys[i], true) });
        });
    }

    public static int LaunchUser(string exe, string args) {
        // lpDesktop 传 null = 继承调用方所在桌面（用户桌面）。
        return Launch(exe, args, null);
    }

    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hwnd, bool altTab);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint attach, uint attachTo, bool doAttach);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder s, int n);

    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);

    // 刚启动的程序常常被压在别的窗口后面。Windows 的前台锁不允许后台进程抢焦点，
    // 但允许把窗口抬到 z-order 顶部（不激活）：从截图里看到它在前，点它时鼠标消息
    // 会落到它身上，点击本身就把焦点交给它了。
    public static bool RaiseProcessWindow(int pid, int timeoutMs) {
        IntPtr found = IntPtr.Zero;
        int waited = 0;
        while (waited < timeoutMs) {
            IntPtr hit = IntPtr.Zero;
            EnumWindows(delegate(IntPtr h, IntPtr l) {
                uint wp; GetWindowThreadProcessId(h, out wp);
                if ((int)wp == pid && IsWindowVisible(h) && !IsIconic(h)) {
                    var sb = new StringBuilder(256);
                    GetWindowTextW(h, sb, 256);
                    if (sb.Length > 0) { hit = h; return false; }
                }
                return true;
            }, IntPtr.Zero);
            if (hit != IntPtr.Zero) { found = hit; break; }
            Thread.Sleep(120);
            waited += 120;
        }
        if (found == IntPtr.Zero) return false;
        ShowWindow(found, 9); // SW_RESTORE
        // HWND_TOPMOST(-1) 后立刻 HWND_NOTOPMOST(-2)：只抬 z-order，不激活、不置顶
        const uint noMove = 0x0002, noSize = 0x0001, noActivate = 0x0010;
        SetWindowPos(found, new IntPtr(-1), 0, 0, 0, 0, noMove | noSize | noActivate);
        SetWindowPos(found, new IntPtr(-2), 0, 0, 0, 0, noMove | noSize | noActivate);
        BringWindowToTop(found);
        Thread.Sleep(180);
        return true;
    }

    // ---- 虚拟桌面模式（任务视图）：Win+Ctrl+D 新建、Win+Ctrl+F4 关闭、注册表读当前 GUID ----
    // Windows 没有公开的"创建虚拟桌面"API（IVirtualDesktop* 是未公开 COM，且随版本变化），
    // 所以只能合成快捷键；GUID 则从注册表读，用来确认"确实切到了新桌面"和"确实回到了原桌面"。
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);

    public static void WinCtrlCombo(byte vk) {
        const byte LWIN = 0x5B, LCTRL = 0x11;
        const uint UP = 0x0002;
        keybd_event(LWIN, 0, 0, IntPtr.Zero);
        keybd_event(LCTRL, 0, 0, IntPtr.Zero);
        Thread.Sleep(40);
        keybd_event(vk, 0, 0, IntPtr.Zero);
        Thread.Sleep(40);
        keybd_event(vk, 0, UP, IntPtr.Zero);
        keybd_event(LCTRL, 0, UP, IntPtr.Zero);
        keybd_event(LWIN, 0, UP, IntPtr.Zero);
        Thread.Sleep(60);
    }

    private static byte[] VdValue(string name) {
        using (var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops")) {
            if (key == null) return null;
            return key.GetValue(name) as byte[];
        }
    }

    public static Guid CurrentDesktopGuid() {
        byte[] raw = VdValue("CurrentVirtualDesktop");
        if (raw == null || raw.Length < 16) return Guid.Empty;
        return new Guid(raw);
    }

    public static int DesktopCount() {
        byte[] raw = VdValue("VirtualDesktopIDs");
        if (raw == null) return 0;
        return raw.Length / 16;
    }

    public static bool OnTempDesktop(Guid temp) {
        Guid cur = CurrentDesktopGuid();
        return temp != Guid.Empty && cur == temp;
    }

    public static void ClickOn(IntPtr desk, int x, int y, bool right, int clicks) { OnDesktop(desk, delegate() { Click(x, y, right, clicks); }); }
    public static void TypeOn(IntPtr desk, string text) { OnDesktop(desk, delegate() { TypeText(text); }); }
    public static void KeyOn(IntPtr desk, string combo) { OnDesktop(desk, delegate() { KeyCombo(combo); }); }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO {
        public int cbSize, flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy, mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public short wVk, wScan; public int dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public int uMsg; public short wParamL, wParamH; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT { [FieldOffset(0)] public int type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; [FieldOffset(8)] public HARDWAREINPUT hi; }

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateDesktopW(string name, string device, IntPtr devmode, int flags, int access, IntPtr lpsa);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr h);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(int threadId);
    [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int cbSize);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);
    public static IntPtr LastInputWindow = IntPtr.Zero;
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int cx, int cy, IntPtr src, int sx, int sy, int rop);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit,
        int flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);

    public const int GENERIC_ALL = 0x10000000;
    public const int CREATE_NEW_CONSOLE = 0x00000010;
    public const int SRCCOPY = 0x00CC0020;
    public const int INPUT_MOUSE = 0;
    public const int INPUT_KEYBOARD = 1;
    public const int MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const int MOUSEEVENTF_LEFTUP = 0x0004;
    public const int MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const int MOUSEEVENTF_RIGHTUP = 0x0010;
    public const int KEYEVENTF_KEYUP = 0x0002;
    public const int KEYEVENTF_UNICODE = 0x0004;

    public static IntPtr Create(string name) {
        IntPtr h = CreateDesktopW(name, null, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        if (h == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return h;
    }

    public static int Launch(string exe, string args, string desktop) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = desktop;
        PROCESS_INFORMATION pi;
        if (!CreateProcessW(exe, "\"" + exe + "\" " + args, IntPtr.Zero, IntPtr.Zero, false,
            CREATE_NEW_CONSOLE, IntPtr.Zero, null, ref si, out pi))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try {
            return pi.dwProcessId;
        } finally {
            // CreateProcessW 的进程/线程句柄都由调用者所有；只保留 pid 时必须立即关闭。
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
        }
    }

    private static void SendChecked(INPUT[] inputs) {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != (uint)inputs.Length)
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),
                "SendInput 只接受了 " + sent + "/" + inputs.Length + " 个输入事件");
    }

    // 隔离桌面不是"输入桌面"，SendInput 注入的事件会落到用户主桌面（实测 0/N 被接受），
    // 所以点击/输入一律用 PostMessage 直接投递给隔离桌面里的目标窗口。
    public static void Click(int x, int y, bool right, int clicks) {
        POINT screen = new POINT(); screen.X = x; screen.Y = y;
        IntPtr target = WindowFromPoint(screen);
        if (target == IntPtr.Zero) throw new InvalidOperationException("该坐标上没有窗口可点击");
        POINT client = screen;
        if (!ScreenToClient(target, ref client))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        LastInputWindow = target;
        uint down = right ? 0x0204u : 0x0201u;
        uint up = right ? 0x0205u : 0x0202u;
        IntPtr lp = (IntPtr)((client.Y << 16) | (client.X & 0xFFFF));
        int count = Math.Max(1, Math.Min(3, clicks));
        for (int i = 0; i < count; i++) {
            PostMessage(target, 0x0200u, IntPtr.Zero, lp);
            PostMessage(target, down, (IntPtr)(right ? 2 : 1), lp);
            PostMessage(target, up, IntPtr.Zero, lp);
            System.Threading.Thread.Sleep(40);
        }
    }

    private static IntPtr FocusWindow() {
        IntPtr target = LastInputWindow;
        if (target == IntPtr.Zero) throw new InvalidOperationException("还没有点过任何窗口，先 click 再 type");
        uint pid;
        uint tid = GetWindowThreadProcessId(target, out pid);
        GUITHREADINFO gi = new GUITHREADINFO();
        gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
        if (GetGUIThreadInfo(tid, ref gi) && gi.hwndFocus != IntPtr.Zero) return gi.hwndFocus;
        return target;
    }

    private static INPUT KeyInput(ushort vk, bool up) {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.ki.wVk = (short)vk;
        input.ki.dwFlags = up ? KEYEVENTF_KEYUP : 0;
        return input;
    }

    private static ushort KeyCode(string value) {
        string key = (value ?? "").Trim();
        switch (key.ToLowerInvariant()) {
            case "ctrl": case "control": return 0x11;
            case "alt": return 0x12;
            case "shift": return 0x10;
            case "win": case "lwin": return 0x5B;
            case "rwin": return 0x5C;
            case "enter": case "return": return 0x0D;
            case "esc": case "escape": return 0x1B;
            case "tab": return 0x09;
            case "space": return 0x20;
            case "backspace": return 0x08;
            case "delete": case "del": return 0x2E;
            case "insert": case "ins": return 0x2D;
            case "home": return 0x24;
            case "end": return 0x23;
            case "pageup": return 0x21;
            case "pagedown": return 0x22;
            case "left": return 0x25;
            case "up": return 0x26;
            case "right": return 0x27;
            case "down": return 0x28;
        }
        if (key.Length == 1) return (ushort)char.ToUpperInvariant(key[0]);
        int fn;
        if (key.Length > 1 && key[0] == 'F' && int.TryParse(key.Substring(1), out fn) && fn >= 1 && fn <= 24)
            return (ushort)(0x70 + fn - 1);
        throw new ArgumentException("不支持的按键 " + value);
    }

    public static void KeyCombo(string combo) {
        string[] parts = (combo ?? "").Split('+');
        if (parts.Length == 0 || (parts.Length == 1 && parts[0].Trim().Length == 0))
            throw new ArgumentException("组合键不能为空");
        var keys = new System.Collections.Generic.List<ushort>();
        foreach (string part in parts) keys.Add(KeyCode(part));
        IntPtr focus = FocusWindow();
        // 同样用 PostMessage；注意 GetKeyState 型快捷键（部分浏览器）可能不认投递的修饰键。
        foreach (ushort key in keys) PostMessage(focus, 0x0100u, (IntPtr)key, (IntPtr)1);
        for (int i = keys.Count - 1; i >= 0; i--) PostMessage(focus, 0x0101u, (IntPtr)keys[i], (IntPtr)(1 | (1 << 30) | (1 << 31)));
    }

    public static void TypeText(string text) {
        IntPtr focus = FocusWindow();
        foreach (char ch in text ?? "") {
            PostMessage(focus, 0x0102u, (IntPtr)ch, (IntPtr)1);   // WM_CHAR
            System.Threading.Thread.Sleep(5);
        }
    }
}
}
'@

function Reply($obj) {
    $script:out.WriteLine(($obj | ConvertTo-Json -Depth 10 -Compress))
    $script:out.Flush()
}

if ($Op -ne 'host') {
    # 兼容旧用法：一次性 create/launch/close（不推荐，桌面会随进程退出销毁）
    @{ ok = $false; error = '本脚本已改为常驻宿主模式，请用 -Op host' } | ConvertTo-Json -Compress
    exit 2
}

try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
# 必须在任何 DC/窗口被创建之前声明 DPI 感知，否则整屏尺寸与坐标都是缩放后的虚拟值。
try { [Deputy.Desk2]::MakeDpiAware() | Out-Null } catch { }
$script:out = [Console]::Out
$handle = $null
$launched = @()
$isUser = ($Mode -eq 'user')
$isVirtual = ($Mode -eq 'virtual')
$script:vdOrig = [Guid]::Empty
$script:vdTemp = [Guid]::Empty
$script:vdCount = 0
$vdLaunched = @()

function NewVirtualDesktop {
    # 记录当前桌面 → Win+Ctrl+D → 读回新桌面 GUID，确认真的建出来了。
    $script:vdOrig = [Deputy.Desk2]::CurrentDesktopGuid()
    $before = [Deputy.Desk2]::DesktopCount()
    [Deputy.Desk2]::WinCtrlCombo(0x44)   # Win+Ctrl+D 新建虚拟桌面
    Start-Sleep -Milliseconds 1800
    $script:vdTemp = [Deputy.Desk2]::CurrentDesktopGuid()
    $script:vdCount = [Deputy.Desk2]::DesktopCount()
    if ($script:vdCount -le $before -or $script:vdTemp -eq $script:vdOrig) {
        throw '没能新建虚拟桌面（Win+Ctrl+D 未生效），检查是否被输入法或安全软件拦截'
    }
    return $script:vdTemp
}

function CloseVirtualDesktop {
    # 关键顺序：必须**停在临时桌面上**直接 F4。
    # 先切回原桌面再 F4，删掉的是用户自己的桌面（实测发生过）。
    if ($script:vdTemp -eq [Guid]::Empty) { return $true }
    if ([Deputy.Desk2]::OnTempDesktop($script:vdTemp)) {
        [Deputy.Desk2]::WinCtrlCombo(0x73)   # Win+Ctrl+F4 关闭当前虚拟桌面
        Start-Sleep -Milliseconds 1600
    }
    return (-not [Deputy.Desk2]::OnTempDesktop($script:vdTemp))
}

function Get-StartApps {
    # 枚举开始菜单里的启动项（用户级 + 全局），也就是"系统告诉我有这些应用"。
    # 启动只认精确名称：不允许随手塞 exe/URI，避免"看着要开 A、实际开了 B"。
    $roots = @(
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
        (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs')
    )
    $seen = @{}
    $list = New-Object System.Collections.ArrayList
    foreach ($root in $roots) {
        if (-not (Test-Path $root)) { continue }
        $src = 'user'
        if ($root -like '*ProgramData*') { $src = 'machine' }
        Get-ChildItem -Path $root -Recurse -Include '*.lnk', '*.url' -ErrorAction SilentlyContinue | ForEach-Object {
            $key = $_.BaseName.ToLowerInvariant()
            if ($seen.ContainsKey($key)) { return }
            $seen[$key] = $true
            [void]$list.Add([pscustomobject]@{ name = $_.BaseName; path = $_.FullName; source = $src })
        }
    }
    # 打包应用（UWP/Store，例如 Win11 记事本、计算器）没有 .lnk，只在 shell:AppsFolder 里。
    try {
        $shell = New-Object -ComObject Shell.Application
        $folder = $shell.Namespace('shell:AppsFolder')
        if ($folder) {
            foreach ($item in @($folder.Items())) {
                $appName = [string]$item.Name
                $appId = [string]$item.Path
                if (-not $appName -or -not $appId) { continue }
                $key = $appName.ToLowerInvariant()
                if ($seen.ContainsKey($key)) { continue }
                $seen[$key] = $true
                [void]$list.Add([pscustomobject]@{ name = $appName; path = $appId; source = 'apps' })
            }
        }
    } catch { }
    return @($list | Sort-Object name)
}

try {
    if ($isUser) {
        # 用户桌面模式：不建新桌面，直接操作当前输入桌面（豆包 / UI-TARS 那种做法）。
        # 好处：DWM 合成 → 整屏截图正常；输入桌面 → SendInput 生效。
        # 代价：没有隔离，点击和打字会真的动用户的鼠标键盘。
        $handle = [IntPtr]::Zero
        $attached = $true
        $attachErr = 0
        Reply @{ id = 0; ok = $true; desktop = 'user'; mode = 'user'; attached = $true; attachErr = 0; pid = $PID }
    } elseif ($isVirtual) {
        # virtual 模式：任务视图里新建一块干净的虚拟桌面（彩色、完整，只有壁纸图标和任务栏），
        # 整屏截图和 SendInput 都正常，而且不动用户原来那个桌面上的窗口。
        $handle = [IntPtr]::Zero
        NewVirtualDesktop | Out-Null
        $attached = $true
        $attachErr = 0
        Reply @{ id = 0; ok = $true; desktop = 'virtual'; mode = 'virtual'; attached = $true; attachErr = 0; orig = $script:vdOrig.ToString(); temp = $script:vdTemp.ToString(); count = $script:vdCount; pid = $PID }
    } else {
        $handle = [Deputy.Desk2]::Create($Name)
        # 在干净 STA 线程里验证附着；失败必须终止，绝不能让 UIA 静默落到主桌面。
        [Deputy.Desk2]::Attach($handle)
        $attached = $true
        $attachErr = 0
        Reply @{ id = 0; ok = $true; desktop = $Name; mode = 'isolated'; attached = $attached; attachErr = $attachErr; pid = $PID }
    }
}
catch {
    Reply @{ id = 0; ok = $false; error = $_.Exception.Message; code = 'ECREATE' }
    exit 1
}

try {
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        $req = $line | ConvertFrom-Json
        try {
            switch ($req.op) {
                'create' {
                    # 桌面在进程启动时已建好，这里只做幂等确认，兼容传输层的 create 握手。
                    Reply @{ id = $req.id; ok = $true; desktop = $Name; mode = $Mode; attached = $attached; pid = $PID }
                }
                'launch' {
                    if ($isUser -or $isVirtual) {
                        $pidOn = [Deputy.Desk2]::LaunchUser($req.exe, [string]$req.args)
                        # 新窗口可能起在已有窗口后面：抢到前台，后续点击/打字才不会落到别人的窗口上。
                        $focused = [Deputy.Desk2]::RaiseProcessWindow($pidOn, 2500)
                        if (-not $focused) {
                            # 单实例程序（Win11 记事本等）会把窗口交给已有进程，启动的 pid 随即退出。
                            $exeName = [System.IO.Path]::GetFileNameWithoutExtension([string]$req.exe)
                            foreach ($proc in @(Get-Process -Name $exeName -ErrorAction SilentlyContinue)) {
                                if ($proc.MainWindowHandle -ne 0) {
                                    $focused = [Deputy.Desk2]::RaiseProcessWindow($proc.Id, 1500)
                                    if ($focused) { break }
                                }
                            }
                        }
                    } else {
                        $pidOn = [Deputy.Desk2]::Launch($req.exe, [string]$req.args, $Name)
                    }
                    # 用户桌面模式不登记 pid：finally 里绝不许杀掉用户自己的进程。
                    if ($isVirtual) { $vdLaunched += $pidOn }
                    elseif (-not $isUser) { $launched += $pidOn }
                    $resp = @{ id = $req.id; ok = $true; pid = $pidOn; mode = $Mode }
                    if ($isUser -or $isVirtual) { $resp.focused = $focused }
                    Reply $resp
                }
                'capture' {
                    if ($isUser -or $isVirtual) {
                        # 用户桌面有 DWM 合成，整屏 BitBlt 就是用户看到的画面（含任务栏与所有窗口）。
                        $sw = [Deputy.Desk2]::ScreenWidth()
                        $sh = [Deputy.Desk2]::ScreenHeight()
                        if ($sw -le 0 -or $sh -le 0) { throw '取不到屏幕尺寸' }
                        $bytes = [Deputy.Desk2]::Capture([IntPtr]::Zero, $sw, $sh)
                        Reply @{ id = $req.id; ok = $true; width = $sw; height = $sh; originX = 0; originY = 0; source = 'screen'; pid = 0; grayBase64 = [Convert]::ToBase64String($bytes) }
                        continue
                    }
                    # 隔离桌面没有 DWM 合成，整桌面 BitBlt 全黑；只抓窗口（PrintWindow），并且排除宿主自己的控制台。
                    $targetPid = 0
                    if ($launched.Count -gt 0) { $targetPid = [int]$launched[$launched.Count - 1] }
                    try {
                        $bytes = [Deputy.Desk2]::CaptureWindow($handle, $targetPid, $PID)
                        $w = [Deputy.Desk2]::CapWidth
                        $h = [Deputy.Desk2]::CapHeight
                        Reply @{ id = $req.id; ok = $true; width = $w; height = $h; originX = [Deputy.Desk2]::CapX; originY = [Deputy.Desk2]::CapY; source = 'window'; pid = $targetPid; grayBase64 = [Convert]::ToBase64String($bytes) }
                    } catch {
                        # 没有窗口就明确说没有：绝不回退到必然全黑的桌面 BitBlt（那正是侧栏页一片黑的成因）。
                        Reply @{ id = $req.id; ok = $false; code = 'NOWINDOW'; error = '隔离桌面里还没有可捕获的窗口，先启动一个程序'; state = $Name }
                    }
                }
                'snapshot' {
                    # 彩色整屏/整窗 PNG（宿主侧编码）。灰度 'capture' 仍给感知链路用。
                    # maxWidth 让宿主先等比缩小再编码（面板用不着 1:1，PNG 体积能砍一半以上）；
                    # frameWidth/frameHeight 回原始像素尺寸，点击坐标仍按真实屏幕换算。
                    $maxW = 0
                    if ($req.maxWidth) { $maxW = [int]$req.maxWidth }
                    if ($req.target -eq 'window' -and -not $isUser -and -not $isVirtual) {
                        $targetPid = 0
                        if ($launched.Count -gt 0) { $targetPid = [int]$launched[$launched.Count - 1] }
                        try {
                            $png = [Deputy.Desk2]::SnapshotWindow($handle, $targetPid, $PID, $maxW)
                            $w = [Deputy.Desk2]::CapWidth
                            $h = [Deputy.Desk2]::CapHeight
                            Reply @{ id = $req.id; ok = $true; width = $w; height = $h; frameWidth = $w; frameHeight = $h; originX = [Deputy.Desk2]::CapX; originY = [Deputy.Desk2]::CapY; source = 'window'; pngBase64 = $png }
                        } catch {
                            Reply @{ id = $req.id; ok = $false; code = 'NOWINDOW'; error = '隔离桌面里还没有可捕获的窗口，先启动一个程序'; state = $Name }
                        }
                        continue
                    }
                    $sw = [Deputy.Desk2]::ScreenWidth()
                    $sh = [Deputy.Desk2]::ScreenHeight()
                    if ($sw -le 0 -or $sh -le 0) { throw '取不到屏幕尺寸' }
                    $png = [Deputy.Desk2]::SnapshotScreen($handle, $sw, $sh, $maxW)
                    $w = [Deputy.Desk2]::CapWidth
                    $h = [Deputy.Desk2]::CapHeight
                    Reply @{ id = $req.id; ok = $true; width = $w; height = $h; frameWidth = $sw; frameHeight = $sh; originX = 0; originY = 0; source = 'screen'; pngBase64 = $png }
                }
                'apps' {
                    $all = @(Get-StartApps)
                    Reply @{ id = $req.id; ok = $true; count = $all.Count; apps = $all }
                }
                'launch-app' {
                    $want = [string]$req.name
                    if (-not $want) { throw 'launch-app 需要 name（开始菜单里的精确名称）' }
                    $all = @(Get-StartApps)
                    $hit = $all | Where-Object { $_.name -eq $want } | Select-Object -First 1
                    if (-not $hit) {
                        $near = @($all | Where-Object { $_.name -like "*$want*" } | Select-Object -First 8 -ExpandProperty name)
                        Reply @{ id = $req.id; ok = $false; code = 'APP_NOT_FOUND'; error = "开始菜单里没有精确名为 $want 的应用（只能按精确名称启动）"; candidates = $near }
                        continue
                    }
                    if ($hit.source -eq 'apps') {
                        # 打包应用只能通过 shell:AppsFolder\<AppID> 起（不是普通 exe）。
                        $explorer = Join-Path $env:WINDIR 'explorer.exe'
                        $sheet = 'shell:AppsFolder\' + $hit.path
                        if ($isUser -or $isVirtual) {
                            $pidOn = [Deputy.Desk2]::LaunchUser($explorer, $sheet)
                        } else {
                            $pidOn = [Deputy.Desk2]::Launch($explorer, $sheet, $Name)
                        }
                        if ($isVirtual) { $vdLaunched += $pidOn }
                        elseif (-not $isUser) { $launched += $pidOn }
                        Reply @{ id = $req.id; ok = $true; name = $hit.name; target = $sheet; pid = $pidOn; mode = $Mode; packaged = $true }
                        continue
                    }
                    if ($hit.path -like '*.url') {
                        Reply @{ id = $req.id; ok = $false; code = 'APP_NOT_LAUNCHABLE'; error = "$($hit.name) 是网址快捷方式，不能当程序启动" }
                        continue
                    }
                    $target = $hit.path
                    $appArgs = ''
                    try {
                        $ws = New-Object -ComObject WScript.Shell
                        $sc = $ws.CreateShortcut($hit.path)
                        if ($sc.TargetPath) { $target = $sc.TargetPath }
                        if ($sc.Arguments) { $appArgs = [string]$sc.Arguments }
                    } catch { }
                    if (-not (Test-Path $target)) {
                        Reply @{ id = $req.id; ok = $false; code = 'APP_TARGET_MISSING'; error = "$($hit.name) 指向的 $target 不存在" }
                        continue
                    }
                    $focused = $false
                    if ($isUser -or $isVirtual) {
                        $pidOn = [Deputy.Desk2]::LaunchUser($target, $appArgs)
                        $focused = [Deputy.Desk2]::RaiseProcessWindow($pidOn, 2500)
                    } else {
                        $pidOn = [Deputy.Desk2]::Launch($target, $appArgs, $Name)
                    }
                    # 启动"已受理但还没窗口"是正常现象：只回执，不许让调用方马上再点一次（会开出两个实例）。
                    if ($isVirtual) { $vdLaunched += $pidOn }
                    elseif (-not $isUser) { $launched += $pidOn }
                    $resp = @{ id = $req.id; ok = $true; name = $hit.name; target = $target; pid = $pidOn; mode = $Mode }
                    if ($isUser -or $isVirtual) { $resp.focused = $focused }
                    Reply $resp
                }
                'vdesk-status' {
                    Reply @{ id = $req.id; ok = $true; mode = $Mode; active = [Deputy.Desk2]::OnTempDesktop($script:vdTemp); current = [Deputy.Desk2]::CurrentDesktopGuid().ToString(); orig = $script:vdOrig.ToString(); temp = $script:vdTemp.ToString(); count = [Deputy.Desk2]::DesktopCount() }
                }
                'debug' {
                    Reply @{ id = $req.id; ok = $true; info = [Deputy.Desk2]::Debug($handle) }
                }
                'tree' {
                    $rows = [Deputy.Desk2]::Tree($handle)
                    $items = @()
                    foreach ($row in $rows) {
                        $p = $row -split "`t"
                        $rect = $p[3] -split ','
                        $items += @{
                            name = $p[0]
                            type = $p[1]
                            pid  = [int]$p[2]
                            rect = @{ x = [int]$rect[0]; y = [int]$rect[1]; w = [int]$rect[2]; h = [int]$rect[3] }
                        }
                    }
                    Reply @{ id = $req.id; ok = $true; desktop = $Name; windows = $items }
                }
                'input' {
                    $in = $req.input
                    $clicks = 1
                    if ($null -ne $in.clicks) { $clicks = [Math]::Max(1, [Math]::Min(3, [int]$in.clicks)) }
                    # virtual 只能用 SendInput，前提是当前活动桌面确实是我们的临时桌面；
                    # 用户中途切走了就明确拒绝，绝不把点击和字符打到别人桌面上。
                    if ($isVirtual -and -not [Deputy.Desk2]::OnTempDesktop($script:vdTemp)) {
                        Reply @{ id = $req.id; ok = $false; code = 'VDESK_NOT_ACTIVE'; error = '当前不在 deputy 的虚拟桌面上（用户切换了桌面），先切回来再操作' }
                        continue
                    }
                    $onRealDesktop = ($isUser -or $isVirtual)
                    if ($in.op -eq 'click') {
                        if ($onRealDesktop) { [Deputy.Desk2]::ClickUser([int]$in.x, [int]$in.y, ($in.button -eq 'right'), $clicks) }
                        else { [Deputy.Desk2]::ClickOn($handle, [int]$in.x, [int]$in.y, ($in.button -eq 'right'), $clicks) }
                    }
                    elseif ($in.op -eq 'type') {
                        if ($onRealDesktop) { [Deputy.Desk2]::TypeUser([string]$in.text) }
                        else { [Deputy.Desk2]::TypeOn($handle, [string]$in.text) }
                    }
                    elseif ($in.op -eq 'key') {
                        if ($onRealDesktop) { [Deputy.Desk2]::KeyUser([string]$in.combo) }
                        else { [Deputy.Desk2]::KeyOn($handle, [string]$in.combo) }
                    }
                    else { throw "不支持的 input.op $($in.op)" }
                    Reply @{ id = $req.id; ok = $true; mode = $Mode }
                }
                'uia' {
                    # UIA 必须在附着到隔离桌面的干净 STA 线程里执行，不能使用 PowerShell 主线程。
                    [Deputy.Desk2]::UiaOn($handle, [int[]]$req.payload.ref.path, [string]$req.payload.op, [string]$req.payload.text)
                    Reply @{ id = $req.id; ok = $true }
                }
                'close' {
                    $restored = $true
                    if ($isVirtual) {
                        # 先杀掉自己在这块桌面上起的进程（只杀自己 launch 的），再收掉临时桌面。
                        foreach ($p in $vdLaunched) { try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch { } }
                        $vdLaunched = @()
                        $restored = CloseVirtualDesktop
                    }
                    Reply @{ id = $req.id; ok = $true; desktop = 'closed'; mode = $Mode; restored = $restored }
                    break
                }
                default { throw "未知 op $($req.op)" }
            }
        }
        catch {
            Reply @{ id = $req.id; ok = $false; error = $_.Exception.Message }
        }
    }
}
finally {
    # 用户桌面模式下 $launched 为空，且绝不能去 CloseDesktop(0)。
    foreach ($p in $launched) { try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch { } }
    # virtual 兜底：宿主异常退出也要把临时桌面收掉，别把用户丢在一块空桌面上。
    if ($isVirtual) {
        foreach ($p in $vdLaunched) { try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch { } }
        try { CloseVirtualDesktop | Out-Null } catch { }
    }
    if (-not $isUser -and -not $isVirtual -and $handle) { [Deputy.Desk2]::CloseDesktop($handle) | Out-Null }
}
