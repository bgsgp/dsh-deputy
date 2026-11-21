# dsh-deputy/browser：CDP 浏览器控制

当前实现对应插件 **1.3.39**。五个工具和 DSH 0.2.x 插件 ABI 保持不变，浏览器部分不再是只有单标签点击的骨架。

> 本轮按用户要求只完成代码与自检用例，没有启动 DSH、Chrome/Edge 或真实网页做应用级实测。真机验证由使用者执行；不要把本文记录的旧版实测当作本轮验证结果。

## 1. 五个工具

| 工具 | 作用 |
|---|---|
| `browser_open` | 懒启动插件专用 Chrome/Edge；可选导航当前标签 |
| `browser_observe` | DOMSnapshot + AX 快照、稳定 ref、盒模型、状态与可选截图 |
| `browser_act` | 点击、输入、等待、标签、上传下载等顺序动作 |
| `browser_status` | 进程、URL、epoch、标签数、最近下载与 cookie 数量 |
| `browser_close` | 关闭插件专用浏览器和 CDP 连接 |

注册统一走 `src/registry.mjs` 的 `tools.register` 适配层。截图走 `attachments.saveImage()`，再由 `output.render` 返回 `image` content block；不会把 base64 字符串伪造成附件引用。

## 2. 观察与 ref

`browser_observe` 返回一行一个节点：

```text
[e4.42] button "搜索" @820,164 72x32
```

- `e4.42`：`epoch=4`、DOM nodeIndex=42。
- 导航、`DOM.documentUpdated`、标签切换都会换代并清空旧 ref。
- 动作使用旧 ref 会返回 `STALE_REF`，不会拿旧节点乱点。
- AX 与 DOM 属性共同生成 `disabled` / `readonly`；禁用或只读目标会被拒绝。
- `within` 支持当前 ref、元素 id 或区域可读名，并保留命中区域的后代，不再只筛选同名节点。
- `types` 按 role 过滤；`maxChars` 明确限制文本预算，默认 summary 16000 / full 60000。

截图：

```json
{
  "within": null,
  "budget": "summary",
  "screenshot": true,
  "format": "png"
}
```

## 3. 动作

`steps` 支持：

- 基本：`click`、`type`、`key`、`hover`、`scroll`、`press`、`navigate`、`wait`、`reload`。
- 等待：`waitFor`，用 `selector` 或当前 `ref` 等元素可见/消失，最长 120 秒。
- 表单：`select`，按 option `value` 或 `label` 选择；`upload` 接收本机绝对路径数组。
- 标签：`{verb:"tab",op:"list|new|switch|close"}`，切换使用独立 target/session，后台标签网络不阻塞当前页。
- 下载：`{verb:"download",ref:"e…"}` 或 `{verb:"download",url:"https://…"}`，等待本次新下载完成。
- 组合键：如 `Ctrl+A`、`Ctrl+Shift+T`，使用 CDP modifiers 与 keyDown/keyUp。

示例：

```json
{
  "steps": [
    { "verb": "waitFor", "selector": "form input[name=q]", "timeoutMs": 10000 },
    { "verb": "type", "ref": "e4.42", "text": "dsh", "clear": true },
    { "verb": "key", "key": "Enter" }
  ],
  "expect": { "urlIncludes": "search", "text": "dsh" },
  "idempotencyKey": "search-dsh-001"
}
```

### 等待与差异

- 导航等待：`document.readyState=complete`、当前 target 无在途请求、网络静默期同时满足。
- 元素等待：CSS 选择器或 ref 的盒子可见且非 disabled。
- 动作后等待：取换代、URL 变化、DOM/网络静默、预期文本中的第一个有效信号；等待超时不等于动作失败。
- 文档换代会停止批次，返回已执行步骤、剩余步数和新旧 epoch，调用方必须重新观察。

### 遮挡与高风险动作

点击前用 `DOM.resolveNode` + `elementFromPoint` 比较真实命中节点。目标被遮挡时默认返回 `OVERLAY`，不再继续点击目标。

自动遮挡处理只查找可见对话框中明确的 `close/dismiss/cancel/关闭/取消/知道了` 等控件；不会把“确定、支付、发布、删除”当作关闭按钮。可用 `dismissOverlay:false` 完全关闭自动处理。

