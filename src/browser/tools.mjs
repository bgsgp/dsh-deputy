// 浏览器组件的工具面（context.md 第 9 条：observe / act 两个就够，其余是生命周期与诊断）
//
// 0.2.2 的两套 schema 别混：
//   parameters = author 字段表（required 内联到字段上，object 必须显式 additionalProperties）
//   output.schema = 标准 JSON Schema（required 是数组）
import { text } from '../registry.mjs'
import { wireError } from './errors.mjs'

const refSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ref: { type: 'string' },
    role: { type: 'string' },
    name: { type: 'string' },
    box: { type: 'array', items: { type: 'number' } },
    onScreen: { type: 'boolean' },
  },
}

const stepSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    verb: { type: 'string', enum: ['click', 'type', 'key', 'hover', 'scroll', 'navigate', 'wait', 'reload', 'press'] },
    ref: { type: 'string' },
    text: { type: 'string' },
    key: { type: 'string' },
    url: { type: 'string' },
    deltaY: { type: 'number' },
    ms: { type: 'number' },
  },
}

const cookiesSchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    inherit: { type: 'boolean' },
    source: { type: 'string' },
    profile: { type: 'string' },
    bytes: { type: 'number' },
    count: { type: 'number' },
    reason: { type: 'string' },
  },
}

const errorSchema = {
  type: 'object',
  additionalProperties: true,
  properties: { code: { type: 'string' }, message: { type: 'string' }, hint: { type: 'string' } },
}

/** 把登录态继承结果压成一句话；没继承到就明说原因，不粉饰。 */
function cookieNote(c) {
  if (!c) return ''
  if (c.inherit && typeof c.count === 'number') return ` · 登录态：${c.count} 个 cookie（源自 ${c.profile ?? '本机 profile'}）`
  if (c.inherit) return ` · 登录态：已复制（源自 ${c.profile ?? '本机 profile'}），数量未知`
  return ` · 登录态：未继承${c.reason ? `（${c.reason}）` : ''}`
}

