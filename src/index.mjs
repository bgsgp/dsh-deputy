// DSH 插件入口
// 形态对齐 dsh-see-now：dsh.plugin.json 里声明 entry + inject，运行时由宿主把
// sessionController / tools / attachments 三个能力喂进来。
// 注意：DSH 各版本的 tools 注册 API 有差异，这里做能力探测而不是硬绑一个方法名。
import { createDeputy } from './runner.mjs'
import { packSheet } from './sheet.mjs'
import { UiaBridge, createUiaActuator, createWindowsSensor } from './uia-bridge.mjs'
import { Budget } from './budget.mjs'
import * as A from './action.mjs'

export const name = 'dsh-deputy'
export const inject = ['sessionController', 'tools', 'attachments']

export const config = {
  shipAt: 'meaningful',
  settleMs: 220,
  sense: {},
  roi: {},
  budget: {},
}

/** 描述给模型的 3 个工具：看、做、拼图 */
export function toolSpecs(deputy) {
  return [
    {
      name: 'deputy_sense',
      description: '采样一帧隔离桌面，返回变化分数与档位（still/minor/meaningful/major）。低档不必看图。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      handler: async () => deputy.observe(),
    },
    {
      name: 'deputy_act',
      description: '执行一个动作（uia/input/shell/wait），自动校验它是否真的生效，并返回 ROI 校验结论。',
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
      inputSchema: {
        type: 'object',
        properties: { reason: { type: 'string' } },
        required: ['reason'],
      },
      handler: async (args) => {
        const ev = await deputy.flush(args.reason)
        return ev ? { frames: ev.frames.length, budget: ev.budget } : { frames: 0 }
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
  const bridge = new UiaBridge()
  const deputy = createDeputy({
    sensor: createWindowsSensor(bridge),
    actuator: createUiaActuator(bridge),
    budget: new Budget(config.budget),
    policy: config,
    onEvidence: async (ev) => {
      // 走 DSH 的 attachments，把 PNG 作为会话附件推进去
      if (ctx.attachments?.add) {
        await ctx.attachments.add({ name: `deputy-sheet-${Date.now()}.png`, mime: 'image/png', data: ev.png })
      }
    },
  })

  const unregistered = registerTools(ctx, toolSpecs(deputy))
  if (unregistered.length) {
    ctx.logger?.warn?.(
      `[dsh-deputy] 未找到 tools 注册接口，${unregistered.length} 个工具未挂载；可用 mcp/server.mjs 以 MCP 形态暴露`,
    )
  }
  return { deputy, bridge, packSheet }
}
