// DSH 插件入口
// 工具声明按 DSH tools 注册表的真实契约写（对照 @deepseek-ai/dsh-tool-present）：
//   register({ name, description, parameters, output: { schema, render }, execute })
//  - parameters 是「每字段内联 required」的描述式 schema，不是 JSON Schema 的 required 数组；
//  - output 是必填项，缺失会被注册表判为异常：
//    `tool "xxx" must declare output (schema, render, presentationMeta?)`。
import { createDeputy } from './runner.mjs'
import { packSheet } from './sheet.mjs'
import { Budget } from './budget.mjs'
import { DesktopSession, createHostTransport, sessionSensor, sessionActuator } from './desktop.mjs'
import { createViewer, DEFAULT_VIEW_PORT } from './viewer.mjs'
import * as A from './action.mjs'

export const name = 'dsh-deputy'
export const inject = ['sessionController', 'tools', 'attachments']

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

/** JSON Schema → 注册表要的 parameters（properties 提升一层，required 落到字段上） */
export function toParameters(inputSchema = {}) {
  const props = inputSchema.properties ?? {}
  const required = inputSchema.required ?? []
  const out = {}
  for (const [key, value] of Object.entries(props)) {
    out[key] = { ...value }
    if (required.includes(key)) out[key].required = true
  }
  return out
}

const text = (s) => [{ type: 'text', text: s }]

/** 描述给模型的 4 个工具：看、做、拼图、桌面会话 */
export function toolSpecs(deputy, session) {
  return [
    {
      name: 'deputy_sense',
      description: '采样一帧隔离桌面，返回变化分数与档位（still/minor/meaningful/major）。低档不必看图。',
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
          payload: { type: 'object' },
          expect: { type: 'number', description: 'ROI 内期望的最小变化量' },
        },
        required: ['kind', 'payload'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', required: true },
          verdict: { type: 'string' },
          retries: { type: 'number' },
        },
      },
      render: (_args, v) => text(`动作${v?.ok ? '生效' : '未生效'}（${v?.verdict ?? 'n/a'}，重试 ${v?.retries ?? 0}）`),
      handler: async (args) => deputy.step(A.action(args.kind, args.payload, { expect: args.expect })),
    },
    {
      name: 'deputy_sheet',
      description: '把缓冲里"值得看"的帧压成 4×4 联系表推送进会话（一次只花一张图的钱）。',
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string', description: '为什么要看这几帧' } },
        required: ['reason'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          frames: { type: 'number', required: true },
          budget: { type: 'object' },
          deduped: { type: 'boolean' },
          dropped: { type: 'string' },
        },
      },
      render: (_args, v) => {
        if (v?.dropped) return text(`拼图未推送（${v.dropped}）`)
        if (!v?.frames) return text('没有值得推的帧')
        const level = v.budget?.degradation?.level ?? 'normal'
        return text(`推送 ${v.frames} 帧联系表（预算 ${level}${v.deduped ? '，内容重复未重复上屏' : ''}）`)
      },
      handler: async (args) => {
        const ev = await deputy.flush(args.reason)
        if (!ev) return { frames: 0 }
        if (ev.dropped) return { frames: 0, dropped: ev.dropped }
        return { frames: ev.frames.length, budget: ev.budget, deduped: ev.deduped }
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
        properties: {
          state: { type: 'string', required: true },
          name: { type: 'string' },
          pid: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: (_args, v) =>
        text(`桌面 ${v?.state ?? 'unknown'}${v?.pid ? ` · pid ${v.pid}` : ''}${v?.error ? ` · ${v.error}` : ''}`),
      handler: async (args) => {
        switch (args.op) {
          case 'status':
            return {
              state: session.state,
              name: session.name,
              pid: session.pid ?? null,
              error: session.lastError?.message ?? null,
            }
          case 'open':
            await session.ensureOpen()
            return { state: session.state, name: session.name }
          case 'launch': {
            if (!args.exe) throw new Error('launch 需要 exe')
            await session.ensureOpen()
            const r = await session.startApp(args.exe, args.args ?? [])
            return { state: session.state, ...r }
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

/**
 * 注册工具。优先走真实注册表签名（含 output）；
 * 老宿主只认 define(name, desc, schema, handler) 时退回去，但不静默——会在日志里说明。
 */
export function registerTools(ctx, specs, log = () => {}) {
  const box = ctx.tools ?? {}
  const sink = []
  for (const spec of specs) {
    const def = {
      name: spec.name,
      description: spec.description,
      parameters: toParameters(spec.inputSchema),
      output: { schema: spec.outputSchema, render: spec.render },
      execute: (args, exec) => spec.handler(args, exec),
    }
    if (typeof box.register === 'function') {
      box.register(def)
    } else if (typeof box.define === 'function') {
      box.define(spec.name, spec.description, spec.inputSchema, spec.handler)
      log(`[dsh-deputy] tools 只有 define()，${spec.name} 未声明 output（新宿主会判异常）`)
    } else {
      sink.push(spec)
    }
  }
  return sink
}

export function apply(ctx = {}) {
  const session = ensureSession(config)
  const deputy = createDeputy({
    sensor: sessionSensor(session),
    actuator: sessionActuator(session),
    budget: new Budget(config.budget),
    policy: config,
    onEvidence: async (ev) => {
      if (ctx.attachments?.add) {
        await ctx.attachments.add({ name: `deputy-sheet-${Date.now()}.png`, mime: 'image/png', data: ev.png })
      }
    },
  })
  state.deputy = deputy

  const log = (m) => ctx.logger?.warn?.(m)
  const unregistered = registerTools(ctx, toolSpecs(deputy, session), log)
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

  if (typeof ctx.onDispose === 'function') {
    ctx.onDispose(async () => {
      try {
        await state.viewer?.stop?.()
      } catch {
        /* 端点回收失败也要继续关桌面 */
      }
      state.viewer = null
      await session.close().catch(() => {})
    })
  }

  return { deputy, session, viewer: state.viewer, packSheet }
}
