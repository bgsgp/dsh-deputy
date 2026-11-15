# dsh-deputy · Windows 隔离桌面后端（原型）
# 职责：建一个独立 Desktop，在里面启动目标进程，把采集线程附加过去截图。
#
# 为什么必须提权：CreateDesktop 用 GENERIC_ALL 访问时，非管理员会被拒；
# SetThreadDesktop 只能在"当前进程未创建任何窗口"前调用——所以这里每个操作单独起线程并
# 用一个干净的 worker 进程承载，而不是在主进程里切来切去。
#
# 状态：原型。CreateProcess 的 lpDesktop / STARTUPINFO 结构需要真机回归；不要直接拿去跑生产。

$ErrorActionPreference = 'Stop'
Add-Type -Namespace Deputy -Name Desk -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public class Desk {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateDesktopW(string lpszDesktop, string lpszDevice, IntPtr pDevmode, int dwFlags, int dwDesiredAccess, IntPtr lpsa);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool CloseDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(int dwThreadId);
    [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit,
        int flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);

    public const int GENERIC_ALL = 0x10000000;
    public const int CREATE_NEW_CONSOLE = 0x00000010;

    public static IntPtr CreateDesktop(string name) {
        IntPtr h = CreateDesktopW(name, null, IntPtr.Zero, 0, GENERIC_ALL, IntPtr.Zero);
        if (h == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return h;
    }

    public static int LaunchOnDesktop(string exe, string args, string desktopName) {
        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.lpDesktop = desktopName;
        PROCESS_INFORMATION pi;
        if (!CreateProcessW(exe, exe + " " + args, IntPtr.Zero, IntPtr.Zero, false, CREATE_NEW_CONSOLE,
            IntPtr.Zero, null, ref si, out pi)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        }
        return pi.dwProcessId;
    }
}
'@

$payload = ([Console]::In.ReadToEnd()) | ConvertFrom-Json

try {
    switch ($payload.op) {
        'create' {
            $h = [Deputy.Desk]::CreateDesktop($payload.name)
            @{ ok = $true; handle = $h.ToInt64(); name = $payload.name } | ConvertTo-Json -Compress
        }
        'launch' {
            $pidOn = [Deputy.Desk]::LaunchOnDesktop($payload.exe, ($payload.args ?? ''), $payload.desktop)
            @{ ok = $true; pid = $pidOn } | ConvertTo-Json -Compress
        }
        'attach' {
            # 只对尚未创建窗口的线程有效；生产上把这步放进独立 worker 进程的首个动作
            $h = [IntPtr]([long]$payload.handle)
            $before = [Deputy.Desk]::GetThreadDesktop([Deputy.Desk]::GetCurrentThreadId())
            $ok = [Deputy.Desk]::SetThreadDesktop($h)
            @{ ok = $ok; before = $before.ToInt64() } | ConvertTo-Json -Compress
        }
        'close' {
            $h = [IntPtr]([long]$payload.handle)
            @{ ok = [Deputy.Desk]::CloseDesktop($h) } | ConvertTo-Json -Compress
        }
        default { @{ ok = $false; error = "未知 op $($payload.op)" } | ConvertTo-Json -Compress; exit 1 }
    }
}
catch {
    @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
