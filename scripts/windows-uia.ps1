# dsh-deputy · UIA 观察后端（一次性进程：stdin 收一条 JSON，stdout 吐一行 JSON）
#
# 为什么是"每次一个新进程"：UIA 的 COM 状态跟着线程走，复用常驻进程省下的几百毫秒
# 换不来"卡死就永远卡死"的风险。观察是低频动作（人已经在看屏幕了），一次性更稳。
#
# 请求：
#   { "op": "windows" }                                       列出可见顶层窗口
#   { "op": "tree", "hwnd"|"title", "depth", "maxNodes" }     取某个窗口的控件树
#   { "op": "act",  "hwnd", "ref": {"path":[0,1]}, "action": "invoke"|"setValue"|"click"|"focus", "text" }
#   { "op": "capture", "hwnd", "maxWidth" }                   窗口级灰度截图（ROI 校验用）
# 兼容旧名字：invoke / setValue / sendInput / shell
#
# 设计取舍（对照豆包 aha_cua.dll 的做法，见 docs/SENSING.md）：
#   - 先 UIA 语义（Invoke/Value/Toggle/SelectionItem），点不动才落回坐标；
#   - 坐标点击前必须校验目标窗口在前台，否则宁可报 NOT_FOREGROUND 也不乱点
#     （曾把字打进用户 Excel 公式栏，见 docs/DESKTOP.md 的坑单）；
#   - 控件树是有预算的：默认 3 层、120 个节点，超了截断并如实标注。
# 注意：PowerShell 5.1 语法（不支持 ?? 和三元），本文件必须 UTF-8 BOM + CRLF。

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms

Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;

