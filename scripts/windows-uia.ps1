# dsh-deputy · Windows UIA 后端（原型）
# 帧协议：stdin 收一个 JSON payload，stdout 吐一行 JSON。
#   { op: "tree",     root, depth }
#   { op: "invoke",   ref: { path: [i0, i1, ...] } }
#   { op: "setValue", ref, text }
#   { op: "sendInput", input: { op: "click"|"type"|"key", ... } }
#   { op: "capture",  desktop?, region? }
#   { op: "shell",    payload: { file, args } }
#
# 说明：ref 用"从根节点逐级子索引的路径"定位控件，比 RuntimeId 更容易序列化到模型侧，
# 代价是界面一变路径就失效——所以 runner 里每个动作后都要 ROI 校验，失效即重试或重新取树。
# 状态：原型。SendInput 的 INPUT 结构按 x64 40 字节对齐，未在真机回归前不要当生产件用。

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms

Add-Type -Namespace Deputy -Name Native -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public class Native {
    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx, dy, mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public short wVk, wScan; public int dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct HARDWAREINPUT { public int uMsg; public short wParamL, wParamH; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT { [FieldOffset(0)] public int type; [FieldOffset(8)] public MOUSEINPUT mi; [FieldOffset(8)] public KEYBDINPUT ki; [FieldOffset(8)] public HARDWAREINPUT hi; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint n, INPUT[] inputs, int cbSize);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(int id);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr h);
    [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
    [DllImport("gdi32.dll")] public static extern IntPtr CreateDC(string driver, string device, string port, IntPtr devmode);
    [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr hdcDst, int x, int y, int cx, int cy, IntPtr hdcSrc, int sx, int sy, int rop);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
    [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
    [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr hdc);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

    public const int SRCCOPY = 0x00CC0020;
    public const int INPUT_MOUSE = 0;
    public const int INPUT_KEYBOARD = 1;
    public const int MOUSEEVENTF_MOVE = 0x0001;
    public const int MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const int MOUSEEVENTF_LEFTUP = 0x0004;
    public const int MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const int MOUSEEVENTF_RIGHTUP = 0x0010;
    public const int KEYEVENTF_KEYUP = 0x0002;
    public const int KEYEVENTF_UNICODE = 0x0004;
}
'@

function Read-Payload {
    $raw = [Console]::In.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { throw 'empty payload' }
    return $raw | ConvertFrom-Json
}

function Get-DesktopElement([int]$depth) {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    return Convert-Element $root 0 $depth
}

function Convert-Element($el, $level, $maxDepth) {
    $node = @{
        name      = $el.Current.Name
        type      = $el.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
        automationId = $el.Current.AutomationId
        class     = $el.Current.ClassName
        enabled   = $el.Current.IsEnabled
        focusable = $el.Current.IsKeyboardFocusable
        hwnd      = $el.Current.NativeWindowHandle
        rect      = @{ x = $el.Current.BoundingRectangle.X; y = $el.Current.BoundingRectangle.Y; w = $el.Current.BoundingRectangle.Width; h = $el.Current.BoundingRectangle.Height }
        patterns  = @()
        children  = @()
    }
    foreach ($p in $el.GetSupportedPatterns()) { $node.patterns += ($p.ProgrammaticName -replace 'PatternIdentifiers\.', '') }
    if ($level -lt $maxDepth) {
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $child = $walker.GetFirstChild($el)
        while ($child -ne $null) {
            $node.children += ,(Convert-Element $child ($level + 1) $maxDepth)
            $child = $walker.GetNextSibling($child)
        }
    }
    return $node
}

function Resolve-Element($ref) {
    $el = [System.Windows.Automation.AutomationElement]::RootElement
    foreach ($idx in $ref.path) {
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $child = $walker.GetFirstChild($el)
        for ($i = 0; $i -lt [int]$idx; $i++) { $child = $walker.GetNextSibling($child) }
        if ($child -eq $null) { throw "path 索引 $idx 处没有子节点" }
        $el = $child
    }
    return $el
}

function Invoke-Element($el) {
    $p = $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $p.Invoke()
}

function Set-ElementValue($el, [string]$text) {
    $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $p.SetValue($text)
}

function Send-Mouse([int]$x, [int]$y, [int]$clicks = 1, [string]$button = 'left') {
    [Deputy.Native]::SetCursorPos($x, $y) | Out-Null
    $down = if ($button -eq 'right') { [Deputy.Native]::MOUSEEVENTF_RIGHTDOWN } else { [Deputy.Native]::MOUSEEVENTF_LEFTDOWN }
    $up = if ($button -eq 'right') { [Deputy.Native]::MOUSEEVENTF_RIGHTUP } else { [Deputy.Native]::MOUSEEVENTF_LEFTUP }
    for ($i = 0; $i -lt $clicks; $i++) {
        $inputs = New-Object 'Deputy.Native+INPUT[]' 2
        $inputs[0].type = [Deputy.Native]::INPUT_MOUSE; $inputs[0].mi.dwFlags = $down
        $inputs[1].type = [Deputy.Native]::INPUT_MOUSE; $inputs[1].mi.dwFlags = $up
        [Deputy.Native]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][Deputy.Native+INPUT])) | Out-Null
    }
}

