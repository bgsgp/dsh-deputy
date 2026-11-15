# ROADMAP

## 0.1.0（当前）
- [x] 帧差打分（dHash + 8×8 网格变化）→ 四档
- [x] 4×4 联系表打包（内置点阵字体、手写 PNG）
- [x] ROI 三分校验（ok / no-effect / side-effect）
- [x] 预算三档降级
- [x] observe → act → verify 闭环（注入式，可无 Windows 跑测）
- [x] MCP stdio 服务（含 `DEPUTY_FAKE` 合成帧）
- [x] Windows UIA / 隔离桌面 PowerShell 原型
- [ ] **真机回归**：x64 `INPUT` 40 字节对齐、BitBlt 在隔离桌面的可用性、`SetThreadDesktop` 时机

## 0.2.0 · 让它真的稳
- [ ] worker 进程首动作 `attach`，把隔离桌面里的 UIA 树取出来
- [ ] selector 冗余校验：路径命中后核对 `type` + `name`，不符即作废重规划
- [ ] 模糊匹配兜底：`name` 完全匹配 → `name` 包含 → 同类控件中唯一候选
- [ ] 同 verdict 连续 N 次熔断，避免"点了没反应就一直点"
- [ ] 危险动作闸门：`RequiresConfirmation` 抛给宿主，等待人工放行

## 0.3.0 · 感知补两个维度
- [ ] 累计位移通道：方向一致的 `minor` 连续 N 帧提升为 `meaningful`（解决"列表滚到底"漏判）
- [ ] 饱和度通道：低分辨率色相统计，识别"变红=报错"
- [ ] 拼图帧序编码：每帧左边框灰阶阶梯，模型不易读错顺序
- [ ] 拼图 ROI 高亮：把 `box` 用白色描边画进帧里，模型一眼看出"变化在这"

## 0.4.0 · 任务级能力
- [ ] 任务脚本 DSL：`plan.json` 声明式动作序列 + 断言，可回归可重放
- [ ] 证据链落盘：每次 verdict + 拼图存 `runs/<task>/`，失败可复盘
- [ ] 多显示器 / 高 DPI：`GetDpiForWindow` 换算物理坐标
- [ ] WGC 快路径：前台桌面用 `Windows.Graphics.Capture`，隔离桌面回落 BitBlt

## 待评估
- 与 DSH 文件沙箱联动：一次任务同时锁"文件写入"和"桌面交互"
- Linux（Xvfb）移植：`diff/sheet/roi/budget` 已平台无关，只缺采集与输入后端
- 拼图向量化：把 16 帧压成"变化摘要"文本（区域 + 幅度 + 时间），极端预算下替代图片
