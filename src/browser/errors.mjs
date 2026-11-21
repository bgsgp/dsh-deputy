// 浏览器组件的失败分类（context.md 第 6 条：每次失败都要带 code + hint + 建议动作）
export class BrowserError extends Error {
  constructor(code, message, hint) {
    super(message)
    this.name = 'BrowserError'
    this.code = code
    this.hint = hint
  }
}

const TABLE = {
  STALE_REF: ['节点引用已过期（页面结构变了）', '重新 browser_observe 拿新 ref 再操作'],
  DOC_CHANGED: ['文档已经换了（导航或重渲染）', '回到锚点重新导航，或重新 observe'],
  OVERLAY: ['目标被遮挡（弹窗/遮罩/固定头部）', '只允许自动关闭明确的关闭/取消控件；其他弹窗先交还用户'],
  AUTH_BLOCKED: ['页面要求登录或人工验证', '把控制权交还用户，不要尝试绕过'],
  NAV_TIMEOUT: ['导航超时', '检查 URL / 网络，必要时先 observe 看当前状态'],
  ELEMENT_TIMEOUT: ['元素等待超时', '重新 observe，或检查 selector、ref 和 visible 条件'],
  AMBIGUOUS_TARGET: ['目标不唯一', '用更具体的 name/role 收窄，或先用 within= 限定区域'],
  NOT_RUNNING: ['浏览器 daemon 没在跑', '先 browser_open'],
  CDP_ERROR: ['协议层报错', '看 error.data 判断是不是要重新 attach'],
  BAD_ARGS: ['参数不合法', '按工具描述修正参数'],
  DISABLED: ['目标不可交互', '重新观察 disabled/readonly 状态，不要对禁用控件强行输入'],
  CONFIRM_REQUIRED: ['高风险动作需要确认', '只有得到用户明确批准后，才能为该步骤设置 confirmed=true'],
  DOWNLOAD_FAILED: ['下载失败或被取消', '检查下载记录；不要用同一幂等键盲目重试'],
  DOWNLOAD_TIMEOUT: ['下载等待超时', '先查看 browser_status 的 downloads，再决定是否重试'],
  EXPECT_FAILED: ['动作后的预期状态不成立', '先重新观察并判断是否已经部分生效'],
  NOT_IMPLEMENTED: ['动作还不支持', '先确认插件版本与工具 schema 一致'],
}

export function browserError(code, message, extra) {
  const [summary, hint] = TABLE[code] ?? ['未知失败', '先重新 observe 一次']
  return new BrowserError(code, message ?? summary, extra?.hint ?? hint)
}

export function errorCodeOf(e) {
  if (e instanceof BrowserError) return e.code
  if (e?.code && Object.prototype.hasOwnProperty.call(TABLE, e.code)) return e.code
  return 'CDP_ERROR'
}

/** 统一的失败信封：工具结果和 HTTP 都用这个形状 */
export function wireError(e) {
  const code = errorCodeOf(e)
  return {
    ok: false,
    error: {
      code,
      message: e?.message ?? String(e),
      hint: e instanceof BrowserError ? e.hint : (TABLE[code]?.[1] ?? '先重新 observe 一次'),
    },
  }
}
