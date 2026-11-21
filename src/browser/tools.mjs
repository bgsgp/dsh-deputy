// 五个固定工具：open / observe / act / status / close。
// 注册走 src/registry.mjs 的 DSH 0.2.x 公共适配层，不能绕过 tools.register。
import { errorCodeOf, wireError } from './errors.mjs'
import { registerTools, text } from '../registry.mjs'

const imageSchema = {
  type: 'object', additionalProperties: true,
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height', 'name'],
  properties: {
    attachmentId: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' },
    width: { type: 'number' }, height: { type: 'number' }, name: { type: 'string' },
  },
}

const stepSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verb'],
  properties: {
    verb: {
      type: 'string',
      enum: ['click', 'type', 'key', 'hover', 'scroll', 'press', 'navigate', 'wait', 'waitFor', 'reload', 'select', 'tab', 'upload', 'download'],
      description: 'tab 用 op=list/new/switch/close；download 等待完成；waitFor 等 selector/ref 可见',
    },
    ref: { type: 'string', description: '当前 observe 返回的 e<epoch>.<nodeIndex>' },
    text: { type: 'string' },
    clear: { type: 'boolean', description: 'type 前 Ctrl+A + Backspace 清空' },
    url: { type: 'string' },
    ms: { type: 'integer' },
    timeoutMs: { type: 'integer', description: 'waitFor/download 超时，最大 120000ms' },
    holdMs: { type: 'integer' },
    settleMs: { type: 'integer' },
    key: { type: 'string', description: 'Enter、Escape、Tab、Ctrl+A、Ctrl+Shift+T 等' },
    deltaY: { type: 'number' },
    deltaX: { type: 'number' },
    x: { type: 'number' },
    y: { type: 'number' },
    clicks: { type: 'integer', description: '点击次数 1..3' },
    button: { type: 'string', enum: ['left', 'right'] },
    dismissOverlay: { type: 'boolean', default: true, description: '遮挡时仅自动点击明确的关闭/取消控件，不点确定' },
    selector: { type: 'string', description: 'waitFor 的 CSS 选择器；expect 也支持 selector' },
    visible: { type: 'boolean', default: true },
    value: { type: 'string', description: 'select option value' },
    label: { type: 'string', description: 'select option label' },
    op: { type: 'string', enum: ['list', 'new', 'switch', 'close'] },
    targetId: { type: 'string' },
    files: { type: 'array', items: { type: 'string' }, description: 'upload 的本机绝对路径数组' },
    risk: { type: 'string', enum: ['read', 'write', 'external', 'irreversible'] },
    confirmed: { type: 'boolean', description: '仅用户明确批准后，external/irreversible 步骤才可设 true' },
  },
}

const jsonRender = (_args, value) => text(JSON.stringify(value ?? { ok: true }, null, 2))