export function browserToolSpecs(daemon, options = {}) {
  const log = options.log ?? (() => {})
  return [
    {
      name: 'browser_open',
      description: '起一个独立浏览器实例（独立 user-data-dir + CDP），可选直接导航到 url。骨架阶段单标签。',
      inputSchema: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '启动后直接打开的地址' },
        },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          state: { type: 'string' },
          url: { type: 'string' },
          pid: { type: 'number' },
          docEpoch: { type: 'number' },
          cookies: cookiesSchema,
          error: errorSchema,
        },
      },
      render: (_a, v) => text(v?.ok ? `浏览器 ${v.state ?? 'running'} · ${v.url ?? 'about:blank'}${cookieNote(v?.cookies)}` : `打开失败（${v?.error?.code ?? 'unknown'}）：${v?.error?.message ?? ''}`),
      handler: async (args) => {
        try {
          const status = await daemon.ensureStarted()
          // 复制成功但一个 cookie 都读不出来，说明撞上 App-Bound Encryption：如实提示，不假装已登录
          if (status?.cookies?.inherit && status.cookies.count === 0) {
            log('[dsh-deputy/browser] 已复制本机 cookie 库，但新实例读到 0 个 cookie（浏览器启用了 App-Bound Encryption，见 docs/BROWSER.md）')
          }
          if (typeof args?.url === 'string' && args.url.trim()) await daemon.navigate(args.url.trim())
          return { ok: true, ...daemon.status(), state: status.state }
        } catch (e) {
          log(`[dsh-deputy/browser] open 失败：${e?.message}`)
          return { ok: false, ...wireError(e) }
        }
      },
    },
    {
      name: 'browser_observe',
      description: '一次往返拿页面结构快照：indent + [ref] + role + 名字 + 盒子。后续动作用这些 ref，不要用 CSS 选择器。',
      concurrencySafe: true,
      inputSchema: {
        type: 'object',
        properties: {
          within: { type: 'string', description: '只看某个区域：匹配 id 或可读名' },
          budget: { type: 'string', enum: ['summary', 'full'], description: 'summary=视口内明细，full=全部节点' },
          types: { type: 'array', items: { type: 'string' }, description: '只要这些 role' },
        },
      },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          text: { type: 'string' },
          refs: { type: 'array', items: refSchema },
          state: { type: 'object', additionalProperties: true },
          error: errorSchema,
        },
      },
      render: (_a, v) => (v?.ok ? text(v.text ?? '(空快照)') : text(`观察失败（${v?.error?.code ?? 'unknown'}）：${v?.error?.message ?? ''}`)),
      handler: async (args) => {
        try {
          return await daemon.observe({ within: args?.within ?? null, budget: args?.budget ?? 'summary', types: args?.types ?? null })
        } catch (e) {
          log(`[dsh-deputy/browser] observe 失败：${e?.message}`)
          return { ok: false, ...wireError(e) }
        }
      },
    },
    {
      name: 'browser_act',
      description: '按 ref 顺序执行动作（click/type/key/hover/scroll/navigate/wait/reload/press）；页面结构一变就停下并回差异。',
      inputSchema: {
        type: 'object',
        properties: {
          steps: { type: 'array', items: stepSchema, description: '要顺序执行的动作' },
          expect: {
            type: 'object',
            additionalProperties: true,
            description: '动作后必须出现的文本（写动作的断言，失败即回滚决策）',
          },
        },
        required: ['steps'],
      },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
          diff: { type: 'object', additionalProperties: true },
          snapshot: { type: 'string' },
          stopped: { type: 'string' },
          error: errorSchema,
        },
      },
      render: (_a, v) => {
        if (v?.ok) {
          const n = Array.isArray(v.steps) ? v.steps.length : 0
          return text(`执行 ${n} 个动作${v.stopped ? `（在 ${v.stopped} 处停下）` : ''}${v.diff?.url ? ` · 现在在 ${v.diff.url}` : ''}`)
        }
        return text(`动作失败（${v?.error?.code ?? 'unknown'}）：${v?.error?.message ?? ''}${v?.error?.hint ? `\n建议：${v.error.hint}` : ''}`)
      },
      handler: async (args) => {
        try {
          return await daemon.act({ steps: args?.steps ?? [], expect: args?.expect ?? null })
        } catch (e) {
          log(`[dsh-deputy/browser] act 失败：${e?.message}`)
          return { ok: false, ...wireError(e) }
        }
      },
    },
    {
      name: 'browser_status',
      description: '看浏览器 daemon 的状态（是否在跑、pid、端口、当前 target/epoch、最近错误）。',
      concurrencySafe: true,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        required: ['ok'],
        properties: {
          ok: { type: 'boolean' },
          state: { type: 'string' },
          pid: { type: 'number' },
          port: { type: 'number' },
          url: { type: 'string' },
          docEpoch: { type: 'number' },
          refs: { type: 'number' },
          cookies: cookiesSchema,
          error: { type: 'string' },
        },
      },
      render: (_a, v) =>
        text(
          `浏览器 ${v?.state ?? 'unknown'}${v?.pid ? ` · pid ${v.pid}` : ''}${v?.port ? ` · :${v.port}` : ''}${cookieNote(v?.cookies)}${v?.error ? ` · ${v.error}` : ''}`,
        ),
      handler: async () => ({ ok: true, ...daemon.status() }),
    },
    {
      name: 'browser_close',
      description: '关掉浏览器实例并清理 daemon（独立 user-data-dir 会保留，下次可复用或手动删）。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        additionalProperties: true,
        required: ['ok'],
        properties: { ok: { type: 'boolean' }, state: { type: 'string' }, error: errorSchema },
      },
      render: (_a, v) => text(v?.ok ? '浏览器已关闭' : '关闭失败'),
      handler: async () => {
        try {
          return await daemon.close()
        } catch (e) {
          return { ok: false, ...wireError(e) }
        }
      },
    },
  ]
}