function Send-Text([string]$text) {
    # 逐字符走 KEYEVENTF_UNICODE，绕开输入法，中文也能打进去
    foreach ($ch in $text.ToCharArray()) {
        $inputs = New-Object 'Deputy.Native+INPUT[]' 2
        $inputs[0].type = [Deputy.Native]::INPUT_KEYBOARD; $inputs[0].ki.wScan = [int][char]$ch; $inputs[0].ki.dwFlags = [Deputy.Native]::KEYEVENTF_UNICODE
        $inputs[1].type = [Deputy.Native]::INPUT_KEYBOARD; $inputs[1].ki.wScan = [int][char]$ch; $inputs[1].ki.dwFlags = ([Deputy.Native]::KEYEVENTF_UNICODE -bor [Deputy.Native]::KEYEVENTF_KEYUP)
        [Deputy.Native]::SendInput(2, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][Deputy.Native+INPUT])) | Out-Null
    }
}

function Capture-Frame($region) {
    $w = if ($region) { [int]$region.w } else { [Deputy.Native]::GetSystemMetrics(0) }
    $h = if ($region) { [int]$region.h } else { [Deputy.Native]::GetSystemMetrics(1) }
    $x = if ($region) { [int]$region.x } else { 0 }
    $y = if ($region) { [int]$region.y } else { 0 }

    $screenDc = [Deputy.Native]::GetDC([IntPtr]::Zero)
    $memDc = [Deputy.Native]::CreateCompatibleDC($screenDc)
    $bmp = [Deputy.Native]::CreateCompatibleBitmap($screenDc, $w, $h)
    [Deputy.Native]::SelectObject($memDc, $bmp) | Out-Null
    [Deputy.Native]::BitBlt($memDc, 0, 0, $w, $h, $screenDc, $x, $y, [Deputy.Native]::SRCCOPY) | Out-Null
    $img = [System.Drawing.Image]::FromHbitmap($bmp)
    # 直接降到灰度，回传的字节数是 RGBA 的 1/4，也省掉 JS 侧的转换
    $small = New-Object System.Drawing.Bitmap($img, $w, $h)
    $bytes = New-Object byte[] ($w * $h)
    for ($yy = 0; $yy -lt $h; $yy += 1) {
        for ($xx = 0; $xx -lt $w; $xx += 1) {
            $c = $small.GetPixel($xx, $yy)
            $bytes[$yy * $w + $xx] = [byte](($c.R * 77 + $c.G * 151 + $c.B * 28) / 256)
        }
    }
    $img.Dispose(); $small.Dispose()
    [Deputy.Native]::DeleteObject($bmp) | Out-Null
    [Deputy.Native]::DeleteDC($memDc) | Out-Null
    [Deputy.Native]::ReleaseDC([IntPtr]::Zero, $screenDc) | Out-Null
    return @{ width = $w; height = $h; grayBase64 = [Convert]::ToBase64String($bytes) }
}

try {
    $payload = Read-Payload
    $op = $payload.op
    switch ($op) {
        'tree' {
            # 注意：未附加到隔离桌面时，这里拿的是当前线程所在桌面的树
            $result = @{ ok = $true; tree = (Get-DesktopElement ([int]($payload.depth ?? 4))) }
        }
        'invoke' {
            $el = Resolve-Element $payload.ref
            Invoke-Element $el
            $result = @{ ok = $true }
        }
        'setValue' {
            $el = Resolve-Element $payload.ref
            Set-ElementValue $el $payload.text
            $result = @{ ok = $true }
        }
        'sendInput' {
            $in = $payload.input
            switch ($in.op) {
                'click' { Send-Mouse ([int]$in.x) ([int]$in.y) ([int]($in.clicks ?? 1)) ($in.button ?? 'left') }
                'type'  { Send-Text ([string]$in.text) }
                'key'   {
                    $vk = [System.Windows.Forms.Keys]::$($in.combo)
                    $inputs = New-Object 'Deputy.Native+INPUT[]' 1
                    $inputs[0].type = [Deputy.Native]::INPUT_KEYBOARD
                    $inputs[0].ki.wScan = [int]$vk
                    [Deputy.Native]::SendInput(1, $inputs, [System.Runtime.InteropServices.Marshal]::SizeOf([type][Deputy.Native+INPUT])) | Out-Null
                }
                default { throw "未知 input.op $($in.op)" }
            }
            $result = @{ ok = $true }
        }
        'capture' {
            $result = @{ ok = $true } + (Capture-Frame $payload.region)
        }
        'shell' {
            Start-Process -FilePath $payload.payload.file -ArgumentList $payload.payload.args -PassThru | Out-Null
            $result = @{ ok = $true }
        }
        default { throw "未知 op $op" }
    }
    $result | ConvertTo-Json -Depth 12 -Compress
}
catch {
    @{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Depth 6 -Compress
    exit 1
}
