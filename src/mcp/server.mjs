// 最小可用 MCP stdio 服务：让没有 DSH 原生插件能力的宿主也能用
// 帧协议：每行一个 JSON-RPC 2.0 消息（MCP stdio 传输规范）
// 环境变量 DEPUTY_FAKE=1 时用合成帧跑通闭环，便于在非 Windows 上验证协议
import readline from 'node:readline'
import { createDeputy } from '../runner.mjs'
import { UiaBridge, createUiaActuator, createWindowsSensor } from '../uia-bridge.mjs'
import { Budget } from '../budget.mjs'
import * as A from '../action.mjs'
import { verifyFile, mergeVerdict } from '../verify-file.mjs'

const SERVER_INFO = { name: 'dsh-deputy', version: '1.2.0' }

function fakeSensor() {
  let t = 0
  return {
    async capture() {
      const w = 320
      const h = 200
      const gray = new Uint8Array(w * h).fill(200)
      // 每 3 帧在随机位置画一个"按钮"，模拟真实变化
      t++
      if (t % 3 === 0) {
        const bx = 20 + ((t * 7) % (w - 80))
        const by = 20 + ((t * 5) % (h - 60))
        for (let y = by; y < by + 32; y++) for (let x = bx; x < bx + 64; x++) gray[y * w + x] = 40
      }
      return { gray, width: w, height: h }
    },
  }
}

function buildDeputy() {
  const fake = process.env.DEPUTY_FAKE === '1' || process.platform !== 'win32'
  const bridge = fake ? null : new UiaBridge()
  return createDeputy({
    sensor: fake ? fakeSensor() : createWindowsSensor(bridge),
    actuator: fake ? { perform: async () => {} } : createUiaActuator(bridge),
    budget: new Budget(),
    policy: { settleMs: 0 },
  })
}

const deputy = buildDeputy()

const TOOLS = [
  {
    name: 'deputy_sense',
    description: 'Sample one frame and score it (still/minor/meaningful/major).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'deputy_act',
    description: 'Perform one action and verify its region of influence.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { enum: ['uia', 'input', 'shell', 'wait'] },
        payload: { type: 'object' },
        expect: { type: 'number' },
        // 保存类动作必须磁盘回读，语义与 DSH 侧 deputy_act 一致
        verifyFile: { type: 'object', properties: { path: { type: 'string' }, minBytes: { type: 'number' } }, required: ['path'] },
      },
      required: ['kind', 'payload'],
    },
  },
  {
    name: 'deputy_sheet',
    description: 'Pack buffered frames into a 4x4 contact sheet and return it.',
    inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
]

async function call(name, args = {}) {
  switch (name) {
    case 'deputy_sense':
      return deputy.observe()
    case 'deputy_act': {
      const result = await deputy.step(A.action(args.kind, args.payload, { expect: args.expect }))
      if (!args.verifyFile) return result
      return mergeVerdict(result, verifyFile(args.verifyFile))
    }
    case 'deputy_sheet': {
      const ev = await deputy.flush(args.reason ?? 'manual')
      if (!ev) return { content: [{ type: 'text', text: '{"frames":0}' }] }
      return {
        content: [
          { type: 'text', text: JSON.stringify({ frames: ev.frames, budget: ev.budget }) },
          { type: 'image', data: ev.png.toString('base64'), mimeType: 'image/png' },
        ],
      }
    }
    default:
      throw Object.assign(new Error(`未知工具 ${name}`), { code: -32602 })
  }
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
  }
  const { id, method, params } = msg
  if (method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: SERVER_INFO },
    })
  }
  if (method === 'notifications/initialized' || method === 'initialized') return
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
  if (method === 'tools/call') {
    try {
      const r = await call(params?.name, params?.arguments)
      const payload = r?.content ? r : { content: [{ type: 'text', text: JSON.stringify(r) }] }
      return send({ jsonrpc: '2.0', id, result: payload })
    } catch (err) {
      return send({ jsonrpc: '2.0', id, error: { code: err.code ?? -32603, message: String(err.message ?? err) } })
    }
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
})

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n')
}
