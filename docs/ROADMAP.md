# ROADMAP

版本号：`主版本.本版本.本版本提交数.总提交数`。

## 0.0.x（已达成，对应 0.0.9.9）
### 感知
- [x] 帧差打分（dHash + 8×8 网格变化）→ 四档
- [x] 4×4 联系表打包（内置点阵字体、手写 PNG）
- [x] 跨档才推 + 同画面去重
### 校验
- [x] ROI 三分校验（ok / no-effect / side-effect）
- [x] 预算三档降级（normal / coarse / halt）
- [x] observe → act → verify 闭环（注入式，可无 Windows 跑测）
### 虚拟桌面
- [x] `DesktopSession` 常驻会话（状态机 / 守卫 / 幂等关闭）
- [x] 常驻宿主 `windows-desktop.ps1`：建桌面 + 启动 + BitBlt + 取树 + SendInput
- [x] 采帧与动作全部落在隔离桌面
- [x] 权限不足显式报错，不降级主桌面
### 插件化
- [x] `dsh.plugin.json` 完整声明（entry / provides / permissions / lifecycle）
- [x] 4 个工具：`deputy_sense / deputy_act / deputy_sheet / deputy_desktop`
- [x] `check-plugin.mjs` 注册一致性机检
- [x] MCP stdio 形态（含合成帧模式）

## 0.1.x（下一步：真机回归，把"原型"变"能用"）
- [ ] x64 `INPUT` 40 字节对齐、`SetCursorPos` + `MOUSEEVENTF_*` 组合的真机验证
- [ ] 隔离桌面里 BitBlt 能不能拍到 Electron / WPF / 硬件加速界面（大概率黑块，需实测记录）
- [ ] `SetThreadDesktop` 在 PowerShell 宿主里的成败与时机
- [ ] UAC / 安全桌面抢占时的行为（`OpenInputDesktop` 处理）
- [ ] 无窗口 worker exe 替换 PowerShell 宿主，清掉 UIA 树里的宿主噪声节点
- [ ] 真机跑通一个端到端任务（记事本写文件 → 校验文件存在）

## 0.2.x（稳）
- [ ] selector 冗余校验：路径命中后核对 `type` + `name`，不符即作废重规划
- [ ] 模糊匹配兜底：`name` 完全匹配 → `name` 包含 → 同类控件中唯一候选
- [ ] 同 verdict 连续 N 次熔断
- [ ] 危险动作闸门：`RequiresConfirmation` 抛宿主，人工放行
- [ ] 毫秒级输入时序（拖动、IME 组合键）

## 0.3.x（感知补维度）
- [ ] 累计位移通道（解决"列表滚到底"漏判）
- [ ] 饱和度通道（识别"变红=报错"）
- [ ] 拼图帧序灰阶编码 + ROI 描边高亮
- [ ] WGC 快路径：前台/可见场景用 `Windows.Graphics.Capture`，非活动桌面回落 BitBlt

## 0.4.x（任务级）
- [ ] 任务脚本 DSL：`plan.json` + 断言，可回归可重放
- [ ] 证据链落盘：`runs/<task>/` 存 verdict + 拼图
- [ ] 高 DPI / 多显示器换算
- [ ] 受控桌面池（任务签名 + 重置策略），兼顾启动速度与隔离

## 待评估
- 与 DSH 文件沙箱联动：一次任务同时锁"文件写入"和"桌面交互"
- Linux（Xvfb）移植：算法层已平台无关，只缺采集与输入后端
- 拼图向量化：极端预算下用"变化摘要文本"替代图片
