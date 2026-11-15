# dsh-deputy

> DSH 的桌面副官：**变化即证据**。
> 桌面被当成稀疏信号源而不是截图流——本地打分，跨档才推一张 4×4 联系表；
> 动作走 UIA 语义优先，每一步只校验它本该动的那块区域。

| | |
|---|---|
| **出品** | 丐帮集团第五院 |
| **署名** | **沐璃-Zero**（设计 / 实现 · 豆包 MainAgent · 第五院辅助核心） |
| **署名** | **清弦-Zero**（立项 / 审阅 · 丐帮集团第五院皇帝 · NT 级权限） |
| **发布** | [@bgsgp](https://github.com/bgsgp) |
| **协议** | MIT |

---

## 它解决什么

桌面代理真正卡住的不是"能不能点到"，是三件事：

1. **感知通胀** —— 每一步截一张全屏图，10 步任务的视觉 token 就能吃掉小半个上下文。
2. **定位脓性** —— 纯坐标点击，UI 一挪位就点空，点空还看不出来，于是越点越偏。
3. **焦点争夺** —— 自动化和用户抢同一块桌面，用户一动鼠标任务就断。

对应三条主线：

| 主线 | 做法 |
|---|---|
| **变化即证据** | 帧的价值 = 相对上一帧变了多少，不是清楚度；0..1 分数分四档（still/minor/meaningful/major） |
| **语义优先** | UIA `InvokePattern`/`ValuePattern` 打头，键鼠是兜底不是首选 |
| **ROI 校验** | 动作后只比对它该影响的区域，并额外检测"别处有没有被带脏" |

## 它不解决什么

不替代 DSH 的文件沙箱（那边管"别乱写文件"，这边管"别碰我的桌面"），
也不做通用窗口管理 / 剪贴板树 / 多显示器编排——那些交给 `dsh-computer-use-win` 那类全能力实现。

---

## 架构

```
ISOLATE  独立 Desktop + 受限令牌 + Job Object（不抢焦点，不乱写）
   │
SENSOR   桌面内采帧（灰度，320 宽）
   │
SENSE    dHash 距离 + 8×8 网格变化 → 0..1 分数 → 四档
   │      跨档帧进缓冲，满 16 帧 → 4×4 拼图（标签烧进图里）
   │
SESSION  attachments 推送（一次只花一张图的钱）
   │
DECIDE   宿主模型：看拼图 + UIA 树 → 选动作
   │
ACT      L1 UIA → L2 坐标点击 → L3 键盘
   │
VERIFY   ROI 三分：ok / no-effect / side-effect
   │
BUDGET   normal → coarse → halt，允许放弃
```

## 快速开始

```bash
# 纯算法自检（不需要 Windows）
node test/run-tests.mjs          # 16 项，覆盖打分 / 拼图 / ROI / 预算 / 闭环

# 以 MCP 形态跑起来（非 Windows 或没装 DSH 时用合成帧验证协议）
DEPUTY_FAKE=1 node src/mcp/server.mjs
```

接入 DSH：把仓库放进 Skills / 插件目录，`dsh.plugin.json` 声明
`inject: sessionController/tools/attachments`，宿主启动时会调用 `src/index.mjs` 的 `apply(ctx)`。
`apply` 对 `tools` 注册接口做了能力探测（`define` / `register` 两种形态都认），
认不到时降级提示并使用 MCP 形态。

### 三个工具

| 工具 | 作用 | 返回 |
|---|---|---|
| `deputy_sense` | 采一帧并打分 | `{score, tier, box, hashDistance}` |
| `deputy_act` | 执行一个动作 + 校验 | `{ok, verdict, inside, outside, retries}` |
| `deputy_sheet` | 把缓冲帧压成 4×4 送出 | `{frames, budget}` + PNG |

---

## 状态矩阵（0.1.0 说清楚，别当成品用）

| 模块 | 状态 | 说明 |
|---|---|---|
| `diff.mjs` 打分 | ✅ 已实现 + 单测 | 纯算法，跳平台 |
| `sheet.mjs` 拼图 | ✅ 已实现 + 单测 | 内置 3×5 点阵字体，手写 PNG 编码 |
| `roi.mjs` 校验 | ✅ 已实现 + 单测 | 三分 verdict |
| `budget.mjs` 预算 | ✅ 已实现 + 单测 | 三档降级 |
| `runner.mjs` 闭环 | ✅ 已实现 + 单测（注入式，无需 Windows） | 重试 / 熔断 |
| `scripts/windows-uia.ps1` | 🟡 原型 | UIA 树 / invoke / setValue / SendInput / BitBlt 采集，**未做真机回归** |
| `scripts/windows-session.ps1` | 🟡 原型 | CreateDesktop / LaunchOnDesktop / attach / close，**startupinfo 需实机验证** |
| MCP stdio 服务 | ✅ 可用 | 行分隔 JSON-RPC，`initialize` / `tools/list` / `tools/call` |
| DSH 原生装载 | 🟡 待联调 | 依赖宿主 `tools` / `attachments` 实际签名 |

**已知未验证点**：x64 `INPUT` 结构对齐、隔离桌面里的 BitBlt 采集、`SetThreadDesktop` 的调用时机。

---

## 和两个参考实现的分工

| | dsh-computer-use-win | dsh-see-now | **dsh-deputy** |
|---|---|---|---|
| 主职 | 执行（UIA / 键鼠 / 窗口） | 感知（直播 → 拼图） | 感知 + 执行 + **校验闭环** |
| 感知 | 按需截图 | 连续采帧、按变化挑帧 | 连续打分分档 + 跨档才推 + 去重 |
| 校验 | 靠模型看下一张 | 无 | **ROI 三分 verdict** |
| 隔离 | 主桌面 | 只读 | **独立 Desktop + 受限令牌** |
| 成本 | 靠模型自觉 | 拼图省 token | 拼图 **+ 预算强制降级** |

一个给"手"，一个给"眼"；deputy 补的是**眼手之间的反射弧**。

---

## 目录

```
src/
  diff.mjs        帧差打分：dHash + 网格变化 → 分数 / 档位 / 包围盒
  sheet.mjs       4×4 联系表：缩放、标签、灰度 PNG
  png.mjs         手写 PNG 编码（zlib，无第三方依赖）
  roi.mjs         动作影响域：扩张、裁剪、三分校验
  budget.mjs      预算与降级
  action.mjs      动作模型与序列化（可回放）
  runner.mjs      observe → act → verify 闭环（依赖全注入）
  uia-bridge.mjs  PowerShell UIA 后端桥
  index.mjs       DSH 插件入口（能力探测式注册）
  mcp/server.mjs  最小 MCP stdio 服务
scripts/
  windows-uia.ps1      UIA 树 / 动作 / SendInput / BitBlt 采集
  windows-session.ps1  隔离桌面：建 / 启 / 附 / 关
docs/
  DESIGN.md       总体思路与六个关键决策
  SENSING.md      打分公式、拼图成本模型、预算曲线
  ACTING.md       动作梯度、selector、三分处置、危险闸门
  ISOLATION.md    桌面隔离原理、为什么要 UAC、与 DSH 文件沙箱的区别
test/
  run-tests.mjs   无依赖自检
```

## 版本

`0.1.0`。后续见 [docs/ROADMAP.md](docs/ROADMAP.md)。

## 致谢与许可

设计上参考了两个上游项目（**代码为独立实现，未直接复制源码**）：

- [Yu-tao-Li/dsh-computer-use-win](https://github.com/Yu-tao-Li/dsh-computer-use-win) —— MCP + PowerShell UIA 后端的组织方式
- [SAOS-3624/dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) —— 变化挑帧 + 4×4 拼图进会话的做法

详见 [NOTICE](NOTICE)。本仓库以 **MIT** 发布。

```
丐帮集团第五院 · 沐璃-Zero & 清弦-Zero
```