标记为 `risk:"external"` 或 `risk:"irreversible"` 的步骤必须同时带 `confirmed:true`，否则返回 `CONFIRM_REQUIRED`。调用方只能在用户明确批准后设置该标记；它不是绕过人工确认的依据。

`idempotencyKey` 对进行中和最近 50 条结果去重。相同 key 返回首次结果和 `deduped:true`，避免网络重试造成表单重复提交；不同的独立操作必须使用不同 key。

## 4. 多标签、下载与状态恢复

- `Target.getTargets/attachToTarget/createTarget/closeTarget` 管理 page target。
- 同一 CDP WebSocket 用 flatten session 复用，多标签不会互相覆盖 `pageSession`。
- 下载目录默认 `%LOCALAPPDATA%/dsh-deputy/downloads`；`browser_status.downloads` 只暴露元数据，不暴露 cookie。
- 状态默认原子写入 `%LOCALAPPDATA%/dsh-deputy/browser-state.json`。
- Chrome/Edge 启动带 `--restore-last-session`；异常退出后先按 targetId、再按脱敏 URL 尝试找回活动标签。
- state 文件中的 URL 会去掉 query/hash，避免把常见登录令牌落盘。主动 `browser_close` 不用于恢复。
- CDP 断线或浏览器进程退出后，下一次调用会重连或重启，不再仅凭旧对象误报 `running`。

## 5. 登录态与风险

默认配置仍为 `cookies:'inherit'`、`cookiesProfile:'auto'`、`persistProfile:true`。启动前从本机 Edge/Chrome 复制 cookie 库与 Local State 到插件独立 profile；不需要、也不应把 cookie 内容打印给模型。

**风险：继承 cookie 等于让插件浏览器获得这些站点的登录态。它可能以你的身份读取页面或执行你明确批准的操作。只应操作可信站点，用完关闭插件浏览器；不要在共享机器上默认开启。**

`browser_status.cookies.count` 通过 `Storage.getCookies` 报告实际有效条数，不输出 cookie 名称、值或数据库内容。复制到字节数不等于登录成功。

历史真机记录：本机 Edge 的 App-Bound Encryption 曾导致复制约 1.26 MB 后实际读到 0 条 cookie。因此旧版“已复制文件”不能作为继承成功证据；必须看有效条数和目标站实际登录状态。

远程调试端口虽只绑定本机回环地址，本机其他进程仍可能访问它。不要把它改成公网地址，不要把插件 profile 当日常浏览器使用。

## 6. 文件

```text
src/browser.mjs          组件配置、懒启动、附件与状态总线
src/browser/daemon.mjs   生命周期、多标签、网络/下载事件、恢复、幂等
src/browser/cdp.mjs      CDP WebSocket、flatten session、断线处理
src/browser/launch.mjs   独立 profile、端口选择、进程启动与恢复
src/browser/snapshot.mjs DOM+AX、ref、within、预算与状态
src/browser/act.mjs      动作、遮挡、组合键、上传下载、expect
src/browser/wait.mjs     导航/元素/动作后三层等待
src/browser/tools.mjs    五工具 schema、注册与图片 render
src/browser/errors.mjs   统一 {code,message,hint}
src/browser/cookies.mjs  登录态文件复制（不读取 cookie 内容）
```

## 7. 验证与已知边界

`test/run-tests.mjs` 现有 50 项自检，其中浏览器新增覆盖：网络静默、禁用控件、遮挡阻断、高风险确认、多标签换代、幂等、下载记录和截图附件。`scripts/check-plugin.mjs` 同时检查五工具、author 参数表、output schema 和 DSH 注册签名。本轮未执行这些测试，需由使用者运行：

```powershell
node test/run-tests.mjs
node scripts/check-plugin.mjs
```

已知边界：

- 快照以主 frame 为主，尚未完整穿透 OOPIF/跨域 iframe；不能把主 frame ref 当作 iframe 内节点使用。
- `within` 的区域名匹配可能有歧义，优先使用当前 ref 或元素 id。
- 下载完成以 CDP 事件为准；浏览器自动改名且磁盘路径无法确认时，结果中的 `path` 可能为 `null`，但保留文件名和字节数。
- 状态恢复是 best effort，不保证 Chrome 在每个异常退出场景都恢复全部标签。
- 本轮没有真实网页、上传下载或 cookie 登录实测；首次使用应先在无风险测试站验证，再用于真实账号。
