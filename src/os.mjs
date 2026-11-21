// dsh-deputy/os 组件入口：隔离桌面（虚拟桌面）这一半的能力。
//
// 这个包有两个 Cordis 组件（插件管理器里显示成两行）：
//   dsh-deputy/os      —— 本文件：虚拟桌面 + 桌面面板 + deputy_* 四个工具
//   dsh-deputy/browser —— src/browser.mjs：浏览器操作骨架（CDP daemon，见 docs/BROWSER.md）
// 两者同一进程、同一份模块实例，状态点通过 src/status.mjs 的总线合成。
//
// DSH 插件 ABI（0.2.2）
//
// 工具契约（对照 @deepseek-ai/dsh-tools 的 defineTool / ctx.tools.register）：
//   register({ name, description, parameters, output: { schema, render }, execute, isConcurrencySafe? })
//  - parameters 是「每字段内联 required」的描述式 schema，不是 JSON Schema 的 required 数组；
//  - output 是必填项，缺失会被注册表判为异常：
//    `tool "xxx" must declare output (schema, render, presentationMeta?)`；
//  - 图片走 content block：render 返回 [{ type: 'text', ... }, { type: 'image', attachment }]，
//    attachment 必须是 ctx.attachments.saveImage() 返回的 ImageAttachmentRef
//    （0.2.x 只有 saveImage/saveFile，旧的 attachments.add 已不存在）；
//  - 插件清单只在 package.json 的 dsh 字段里声明，dsh.plugin.json 在 0.2.x 已不再读取。
import { createDeputy } from './runner.mjs'
import { packSheet } from './sheet.mjs'
import { Budget } from './budget.mjs'
import { DesktopSession, createHostTransport, sessionSensor, sessionActuator } from './desktop.mjs'
import { createViewer, DEFAULT_VIEW_PORT } from './viewer.mjs'
import { setOsStatus } from './status.mjs'
import { toParameters, text, registerTools } from './registry.mjs'
import * as A from './action.mjs'

// 兼容旧的 import 路径（测试与 MCP 形态仍从 ./src/index.mjs 取这两个）
export { toParameters, registerTools } from './registry.mjs'

export const name = 'dsh-deputy/os'
export const inject = ['tools', 'attachments']

export const config = {
  shipAt: 'meaningful',
  settleMs: 220,
  sense: {},
  roi: {},
  budget: {},
  desktop: {
    name: null,
    prelaunch: null,
    captureWidth: 1280,
    captureHeight: 800,
  },
  view: {
    enabled: true,
    host: '127.0.0.1',
    port: DEFAULT_VIEW_PORT,
  },
}

export const state = { session: null, deputy: null, viewer: null }

function ensureSession(deputyConfig) {
  if (state.session) return state.session
  const d = deputyConfig.desktop ?? {}
  state.session = new DesktopSession({
    transport: createHostTransport(),
    name: d.name ?? undefined,
    captureWidth: d.captureWidth,
    captureHeight: d.captureHeight,
  })
  return state.session
}

/**
 * 工具结果里的图片描述。字段与 @deepseek-ai/dsh-attachment 的 ImageAttachmentRef 一致：
 * render() 直接把 execute 返回的这份元数据包成 { type: 'image', attachment }。
 */
const imageSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'number' },
    width: { type: 'number' },
    height: { type: 'number' },
    name: { type: 'string' },
    originalDimensions: { type: 'object' },
  },
}

/**
 * 描述给模型的 4 个工具：看、做、拼图、桌面会话。
 * options.saveImage 由 apply() 注入（ctx.attachments.saveImage），缺省时拼图只回文本。
 */
