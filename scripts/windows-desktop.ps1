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

Add-Type -Namespace Deputy -Name Desk2 -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Desk2 {
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
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int cx, int cy, IntPtr src, int sx, int sy, int rop);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit,
        int flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

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
        if (!CreateProcessW(exe, exe + " " + args, IntPtr.Zero, IntPtr.Zero, false,
            CREATE_NEW_CONSOLE, IntPtr.Zero, null, ref si, out pi))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return pi.dwProcessId;
    }

    public static void Click(int x, int y, bool right) {
        SetCursorPos(x, y);
        INPUT[] bi = new INPUT[2];
        bi[0].type = INPUT_MOUSE; bi[0].mi.dwFlags = right ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_LEFTDOWN;
        bi[1].type = INPUT_MOUSE; bi[1].mi.dwFlags = right ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_LEFTUP;
        SendInput(2, bi, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void TypeText(string text) {
        foreach (char ch in text) {
            INPUT[] bi = new INPUT[2];
            bi[0].type = INPUT_KEYBOARD; bi[0].ki.wScan = (short)ch; bi[0].ki.dwFlags = KEYEVENTF_UNICODE;
            bi[1].type = INPUT_KEYBOARD; bi[1].ki.wScan = (short)ch; bi[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            SendInput(2, bi, Marshal.SizeOf(typeof(INPUT)));
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

$script:out = [Console]::Out
$handle = $null
$launched = @()

try {
    $handle = [Deputy.Desk2]::Create($Name)
    # 关键：在创建任何窗口之前把本线程缠到隔离桌面
    $attached = [Deputy.Desk2]::SetThreadDesktop($handle)
    Reply @{ id = 0; ok = $true; desktop = $Name; attached = $attached; pid = $PID }
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
                'launch' {
                    $pidOn = [Deputy.Desk2]::Launch($req.exe, [string]$req.args, $Name)
                    $launched += $pidOn
                    Reply @{ id = $req.id; ok = $true; pid = $pidOn }
                }
                'capture' {
                    $w = [Deputy.Desk2]::GetSystemMetrics(0)
                    $h = [Deputy.Desk2]::GetSystemMetrics(1)
                    $screenDc = [Deputy.Desk2]::GetDC([IntPtr]::Zero)
                    $memDc = [Deputy.Desk2]::CreateCompatibleDC($screenDc)
                    $bmp = [Deputy.Desk2]::CreateCompatibleBitmap($screenDc, $w, $h)
                    [Deputy.Desk2]::SelectObject($memDc, $bmp) | Out-Null
                    [Deputy.Desk2]::BitBlt($memDc, 0, 0, $w, $h, $screenDc, 0, 0, [Deputy.Desk2]::SRCCOPY) | Out-Null
                    $img = [System.Drawing.Image]::FromHbitmap($bmp)
                    $bytes = New-Object byte[] ($w * $h)
                    for ($y = 0; $y -lt $h; $y++) {
                        for ($x = 0; $x -lt $w; $x++) {
                            $c = $img.GetPixel($x, $y)
                            $bytes[$y * $w + $x] = [byte](($c.R * 77 + $c.G * 151 + $c.B * 28) / 256)
                        }
                    }
                    $img.Dispose()
                    [Deputy.Desk2]::DeleteObject($bmp) | Out-Null
                    [Deputy.Desk2]::DeleteDC($memDc) | Out-Null
                    [Deputy.Desk2]::ReleaseDC([IntPtr]::Zero, $screenDc) | Out-Null
                    Reply @{ id = $req.id; ok = $true; width = $w; height = $h; grayBase64 = [Convert]::ToBase64String($bytes) }
                }
                'tree' {
                    $root = [System.Windows.Automation.AutomationElement]::RootElement
                    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
                    $items = @()
                    $child = $walker.GetFirstChild($root)
                    while ($child -ne $null) {
                        $items += @{
                            name = $child.Current.Name
                            type = $child.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
                            pid  = $child.Current.ProcessId
                            rect = @{ x = $child.Current.BoundingRectangle.X; y = $child.Current.BoundingRectangle.Y; w = $child.Current.BoundingRectangle.Width; h = $child.Current.BoundingRectangle.Height }
                        }
                        $child = $walker.GetNextSibling($child)
                    }
                    Reply @{ id = $req.id; ok = $true; desktop = $Name; windows = $items }
                }
                'input' {
                    $in = $req.input
                    if ($in.op -eq 'click') { [Deputy.Desk2]::Click([int]$in.x, [int]$in.y, ($in.button -eq 'right')) }
                    elseif ($in.op -eq 'type') { [Deputy.Desk2]::TypeText([string]$in.text) }
                    else { throw "不支持的 input.op $($in.op)" }
                    Reply @{ id = $req.id; ok = $true }
                }
                'uia' {
                    # 由 JS 侧传 ref path，这里逐级走 ControlViewWalker 定位后执行 pattern
                    $el = [System.Windows.Automation.AutomationElement]::RootElement
                    foreach ($idx in $req.payload.ref.path) {
                        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
                        $child = $walker.GetFirstChild($el)
                        for ($i = 0; $i -lt [int]$idx; $i++) { $child = $walker.GetNextSibling($child) }
                        if ($null -eq $child) { throw "path 索引 $idx 无子节点" }
                        $el = $child
                    }
                    if ($req.payload.op -eq 'invoke') {
                        $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
                    }
                    elseif ($req.payload.op -eq 'setValue') {
                        $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).SetValue([string]$req.payload.text)
                    }
                    else { throw "不支持的 uia.op $($req.payload.op)" }
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
