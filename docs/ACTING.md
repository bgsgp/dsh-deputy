# 执行层：动作梯度与校验策略

## 1. 三级动作梯度

动作永远从上往下打，上一级能做就不降级：

| 级 | 手段 | 何时用 | 稳定性 |
|---|---|---|---|
| L1 | `UIA invoke / setValue` | 控件支持 InvokePattern / ValuePattern | 最高：UI 挪位不受影响 |
| L2 | `input click(x,y)` | 自绘控件、无 pattern 的元素 | 中：依赖坐标，需 ROI 校验 |
| L3 | `input key / type` | 表单、快捷键、无点击目标 | 中：`type` 走 `KEYEVENTF_UNICODE`，绕输入法 |

降级不是"猜"，是明确规则：L1 抛"不支持该 pattern" → L2；L2 `no-effect` 两次 → 重新取树再判。

## 2. 动作语义（`action.mjs`）

```js
{ id, kind: 'uia'|'input'|'shell'|'wait', payload, verify: { expect } }
```

| 动作 | payload | 默认 expect |
|---|---|---|
| `invoke` | `{ ref }` | 0.02 |
| `setValue` | `{ ref, text }` | 0.03 |
| `click` | `{ x, y, button, clicks }` | 0.02 |
| `type` | `{ text }` | 0.03 |
| `key` | `{ combo }` | 0.02 |
| `shell` | `{ file, args }` | 0.02 |
| `wait` | `{ ms }` | 0（不校验） |

`expect = 0` 表示"这个动作本来就可能不改变画面"（复制到剪贴板、写日志），
此时只判 `side-effect`，不要求 `inside > 0`。

## 3. selector：路径式 ref

```json
{ "path": [0, 2, 1], "rect": { "x": 120, "y": 66, "w": 88, "h": 26 }, "type": "Button", "name": "保存" }
```

- `path` 由 `ControlViewWalker` 逐级子节点索引得到，模型易读、可回放、可 diff；
- `rect` / `type` / `name` 是**冗余校验**：重取树后如果同一路径的控件类型或名字对不上，
  说明界面变过，动作必须作废重规划，而不是硬点；
- 代价：路径对结构调整极其敏感。这是刻意的取舍——宁可失败重试，也不要"点到一个看起来像的地方"。

## 4. 校验三分与处置

```js
verifyAction(before, after, width, height, roi, { expect })
// → { inside, outside, verdict }
```

| verdict | 条件 | 处置 |
|---|---|---|
| `ok` | inside ≥ expect 且 outside ≤ 0.12 | 继续下一步 |
| `no-effect` | inside < expect | 有限次重试（`maxRetriesPerAction=2`），仍失败则重取树 / 换动作 |
| `side-effect` | outside > 0.12 | **立即停手并上报**：弹窗、遮挡、焦点跑偏、别的窗口被激活 |

`side-effect` 是这套设计里最重要的返回值。传统流程里"点了之后冒出来一个 UAC 弹窗"会被
当成"环境噪声"忽略掉，然后模型继续在错误的界面上叠加动作，最后不可收拾。
这里它是一等公民。

## 5. ROI 怎么来的

`roiForAction(a, ctx)` 按优先级：

1. `a.payload.ref.rect`（UIA 控件边框，最准）
2. `a.payload.x/y`（点击点周围 4px 扩成 min 96px 方块）
3. `ctx.lastBox`（上一帧变化包围盒）
4. 全屏（不知道就宁可全看）

再经 `expandBox` 加 24px 边距、夹到屏幕内。

## 6. 危险动作闸门

以下动作默认**不自动执行**，必须宿主层显式确认（人在回路）：

- 删除文件 / 清空回收站 / 修改系统设置
- 安装、卸载、驱动相关
- 任何会触发 UAC 的操作
- 向外部发送内容（邮件、消息、提交表单）

实现方式：`action.kind === 'shell'` 或 `payload.op` 命中闸门名单时，`runner.step` 应抛
`RequiresConfirmation`，由宿主弹确认后再放行。0.1.0 只留了接口位（见 ROADMAP）。

## 7. 重试与熔断

- 单动作重试上限 2 次（`Budget.allowRetry`）；
- 同一动作连续 `no-effect` 达 3 次 → 熔断该动作，要求上层换策略；
- 全任务步数 40、墙钟 6 分钟，超限 `halt` 并汇报。

## 8. 键鼠细节（Windows）

- `SendInput` 的 `INPUT` 在 x64 下 40 字节，必须按 8 字节对齐（`FieldOffset(8)` 的联合体），
  x86 是 28 字节——写错就是"调用成功但什么都不发生"。
- `SetCursorPos` + `SendInput(MOUSEEVENTF_*)` 组合，避免只发 `MOUSEEVENTF_MOVE` 造成
  "移动了但没点"的假象。
- 文本输入逐字符 `KEYEVENTF_UNICODE`，中文不需要切输入法；但**组合键**（Ctrl+S 等）
  必须走虚拟键码，不能用 Unicode 通道。