export function toolSpecs(deputy, session, options = {}) {
  return [
    {
      name: 'deputy_sense',
      description: '采样一帧隔离桌面，返回变化分数与档位（still/minor/meaningful/major）。低档不必看图。',
      // 只读采样，可以与别的工具并发（注册表 0.2.x 新增的 isConcurrencySafe）。
      concurrencySafe: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          first: { type: 'boolean' },
          skipped: { type: 'string' },
          score: { type: 'number' },
          tier: { type: 'string' },
          hashDistance: { type: 'number' },
          box: { type: 'object' },
        },
      },
      render: (_args, v) => {
        if (v?.first) return text('已建立首帧基线')
        if (v?.skipped) return text(`本次未出图（${v.skipped}）`)
        return text(`变化 ${Number(v?.score ?? 0).toFixed(3)} · ${v?.tier ?? 'unknown'}`)
      },
      handler: async () => deputy.observe(),
    },
    {
      name: 'deputy_act',
      description: '在隔离桌面里执行一个动作（uia/input/shell/wait），自动校验它是否真的生效（ROI 三分）。',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['uia', 'input', 'shell', 'wait'] },
          // author 参数表里 object 必须显式声明 additionalProperties（真实 dsh-tools 会抛
          // "parameters.payload.additionalProperties must be explicitly true or false"）
          payload: { type: 'object', additionalProperties: true },
          expect: { type: 'number', description: 'ROI 内期望的最小变化量' },
        },
        required: ['kind', 'payload'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        // output.schema 必须是标准 JSON Schema：required 是数组，不能内联到字段上
        // （内联写法只属于 parameters 的字段表，0.2.2 的 output 校验器会直接拒绝）。
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          verdict: { type: 'string' },
          retries: { type: 'number' },
        },
      },
      render: (_args, v) => text(`动作${v?.ok ? '生效' : '未生效'}（${v?.verdict ?? 'n/a'}，重试 ${v?.retries ?? 0}）`),
      handler: async (args) => deputy.step(A.action(args.kind, args.payload, { expect: args.expect })),
    },
    {
      name: 'deputy_sheet',
      description: '把缓冲里"值得看"的帧压成 4×4 联系表，作为 image 内容块返回给会话（一次只花一张图的钱）。',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: '为什么要看这几帧' } },
        required: ['reason'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        required: ['frames'],
        properties: {
          frames: { type: 'number' },
          budget: { type: 'object' },
          deduped: { type: 'boolean' },
          dropped: { type: 'string' },
          image: imageSchema,
        },
      },
      render: (_args, v) => {
        if (v?.dropped) return text(`拼图未推送（${v.dropped}）`)
        if (!v?.frames) return text('没有值得推的帧')
        const level = v.budget?.degradation?.level ?? 'normal'
        const blocks = text(`推送 ${v.frames} 帧联系表（预算 ${level}${v.deduped ? '，内容重复未重复上屏' : ''}）`)
        // 0.2.x 的图片不是附件"顺手一推"，而是工具结果里的 image block：模型同一步就能看到。
        if (v.image?.attachmentId) blocks.push({ type: 'image', attachment: v.image })
        return blocks
      },
      handler: async (args) => {
        const ev = await deputy.flush(args.reason)
        if (!ev) return { frames: 0 }
        if (ev.dropped) return { frames: 0, dropped: ev.dropped }
        const value = { frames: ev.frames.length, budget: ev.budget, deduped: ev.deduped }
        if (typeof options.saveImage === 'function') {
          try {
            const ref = await options.saveImage({
              data: ev.png,
              mediaType: 'image/png',
              name: `deputy-sheet-${Date.now()}.png`,
            })
            if (ref) value.image = ref
          } catch (e) {
            options.log?.(`[dsh-deputy] 拼图附件保存失败：${e.message}`)
          }
        }
        return value
      },
    },
    {
      name: 'deputy_desktop',
      description: '管理虚拟桌面会话：status 看状态，open 开新桌面（需管理员），launch 在里面启动程序，tree 取该桌面的窗口树，close 收起。',
      inputSchema: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['status', 'open', 'launch', 'tree', 'close'] },
          exe: { type: 'string', description: 'launch 时要启动的可执行文件' },
          args: { type: 'array', items: { type: 'string' } },
          depth: { type: 'number', description: 'tree 的递归深度' },
        },
        required: ['op'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        required: ['state'],
        properties: {
          state: { type: 'string' },
          name: { type: 'string' },
          pid: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: (_args, v) =>
        text(`桌面 ${v?.state ?? 'unknown'}${v?.pid ? ` · pid ${v.pid}` : ''}${v?.error ? ` · ${v.error}` : ''}`),
      handler: async (args) => {
        switch (args.op) {
          case 'status': {
            // 0.2.2 宿主会用 output.schema 校验返回值：给了 pid/error 就必须是
            // number/string，null 会直接报 invalid output（见 m02069 的实测）。
            // schema 子集不支持 nullable，所以没值就整个字段省掉。
            const value = { state: session.state }
            if (session.name) value.name = session.name
            if (typeof session.pid === 'number') value.pid = session.pid
            const message = session.lastError?.message
            if (message) value.error = message
            return value
          }
          case 'open':
            await session.ensureOpen()
            return { state: session.state, name: session.name }
          case 'launch': {
            if (!args.exe) throw new Error('launch 需要 exe')
            await session.ensureOpen()
            const r = await session.startApp(args.exe, args.args ?? [])
            const value = { state: session.state }
            if (typeof r?.pid === 'number') value.pid = r.pid
            else if (typeof session.pid === 'number') value.pid = session.pid
            return value
          }
          case 'tree': {
            await session.ensureOpen()
            const t = await session.tree(args.depth ?? 4)
            return { state: session.state, tree: t }
          }
          case 'close':
            await session.close()
            return { state: session.state }
          default:
            throw new Error(`未知 op ${args.op}`)
        }
      },
    },
  ]
}

