# dsh-deputy · UIA 验证夹具（开发用，不参与插件运行）
#
# 为什么需要它：真实桌面上的窗口（浏览器、UWP、设置页）树形千差万别，验证
# "控件树读得对 + 语义动作点得中" 需要一个人造但确定的目标：Win32 经典控件、
# 有名字、有 InvokePattern/ValuePattern、点完能落盘自证。
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/uia-fixture.ps1
#
# 窗口标题固定为 deputy-uia-fixture；点"确定"把输入框内容写进 $env:TEMP\deputy-uia-fixture.txt。
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'deputy-uia-fixture'
$form.Size = New-Object System.Drawing.Size(420, 240)
$form.StartPosition = 'CenterScreen'

$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'input'
$box.AccessibleName = '输入框'
$box.Location = New-Object System.Drawing.Point(20, 24)
$box.Size = New-Object System.Drawing.Size(360, 28)
$form.Controls.Add($box)

$ok = New-Object System.Windows.Forms.Button
$ok.Name = 'ok'
$ok.AccessibleName = '确定'
$ok.Text = '确定'
$ok.Location = New-Object System.Drawing.Point(20, 70)
$ok.Size = New-Object System.Drawing.Size(120, 34)
$ok.Add_Click({
    $path = Join-Path $env:TEMP 'deputy-uia-fixture.txt'
    Set-Content -Path $path -Value ("clicked:" + $box.Text) -Encoding UTF8
})
$form.Controls.Add($ok)

$cancel = New-Object System.Windows.Forms.Button
$cancel.Name = 'cancel'
$cancel.AccessibleName = '取消'
$cancel.Text = '取消'
$cancel.Location = New-Object System.Drawing.Point(160, 70)
$cancel.Size = New-Object System.Drawing.Size(120, 34)
$form.Controls.Add($cancel)

[void]$form.ShowDialog()
