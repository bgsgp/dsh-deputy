// DSH 插件入口
// 形态对齐 dsh-see-now：dsh.plugin.json 声明 entry + inject，宿主把
// sessionController / tools / attachments 喂进来；这里额外要求一个**虚拟桌面会话**。
// 注意：DSH 各版本的 tools 注册 API 有差异，这里做能力探测而不是硬绑一个方法名。
import { createDeputy } from './runner.mjs'
import { packSheet } from './sheet.mjs'
import { Budget } from './budget.mjs'
import { DesktopSession, createHostTransport, sessionSensor, sessionActuator } from './desktop.mjs'
import { createViewer, DEFAULT_VIEW_PORT } from './viewer.mjs'
import * as A from './action.mjs'

export const name = 'dsh-deputy'
export const inject = ['sessionController', 'tools', 'attachments']

export const config = {
  // 感知
  shipAt: 'meaningful',
  settleMs: 220,
  sense: {},
  // 执行
  roi: {},
  budget: {},
  desktop: {
    // 每个任务一个独立桌面；名字不传就随机
    name: null,
    // 需要在隔离桌面里预先拉起的程序（可选）
    prelaunch: null,
    captureWidth: 1280,
    captureHeight: 800,
  },
  // 面板（浏览器半 client.js 读的那个端点）
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

/** 描述给模型的 4 个工具：看、做、拼图、桌面会话 */
export function toolSpecs(deputy, session) {
  return [
    {
      name: 'deputy_sense',
      description: '采样一帧隔离桌面，返回变化分数与档位（still/minor/meaningful/major）。低档不必看图。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => deputy.observe(),
    },
    {
      name: 'deputy_act',
      description: '在隔离桌面里执行一个动作（uia/input/shell/wait），自动校验它是否真的生效（ROI 三分）。',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { enum: ['uia', 'input', 'shell', 'wait'] },
          payload: { type: 'object' },
          expect: { type: 'number', description: 'ROI 内期望的最小变化量' },
        },
        required: ['kind', 'payload'],
      },
      handler: async (args) => deputy.step(A.action(args.kind, args.payload, { expect: args.expect })),
    },
    {
      name: 'deputy_sheet',
      description: '把缓冲里"值得看"的帧压成 4×4 联系表推送进会话（一次只花一张图的钱）。',
      inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
      handler: async (args) => {
        const ev = await deputy.flush(args.reason)
        return ev ? { frames: ev.frames.length, budget: ev.budget } : { frames: 0 }
      },
    },
    {
      name: 'deputy_desktop',
      description: '管理虚拟桌面会话：status 看状态，open 开新桌面（需管理员），launch 在里面启动程序，tree 取该桌面的窗口树，close 收起。',
      inputSchema: {
        type: 'object',
        properties: {
          op: { enum: ['status', 'open', 'launch', 'tree', 'close'] },
          exe: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          depth: { type: 'number' },
        },
        required: ['op'],
      },
      handler: async (args) => {
        switch (args.op) {
          case 'status':
            return { state: session.state, name: session.name, pid: session.pid, error: session.lastError?.message ?? null }
          case 'open':
            await session.ensureOpen()
            return { state: session.state, name: session.name }
          case 'launch':
            if (!args.exe) throw new Error('launch 需要 exe')
            await session.ensureOpen()
            return session.startApp(args.exe, args.args ?? [])
          case 'tree':
            await session.ensureOpen()
            return session.tree(args.depth ?? 4)
          case 'close':
            return session.close()
          default:
            throw new Error(`未知 op ${args.op}`)
        }
      },
    },
  ]
}

function registerTools(ctx, specs) {
  const box = ctx.tools ?? {}
  const sink = []
  for (const s of specs) {
    if (typeof box.define === 'function') box.define(s.name, s.description, s.inputSchema, s.handler)
    else if (typeof box.register === 'function') box.register({ ...s })
    else sink.push(s)
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

  const unregistered = registerTools(ctx, toolSpecs(deputy, session))
  if (unregistered.length) {
    ctx.logger?.warn?.(
      `[dsh-deputy] 未找到 tools 注册接口，${unregistered.length} 个工具未挂载；可用 mcp/server.mjs 以 MCP 形态暴露`,
    )
  }

  // 面板数据面：只绑回环地址，端口冲突时降级但不影响工具
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

  // 宿主支持生命周期钩子时，任务结束自动收桌面，不留残留
  if (typeof ctx.onDispose === 'function') {
    ctx.onDispose(() => {
      state.viewer?.stop?.().catch?.(() => {})
      return session.close().catch(() => {})
    })
  }

  return { deputy, session, viewer: state.viewer, packSheet }
}