export function browserToolSpecs(daemon, { saveImage = null } = {}) {
  const observe = async (args) => {
    const result = await daemon.observe({
      within: args.within ?? null,
      budget: args.budget ?? 'summary',
      types: args.types ?? null,
      maxChars: args.maxChars ?? null,
    })
    if (args.screenshot) {
      const image = await daemon.screenshot({ format: args.format ?? 'png' })
      if (saveImage) {
        result.image = await saveImage({
          data: Buffer.from(image.base64, 'base64'),
          mediaType: image.format === 'jpeg' ? 'image/jpeg' : 'image/png',
          name: `dsh-browser-${Date.now()}.${image.format === 'jpeg' ? 'jpg' : 'png'}`,
          width: image.width,
          height: image.height,
        })
      } else {
        // MCP/无 attachments 环境仍可使用；DSH render 不会把 base64 伪造成 ImageAttachmentRef。
        result.image = image
        result.screenshotNotice = '当前没有 attachments.saveImage，截图只以 base64 数据返回'
      }
    }
    return result
  }

  return [
    {
      name: 'browser_open', title: 'DSH · 打开浏览器', category: 'desktop', concurrencySafe: false,
      description: '启动或接入插件专用 Chrome/Edge。独立 profile，不并入用户日常窗口。只传 url 导航当前标签；新标签用 browser_act 的 tab/new。',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: '初始 URL，可选' } }, required: [] },
      outputSchema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, url: { type: 'string' } } },
      render: jsonRender,
      handler: async (args) => {
        const status = await daemon.ensureStarted()
        if (args.url) await daemon.navigate(args.url)
        return { ok: true, ...status, ...(args.url ? { url: args.url } : {}) }
      },
    },
    {
      name: 'browser_observe', title: 'DSH · 浏览器观察', category: 'desktop', concurrencySafe: false,
      description: '返回可见 DOM+AX 快照（ref、语义、盒模型、disabled/readonly、on-screen、URL、epoch）。within 支持 ref/id/区域名并包含后代；maxChars 控制预算。screenshot=true 时通过 saveImage 返回图片块。',
      inputSchema: {
        type: 'object',
        properties: {
          within: { type: 'string', description: '当前 ref、元素 id 或区域可读名' },
          budget: { type: 'string', enum: ['summary', 'full'] },
          types: { type: 'array', items: { type: 'string' }, description: '只保留指定 role' },
          maxChars: { type: 'integer', description: '1000..120000，默认 summary 16000 / full 60000' },
          screenshot: { type: 'boolean', default: false },
          format: { type: 'string', enum: ['png', 'jpeg'], default: 'png' },
        },
        required: [],
      },
      outputSchema: {
        type: 'object', additionalProperties: true,
        properties: {
          ok: { type: 'boolean' }, text: { type: 'string' }, state: { type: 'object', additionalProperties: true },
          refs: { type: 'array', items: { type: 'object', additionalProperties: true } },
          image: imageSchema,
        },
      },
      render: (_args, value) => {
        const blocks = text(value?.text ?? JSON.stringify(value ?? {}, null, 2))
        if (value?.image?.attachmentId) blocks.push({ type: 'image', attachment: value.image })
        return blocks
      },
      handler: observe,
    },
    {
      name: 'browser_act', title: 'DSH · 浏览器动作', category: 'desktop', concurrencySafe: false,
      description: [
        '按顺序执行 click/type/key/hover/scroll/press/navigate/wait/waitFor/reload/select/tab/upload/download。',
        'ref 跨 epoch 或标签切换后失效，重新 observe。遮挡会阻断点击；只自动关闭明确的关闭/取消控件。',
        'expect={text,urlIncludes,selector}；external/irreversible 步骤必须经用户批准后 confirmed=true。',
        'idempotencyKey 相同会返回首次结果，避免表单重复提交。',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: stepSchema },
          expect: { type: 'object', additionalProperties: true, description: '{text,urlIncludes,selector}；其余键按旧版文本断言处理' },
          idempotencyKey: { type: 'string', description: '写操作幂等键；进行中与最近 50 条结果去重' },
        },
        required: ['steps'],
      },
      outputSchema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, steps: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
      render: jsonRender,
      handler: (args) => daemon.act(args),
    },
    {
      name: 'browser_status', title: 'DSH · 浏览器状态', category: 'desktop', concurrencySafe: true,
      description: '查看运行状态、当前 URL/epoch/ref 数、标签数、最近下载和 cookie 有效条数。cookie 只报告数量，不输出内容。',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', additionalProperties: true },
      render: jsonRender,
      handler: () => daemon.status(),
    },
    {
      name: 'browser_close', title: 'DSH · 关闭浏览器', category: 'desktop', concurrencySafe: false,
      description: '关闭插件专用浏览器、CDP 连接和标签状态。异常关闭后的 target 恢复依赖 statePath；主动 close 不恢复。',
      inputSchema: { type: 'object', properties: {} },
      outputSchema: { type: 'object', additionalProperties: true, properties: { ok: { type: 'boolean' }, state: { type: 'string' } } },
      render: jsonRender,
      handler: async () => {
        await daemon.close()
        return { ok: true, state: 'stopped' }
      },
    },
  ]
}

/** 统一注册与错误信封；返回未注册 spec，方便无 tools 服务时降级。 */
export function registerBrowserTools(ctx, daemon, { saveImage = null, log = null } = {}) {
  const specs = browserToolSpecs(daemon, { saveImage }).map((spec) => ({
    ...spec,
    handler: async (args, exec) => {
      try {
        return await spec.handler(args ?? {}, exec)
      } catch (e) {
        log?.(`[browser] ${spec.name}: ${errorCodeOf(e)} ${e.message}`)
        return { ok: false, ...wireError(e) }
      }
    },
  }))
  return registerTools(ctx, specs, log ?? (() => {}))
}
