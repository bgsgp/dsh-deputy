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

param(
    [Parameter(Mandatory = $true)][string]$Op,
    [string]$Name = 'deputy-default'
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

    public static void Click(int x, int y, bool right, int clicks) {
        if (!SetCursorPos(x, y)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        var events = new System.Collections.Generic.List<INPUT>();
        int count = Math.Max(1, Math.Min(3, clicks));
        for (int i = 0; i < count; i++) {
            INPUT down = new INPUT();
            down.type = INPUT_MOUSE;
            down.mi.dwFlags = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
            INPUT up = new INPUT();
            up.type = INPUT_MOUSE;
            up.mi.dwFlags = right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
            events.Add(down); events.Add(up);
        }
        SendChecked(events.ToArray());
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
        var events = new System.Collections.Generic.List<INPUT>();
        foreach (ushort key in keys) events.Add(KeyInput(key, false));
        for (int i = keys.Count - 1; i >= 0; i--) events.Add(KeyInput(keys[i], true));
        SendChecked(events.ToArray());
    }

    public static void TypeText(string text) {
        foreach (char ch in text ?? "") {
            INPUT[] bi = new INPUT[2];
            bi[0].type = INPUT_KEYBOARD; bi[0].ki.wScan = (short)ch; bi[0].ki.dwFlags = KEYEVENTF_UNICODE;
            bi[1].type = INPUT_KEYBOARD; bi[1].ki.wScan = (short)ch; bi[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            SendChecked(bi);
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
$script:out = [Console]::Out
$handle = $null
$launched = @()

try {
    $handle = [Deputy.Desk2]::Create($Name)
    # 在干净 STA 线程里验证附着；失败必须终止，绝不能让 UIA 静默落到主桌面。
    [Deputy.Desk2]::Attach($handle)
    $attached = $true
    $attachErr = 0
    Reply @{ id = 0; ok = $true; desktop = $Name; attached = $attached; attachErr = $attachErr; pid = $PID }
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
                    Reply @{ id = $req.id; ok = $true; desktop = $Name; attached = $attached; pid = $PID }
                }
                'launch' {
                    $pidOn = [Deputy.Desk2]::Launch($req.exe, [string]$req.args, $Name)
                    $launched += $pidOn
                    Reply @{ id = $req.id; ok = $true; pid = $pidOn }
                }
                'capture' {
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
                    if ($in.op -eq 'click') {
                        $clicks = 1
                        if ($null -ne $in.clicks) { $clicks = [Math]::Max(1, [Math]::Min(3, [int]$in.clicks)) }
                        [Deputy.Desk2]::ClickOn($handle, [int]$in.x, [int]$in.y, ($in.button -eq 'right'), $clicks)
                    }
                    elseif ($in.op -eq 'type') { [Deputy.Desk2]::TypeOn($handle, [string]$in.text) }
                    elseif ($in.op -eq 'key') { [Deputy.Desk2]::KeyOn($handle, [string]$in.combo) }
                    else { throw "不支持的 input.op $($in.op)" }
                    Reply @{ id = $req.id; ok = $true }
                }
                'uia' {
                    # UIA 必须在附着到隔离桌面的干净 STA 线程里执行，不能使用 PowerShell 主线程。
                    [Deputy.Desk2]::UiaOn($handle, [int[]]$req.payload.ref.path, [string]$req.payload.op, [string]$req.payload.text)
                    Reply @{ id = $req.id; ok = $true }
                }
                'close' {
                    Reply @{ id = $req.id; ok = $true }
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
    foreach ($p in $launched) { try { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } catch { } }
    if ($handle) { [Deputy.Desk2]::CloseDesktop($handle) | Out-Null }
}