export function apply(ctx = {}) {
  const session = ensureSession(config)
  setOsStatus({ state: session.state, running: false, error: null, detail: session.name })
  // 图片不再由 apply() 偷推：deputy_sheet 的返回值自带 image block，
  // 由 render() 交给会话，模型在同一步就能看到（0.2.x 附件契约）。
  const deputy = createDeputy({
    sensor: sessionSensor(session),
    actuator: sessionActuator(session),
    budget: new Budget(config.budget),
    policy: config,
  })
  state.deputy = deputy

  const log = (m) => ctx.logger?.warn?.(m)
  const saveImage = ctx.attachments?.saveImage?.bind(ctx.attachments)
  if (!saveImage) log('[dsh-deputy] attachments.saveImage 不可用，deputy_sheet 只回文本')
  const unregistered = registerTools(ctx, toolSpecs(deputy, session, { saveImage, log }), log)
  if (unregistered.length) {
    log(`[dsh-deputy] 未找到 tools 注册接口，${unregistered.length} 个工具未挂载；可用 mcp/server.mjs 以 MCP 形态暴露`)
  }

  const viewCfg = config.view ?? {}
  if (viewCfg.enabled !== false) {
    state.viewer = createViewer({
      session,
      host: viewCfg.host ?? '127.0.0.1',
      port: viewCfg.port ?? DEFAULT_VIEW_PORT,
    })
    state.viewer
      .start()
      .then((url) => ctx.logger?.info?.(`[dsh-deputy] 桌面面板端点 ${url}`))
      .catch((e) => ctx.logger?.warn?.(`[dsh-deputy] 面板端点启动失败：${e.message}（工具不受影响）`))
  }

  // Cordis 4 的 ctx 是严格 getter：读未注入的服务（如旧的 ctx.onDispose）会直接抛
  // "cannot get property ... without inject"。清理统一走核心的 ctx.effect(disposer)。
  ctx.effect(() => () => {
    const closing = (async () => {
      try {
        await state.viewer?.stop?.()
      } catch {
        /* 端点回收失败也要继续关桌面 */
      }
      state.viewer = null
      await session.close().catch(() => {})
      setOsStatus({ state: 'closed', running: false, error: null })
    })()
    return () => void closing
  })

  return { deputy, session, viewer: state.viewer, packSheet }
}