namespace Deputy {
public class MsgNative {
    // 经典 Win32 控件的兜底通道：UIA 已经把这类子窗口统一报成 Pane 且不给模式，
    // 但 WM_* 消息仍然照常生效（豆包的 aha_cua 也会落到 SendMessage）。
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr h, int msg, IntPtr w, IntPtr l);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageW")]
    public static extern IntPtr SendMessageText(IntPtr h, int msg, IntPtr w, string text);
}
}
'@
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace Deputy {
public class UiaNative {
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, IntPtr extra);

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr h, EnumProc cb, IntPtr lParam);

    public static List<IntPtr> Children(IntPtr h) {
        List<IntPtr> list = new List<IntPtr>();
        if (h == IntPtr.Zero) return list;
        EnumChildWindows(h, delegate(IntPtr c, IntPtr l) {
            if (IsWindowVisible(c)) list.Add(c);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static List<IntPtr> Visible() {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (IsWindowVisible(h)) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
}
'@

function Write-Json($obj) {
    # 直接写 UTF-8 字节到 stdout：控制台代码页在重定向时不可靠，中文标题会变乱码
    $json = $obj | ConvertTo-Json -Depth 12 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $out = [Console]::OpenStandardOutput()
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
}

function Read-Payload {
    # 显式按 UTF-8 读 stdin：中文窗口标题必须原样过桥
    $stdin = [Console]::OpenStandardInput()
    $reader = New-Object System.IO.StreamReader($stdin, [System.Text.Encoding]::UTF8)
    $raw = $reader.ReadToEnd()
    if ([string]::IsNullOrWhiteSpace($raw)) { throw 'empty payload' }
    return $raw | ConvertFrom-Json
}

function Get-Title([IntPtr]$h) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][Deputy.UiaNative]::GetWindowText($h, $sb, 512)
    return $sb.ToString()
}

function Get-Class([IntPtr]$h) {
    $sb = New-Object System.Text.StringBuilder 256
    [void][Deputy.UiaNative]::GetClassName($h, $sb, 256)
    return $sb.ToString()
}

function Get-RectOf([IntPtr]$h) {
    $r = New-Object Deputy.UiaNative+RECT
    if (-not [Deputy.UiaNative]::GetWindowRect($h, [ref]$r)) { return $null }
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    if ($w -le 0 -or $hh -le 0) { return $null }
    return @{ x = $r.Left; y = $r.Top; w = $w; h = $hh }
}

function Get-ProcessName([int]$pid_) {
    try { return (Get-Process -Id $pid_ -ErrorAction Stop).ProcessName } catch { return '' }
}

function Get-Windows {
    $fg = [Deputy.UiaNative]::GetForegroundWindow()
    $out = New-Object System.Collections.ArrayList
    foreach ($h in [Deputy.UiaNative]::Visible()) {
        $title = Get-Title $h
        $rect = Get-RectOf $h
        # 影子窗口（1×1 的 ThumbnailDeviceHelperWnd 之类）对模型没有意义
        if ($null -ne $rect -and ($rect.w -lt 16 -or $rect.h -lt 16)) { continue }
        if ([string]::IsNullOrWhiteSpace($title) -and $null -eq $rect) { continue }
        $procId = 0
        [void][Deputy.UiaNative]::GetWindowThreadProcessId($h, [ref]$procId)
        $node = @{
            hwnd    = [int64]$h
            title   = $title
            class   = (Get-Class $h)
            pid     = [int]$procId
            process = (Get-ProcessName ([int]$procId))
            focused = ($h -eq $fg)
        }
        if ($null -ne $rect) { $node.rect = $rect }
        [void]$out.Add($node)
    }
    $fgNode = @{ hwnd = [int64]$fg; title = (Get-Title $fg) }
    return @{ windows = @($out); foreground = $fgNode }
}

function Find-Window($payload) {
    if ($null -ne $payload.hwnd -and [int64]$payload.hwnd -ne 0) { return [IntPtr]([int64]$payload.hwnd) }
    $proc = [string]$payload.process
    if (-not [string]::IsNullOrWhiteSpace($proc)) {
        foreach ($h in [Deputy.UiaNative]::Visible()) {
            $procId = 0
            [void][Deputy.UiaNative]::GetWindowThreadProcessId($h, [ref]$procId)
            $name = Get-ProcessName ([int]$procId)
            if ($name -eq $proc -and -not [string]::IsNullOrWhiteSpace((Get-Title $h))) { return $h }
        }
        return $null
    }
    $q = [string]$payload.title
    if ([string]::IsNullOrWhiteSpace($q)) { return $null }
    foreach ($h in [Deputy.UiaNative]::Visible()) {
        $t = Get-Title $h
        if ([string]::IsNullOrWhiteSpace($t)) { continue }
        if ($t -eq $q) { return $h }
    }
    foreach ($h in [Deputy.UiaNative]::Visible()) {
        $t = Get-Title $h
        if ([string]::IsNullOrWhiteSpace($t)) { continue }
        if ($t.ToLower().Contains($q.ToLower())) { return $h }
    }
    return $null
}

$script:Budget = 0
$script:Truncated = $false

function Get-PatternNames($el) {
    $names = @()
    try {
        foreach ($p in $el.GetSupportedPatterns()) {
            $names += ($p.ProgrammaticName -replace 'PatternIdentifiers\.', '')
        }
    } catch { }
    return $names
}

function Convert-Element($el, [int]$level, [int]$maxDepth, [int]$maxNodes, [IntPtr]$hwnd) {
    if ($script:Budget -ge $maxNodes) { $script:Truncated = $true; return $null }
    $script:Budget++
    $node = @{
        name    = ''
        type    = ''
        aid     = ''
        class   = ''
        enabled = $true
        patterns = @()
    }
    $kids = New-Object System.Collections.ArrayList
    try {
        $c = $el.Current
        $node.name = $c.Name
        $node.type = ($c.ControlType.ProgrammaticName -replace 'ControlType\.', '')
        $node.aid = $c.AutomationId
        $node.class = $c.ClassName
        $node.enabled = $c.IsEnabled
        if ($c.IsPassword) { $node.password = $true }
        if ($c.IsOffscreen) { $node.offscreen = $true }
        $r = $c.BoundingRectangle
        if ($r.Width -gt 0 -and $r.Height -gt 0) {
            $node.rect = @{ x = [int]$r.X; y = [int]$r.Y; w = [int]$r.Width; h = [int]$r.Height }
        }
        $node.patterns = @(Get-PatternNames $el)
    } catch { $script:LastError = 'current: ' + $_.Exception.Message }
    if ($level -lt $maxDepth) {
        try {
            $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
            $child = $walker.GetFirstChild($el)
            while ($null -ne $child) {
                if ($script:Budget -ge $maxNodes) { $script:Truncated = $true; break }
                $converted = Convert-Element $child ($level + 1) $maxDepth $maxNodes ([IntPtr]::Zero)
                if ($null -ne $converted -and $converted -is [hashtable]) { [void]$kids.Add($converted) }
                $child = $walker.GetNextSibling($child)
            }
        } catch { $script:LastError = 'walk: ' + $_.Exception.Message }
    }
    # Chrome/Electron 的内容在子 HWND 里（UIA 树到顶就只有标题栏）；UIA 树太穷时改用 HWND 兜底
    if ($kids.Count -lt 2 -and $level -lt $maxDepth -and $null -ne $hwnd -and $hwnd -ne [IntPtr]::Zero) {
        foreach ($ch in [Deputy.UiaNative]::Children($hwnd)) {
            if ($script:Budget -ge $maxNodes) { $script:Truncated = $true; break }
            $cr = Get-RectOf $ch
            if ($null -eq $cr -or $cr.w -lt 24 -or $cr.h -lt 24) { continue }
            $subEl = $null
            try { $subEl = [System.Windows.Automation.AutomationElement]::FromHandle($ch) } catch { }
            if ($null -eq $subEl) { continue }
            $sub = Convert-Element $subEl ($level + 1) $maxDepth $maxNodes $ch
            if ($null -ne $sub -and $sub -is [hashtable]) { [void]$kids.Add($sub) }
        }
    }
    $node.children = @($kids.ToArray())
    return $node
}

function Get-RootElement($payload) {
    $h = Find-Window $payload
    if ($null -eq $h) { return @{ handle = $null; element = [System.Windows.Automation.AutomationElement]::RootElement } }
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    # UWP/XAML 的 FromHandle 常常只拿到一个空壳 Pane；真正的子树挂在桌面根元素下面
    $hasChild = $true
    try { $hasChild = ($null -ne ([System.Windows.Automation.TreeWalker]::ControlViewWalker.GetFirstChild($el))) } catch { }
    if (-not $hasChild) {
        $procId = 0
        [void][Deputy.UiaNative]::GetWindowThreadProcessId($h, [ref]$procId)
        $title = Get-Title $h
        try {
            $all = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
                [System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($cand in $all) {
                try {
                    if ([int64]$cand.Current.NativeWindowHandle -eq [int64]$h) { $el = $cand; break }
                    if ([int]$cand.Current.ProcessId -eq [int]$procId -and $cand.Current.Name -eq $title) { $el = $cand; break }
                } catch { }
            }
        } catch { $script:LastError = 'root-fallback: ' + $_.Exception.Message }
    }
    return @{ handle = $h; element = $el }
}

function Resolve-Element($payload) {
    $root = Get-RootElement $payload
    $el = $root.element
    $path = $payload.ref.path
    if ($null -eq $el) { throw '没有可用的根元素（窗口不存在？）' }
    foreach ($idx in @($path)) {
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $child = $walker.GetFirstChild($el)
        $i = 0
        $target = [int]$idx
        while ($null -ne $child -and $i -lt $target) {
            $child = $walker.GetNextSibling($child)
            $i++
        }
        if ($null -eq $child) { throw "控件路径失效：索引 $idx 处没有子节点（界面可能已变）" }
        $el = $child
    }
    return $el
}

function Get-TopLevelHandle($el) {
    $walker = [System.Windows.Automation.TreeWalker]::RawViewWalker
    $cur = $el
    $hwnd = [IntPtr]::Zero
    while ($null -ne $cur) {
        $h = $cur.Current.NativeWindowHandle
        if ($h -ne 0) { $hwnd = [IntPtr]$h }
        $cur = $walker.GetParent($cur)
    }
    return $hwnd
}

function Invoke-ByUia($el) {
    $names = Get-PatternNames $el
    if ($names -contains 'InvokePatternIdentifiers.Invoke') {
        $el.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
        return 'invoke'
    }
    if ($names -contains 'TogglePatternIdentifiers.Toggle') {
        $el.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
        return 'toggle'
    }
    if ($names -contains 'SelectionItemPatternIdentifiers.Select') {
        $el.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern).Select()
        return 'select'
    }
    if ($names -contains 'ExpandCollapsePatternIdentifiers.Expand') {
        $p = $el.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($p.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Expanded) { $p.Collapse() } else { $p.Expand() }
        return 'expand'
    }
    return $null
}

function Set-ByValuePattern($el, [string]$text) {
    $names = Get-PatternNames $el
    if ($names -notcontains 'ValuePatternIdentifiers.Value') { return $null }
    $p = $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    if ($p.Current.IsReadOnly) { return 'readonly' }
    $p.SetValue($text)
    return 'setValue'
}

function Get-ElementHandle($el) {
    try { return [IntPtr]$el.Current.NativeWindowHandle } catch { return [IntPtr]::Zero }
}

function Invoke-ByHwnd($el) {
    # UIA 模式缺失时的第二顺位：按控件类名发 WM_* 消息。
    $h = Get-ElementHandle $el
    if ($h -eq [IntPtr]::Zero) { return $null }
    $cls = ''
    try { $cls = $el.Current.ClassName } catch { }
    if ($cls -match 'BUTTON') {
        [void][Deputy.MsgNative]::SendMessage($h, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)  # BM_CLICK
        return 'bm-click'
    }
    return $null
}

function Set-TextByHwnd($el, [string]$text) {
    $h = Get-ElementHandle $el
    if ($h -eq [IntPtr]::Zero) { return $null }
    $cls = ''
    try { $cls = $el.Current.ClassName } catch { }
    if ($cls -match 'EDIT|RICHEDIT|COMBOBOX') {
        [void][Deputy.MsgNative]::SendMessageText($h, 0x000C, [IntPtr]::Zero, $text)  # WM_SETTEXT
        return 'wm-settext'
    }
    return $null
}

function Send-CoordinateClick($el) {
    # 语义点不动才走坐标；发输入前必须确认目标窗口在前台，否则宁可失败
    $r = $el.Current.BoundingRectangle
    if ($r.Width -le 0 -or $r.Height -le 0) { throw '控件没有可见区域，无法坐标点击' }
    $hwnd = Get-TopLevelHandle $el
    $fg = [Deputy.UiaNative]::GetForegroundWindow()
    if ($hwnd -ne [IntPtr]::Zero -and $hwnd -ne $fg) {
        throw 'NOT_FOREGROUND: 目标窗口不在前台，拒绝坐标点击（先把窗口切到前台再试）'
    }
    $x = [int]($r.X + $r.Width / 2)
    $y = [int]($r.Y + $r.Height / 2)
    [void][Deputy.UiaNative]::SetCursorPos($x, $y)
    [Deputy.UiaNative]::mouse_event([Deputy.UiaNative]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
    [Deputy.UiaNative]::mouse_event([Deputy.UiaNative]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [IntPtr]::Zero)
    return @{ x = $x; y = $y }
}

function Invoke-Action($payload) {
    $el = Resolve-Element $payload
    $action = [string]$payload.action
    if ([string]::IsNullOrWhiteSpace($action)) { $action = [string]$payload.op }
    switch ($action) {
        'invoke' {
            $how = Invoke-ByUia $el
            if ($null -ne $how) { return @{ ok = $true; method = $how } }
            $how = Invoke-ByHwnd $el
            if ($null -ne $how) { return @{ ok = $true; method = $how } }
            $pt = Send-CoordinateClick $el
            return @{ ok = $true; method = 'coordinate'; x = $pt.x; y = $pt.y }
        }
        'setValue' {
            $txt = [string]$payload.text
            $how = Set-ByValuePattern $el $txt
            if ($how -eq 'readonly') { throw '控件是只读的，不能写值' }
            if ($null -eq $how) { $how = Set-TextByHwnd $el $txt }
            if ($null -eq $how) { throw '这个控件既不支持 Value 模式、也不是可写文本框，无法写值' }
            return @{ ok = $true; method = $how }
        }
        'click' {
            $pt = Send-CoordinateClick $el
            return @{ ok = $true; method = 'coordinate'; x = $pt.x; y = $pt.y }
        }
        'focus' {
            $el.SetFocus()
            return @{ ok = $true; method = 'focus' }
        }
        default { throw "未知 action $action" }
    }
}

function Capture-Window($payload) {
    $h = Find-Window $payload
    if ($null -eq $h) { throw 'capture 需要一个存在的窗口（hwnd 或 title）' }
    $rect = Get-RectOf $h
    if ($null -eq $rect) { throw '窗口没有可用区域（最小化？）' }
    $maxW = 640
    if ($null -ne $payload.maxWidth) { $maxW = [int]$payload.maxWidth }
    $scale = 1.0
    if ($rect.w -gt $maxW) { $scale = $maxW / $rect.w }
    $w = [int]([math]::Max(1, [math]::Round($rect.w * $scale)))
    $hh = [int]([math]::Max(1, [math]::Round($rect.h * $scale)))
    $bmp = New-Object System.Drawing.Bitmap($rect.w, $rect.h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($rect.x, $rect.y, 0, 0, (New-Object System.Drawing.Size($rect.w, $rect.h)))
    $g.Dispose()
    $small = New-Object System.Drawing.Bitmap($w, $hh)
    $g2 = [System.Drawing.Graphics]::FromImage($small)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
    $g2.DrawImage($bmp, 0, 0, $w, $hh)
    $g2.Dispose()
    $bmp.Dispose()
    $bytes = New-Object byte[] ($w * $hh)
    for ($y = 0; $y -lt $hh; $y++) {
        for ($x = 0; $x -lt $w; $x++) {
            $c = $small.GetPixel($x, $y)
            $bytes[$y * $w + $x] = [byte]((($c.R * 77) + ($c.G * 151) + ($c.B * 28)) / 256)
        }
    }
    $small.Dispose()
    return @{ width = $w; height = $hh; grayBase64 = [Convert]::ToBase64String($bytes); hwnd = [int64]$h }
}

try {
    $payload = Read-Payload
    $op = [string]$payload.op
    $result = @{ ok = $true }
    switch ($op) {
        'windows' {
            $result = (Get-Windows)
            $result.ok = $true
        }
        'tree' {
            $root = Get-RootElement $payload
            $asked = ($null -ne $payload.hwnd) -or (-not [string]::IsNullOrWhiteSpace([string]$payload.title)) -or (-not [string]::IsNullOrWhiteSpace([string]$payload.process))
            if ($null -eq $root.handle -and $asked) { throw '窗口没找到：标题/进程名不匹配，先调 op=windows 看清单' }
            $depth = 3
            if ($null -ne $payload.depth) { $depth = [int]$payload.depth }
            $maxNodes = 120
            if ($null -ne $payload.maxNodes) { $maxNodes = [int]$payload.maxNodes }
            $script:Budget = 0
            $script:Truncated = $false
            $script:LastError = ''
            $node = Convert-Element $root.element 0 $depth $maxNodes ([IntPtr]$root.handle)
            $winHwnd = [int64]0
            $winTitle = ''
            if ($null -ne $root.handle) {
                $winHwnd = [int64]$root.handle
                $winTitle = (Get-Title $root.handle)
            }
            $win = @{ hwnd = $winHwnd; title = $winTitle }
            $result = @{
                ok        = $true
                window    = $win
                node      = $node
                truncated = $script:Truncated
                scanned   = $script:Budget
            }
            if ($script:LastError) { $result.error = $script:LastError }
        }
        'act' {
            $r = Invoke-Action $payload
            $result = $r
            $result.ok = $true
        }
        'invoke' {
            $payload.action = 'invoke'
            $r = Invoke-Action $payload
            $result = $r
            $result.ok = $true
        }
        'setValue' {
            $payload.action = 'setValue'
            $r = Invoke-Action $payload
            $result = $r
            $result.ok = $true
        }
        'sendInput' {
            # MCP 原型形态还在用；这里只保留 click / focus，够跑闭环
            $in = $payload.input
            $pt = @{ x = [int]$in.x; y = [int]$in.y }
            [void][Deputy.UiaNative]::SetCursorPos($pt.x, $pt.y)
            [Deputy.UiaNative]::mouse_event([Deputy.UiaNative]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [IntPtr]::Zero)
            [Deputy.UiaNative]::mouse_event([Deputy.UiaNative]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [IntPtr]::Zero)
            $result = @{ ok = $true; method = 'coordinate'; x = $pt.x; y = $pt.y }
        }
        'capture' {
            $result = Capture-Window $payload
            $result.ok = $true
        }
        'shell' {
            Start-Process -FilePath $payload.payload.file -ArgumentList $payload.payload.args -PassThru | Out-Null
            $result = @{ ok = $true }
        }
        default { throw "未知 op $op" }
    }
    Write-Json $result
}
catch {
    Write-Json @{ ok = $false; error = $_.Exception.Message }
    exit 1
}
