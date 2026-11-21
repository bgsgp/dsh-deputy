// 0.2.2 工具注册的公共适配层（os 与 browser 两个组件都用）
//
// register({ name, description, parameters, output: { schema, render }, execute, isConcurrencySafe? })
//  - parameters 是「每字段内联 required」的描述式 schema，不是 JSON Schema 的 required 数组；
//  - output.schema 是**标准 JSON Schema**（required 必须是数组），0.2.2 的 validateArgs 会直接校验；
//  - 没有 tools 服务时把 spec 交回去（可改走 mcp/server.mjs 的 MCP 形态）。

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

export const text = (s) => [{ type: 'text', text: s }]

export function registerTools(ctx, specs, log = () => {}) {
  const box = ctx?.tools
  const sink = []
  for (const spec of specs) {
    if (typeof box?.register !== 'function') {
      sink.push(spec)
      continue
    }
    const def = {
      name: spec.name,
      description: spec.description,
      parameters: toParameters(spec.inputSchema),
      output: { schema: spec.outputSchema, render: spec.render },
      execute: (args, exec) => spec.handler(args, exec),
    }
    if (spec.concurrencySafe === true) def.isConcurrencySafe = () => true
    box.register(def)
  }
  if (sink.length) log(`[dsh-deputy] 没有可用的 tools.register，${sink.length} 个工具未挂载；可用 mcp/server.mjs 以 MCP 形态暴露`)
  return sink
}
