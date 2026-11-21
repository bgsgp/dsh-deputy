// 插件自检：node scripts/check-plugin.mjs
//
// 目标平台是 DSH 0.2.2：清单只认 package.json 的 dsh 字段，
// 工具只认 ctx.tools.register(defineTool({ output: { schema, render } }))，
// 图片只认 attachments.saveImage() 返回的 ImageAttachmentRef。
// 这里把这些"换个 DSH 版本就会静默失效"的地方全部机检一遍。
import { readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  problems.push(m)
  console.log(`  ✗ ${m}`)
}
const warn = (m) => console.log(`  ! ${m}`)

const VERSION_RE = /^\d+\.\d+\.\d+$/ // 主版本.本版本.总提交数（标准 semver，pnpm/npm 才认）
const OLD_CLIENT_PACKAGES = ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-layout']

// DSH 0.2.2 只接受受限 JSON Schema 子集（dsh-tools/src/json-schema.ts）。工具注册时
// 会跑 assertSupportedJsonSchema(output.schema)，错误会让整个插件入口不激活。
// 这里按同一套规则静态校验：required 只能是数组、只属于 object，
// 标量字段带内联 required 会被真实运行时报
// “schema.properties.x.required is not supported on type ...”。
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const CONSTRAINT_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const ANNOTATION_KEYS = new Set(['title', 'description', 'default', 'examples'])

function checkRawSchema(node, where, violations) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) {
    violations.push(`${where} 必须是 schema 对象`)
    return
  }
  for (const key of Object.keys(node)) {
    if (!CONSTRAINT_KEYS.has(key) && !ANNOTATION_KEYS.has(key)) {
      violations.push(`${where}.${key} 不是支持的 JSON Schema 关键字`)
    }
  }
  const hasType = Object.hasOwn(node, 'type')
  const hasOneOf = Object.hasOwn(node, 'oneOf')
  if (hasType && hasOneOf) {
    violations.push(`${where} 不能同时声明 type 和 oneOf`)
    return
  }
  if (hasOneOf) {
    for (const sibling of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(node, sibling)) violations.push(`${where}.${sibling} 不能与 oneOf 并列`)
    }
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) {
      violations.push(`${where}.oneOf 至少要有两个分支`)
    } else {
      node.oneOf.forEach((branch, i) => checkRawSchema(branch, `${where}.oneOf[${i}]`, violations))
    }
    return
  }
  if (!hasType) {
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(node, key)) violations.push(`${where}.${key} 需要先声明 type`)
    }
    return
  }
  if (!SCHEMA_TYPES.has(node.type)) {
    violations.push(`${where}.type 非法：${JSON.stringify(node.type)}`)
    return
  }
  const scalar = ['string', 'number', 'integer', 'boolean', 'null'].includes(node.type)
  if (scalar) {
    if (typeof node.required === 'boolean') {
      violations.push(`${where}.required 是内联写法，0.2.2 的 output schema 只接受 required 数组`)
    }
    const allowed = ['enum', 'const']
    for (const key of allowed) {
      if (!Object.hasOwn(node, key)) continue
      if (key === 'enum') {
        const list = node.enum
        const good = Array.isArray(list) && list.length > 0 && list.every((v) => typeof v === node.type || (node.type === 'integer' && Number.isInteger(v)))
        if (!good) violations.push(`${where}.enum 必须是 ${node.type} 值的非空数组`)
      } else if (typeof node.const !== node.type) {
        violations.push(`${where}.const 必须是 ${node.type}`)
      }
    }
    if (Object.hasOwn(node, 'items')) violations.push(`${where}.items 只能用于 array`)
    return
  }
  if (node.type === 'array') {
    if (Object.hasOwn(node, 'items')) checkRawSchema(node.items, `${where}.items`, violations)
    return
  }
  // object
  if (Object.hasOwn(node, 'items')) violations.push(`${where}.items 不能用于 object`)
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    violations.push(`${where}.additionalProperties 必须是布尔值`)
  }
  if (Object.hasOwn(node, 'required') && (typeof node.required === 'boolean' || !Array.isArray(node.required))) {
    violations.push(`${where}.required 必须是属性名数组`)
  }
  const props = Object.hasOwn(node, 'properties') ? node.properties : undefined
  if (props !== undefined) {
    if (!props || typeof props !== 'object' || Array.isArray(props)) {
      violations.push(`${where}.properties 必须是对象`)
    } else {
      for (const [key, child] of Object.entries(props)) checkRawSchema(child, `${where}.properties.${key}`, violations)
    }
  }
  if (Array.isArray(node.required)) {
    for (const name of node.required) {
      if (typeof name !== 'string') violations.push(`${where}.required 只能包含字符串`)
      else if (props && !Object.hasOwn(props, name)) violations.push(`${where}.required 里的 "${name}" 不在 properties 中`)
    }
  }
}

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'))
}
function exists(rel) {
  try {
    statSync(path.join(ROOT, rel))
    return true
  } catch {
    return false
  }
}

console.log('dsh-deputy plugin check (DSH 0.2.2 ABI)')

const pkg = readJson('package.json')

// 1. 版本必须是标准三段 semver（四段会被 pnpm/npm 直接拒绝）
VERSION_RE.test(pkg.version) ? ok(`版本 ${pkg.version} 是标准 semver`) : bad(`版本 ${pkg.version} 不是 主.本.总 三段 semver`)

// 2. 旧清单必须已经删除：0.2.x 不再读取 dsh.plugin.json
exists('dsh.plugin.json') ? bad('仍存在 dsh.plugin.json（0.2.x 不读取，会误导安装者）') : ok('无遗留 dsh.plugin.json')
pkg.dsh?.plugin ? bad('package.json 仍声明 dsh.plugin（0.2.x 已无此字段）') : ok('package.json 未声明 dsh.plugin')

// 3. 平台与 DSH 版本要求（engines.dsh 决定能否安装/激活）
pkg.os?.includes('win32') ? ok('os 限定 win32') : bad('os 未限定 win32')
pkg.dsh?.bundle?.platforms?.includes('win32') ? ok('dsh.bundle.platforms 含 win32') : bad('dsh.bundle.platforms 未声明 win32')
pkg.engines?.dsh ? ok(`engines.dsh = ${pkg.engines.dsh}`) : bad('缺少 engines.dsh（0.2.x 安装门槛）')
pkg.engines?.node ? ok(`engines.node = ${pkg.engines.node}`) : bad('缺少 engines.node')
for (const peer of ['@deepseek-ai/cordis', '@deepseek-ai/dsh']) {
  pkg.peerDependencies?.[peer] ? ok(`peerDependencies ${peer}`) : bad(`peerDependencies 缺少 ${peer}`)
}

// 4. bundle patch 与入口文件
const patch = pkg.dsh?.bundle?.patch
patch && exists(patch) ? ok(`dsh.bundle.patch = ${patch}`) : bad(`dsh.bundle.patch 指向不存在的文件 ${patch}`)
const main = pkg.main
main && exists(main) ? ok(`main = ${main}`) : bad('main 缺失或文件不存在')

// 5. 浏览器半：client 入口、platform、inject 必须用 0.2.x 的包名
const clientRel = pkg.exports?.['./client']
clientRel && exists(clientRel) ? ok(`exports["./client"] = ${clientRel}`) : bad('exports["./client"] 未声明或文件不存在')
pkg.dsh?.client?.platform === 'web' ? ok('dsh.client.platform = web') : bad('dsh.client.platform 未声明为 web')
const inject = pkg.dsh?.client?.inject ?? []
inject.length ? ok(`dsh.client.inject: ${inject.join(', ')}`) : bad('dsh.client.inject 为空')
for (const name of inject) {
  OLD_CLIENT_PACKAGES.includes(name) ? bad(`dsh.client.inject 仍引用 0.1.x 包 ${name}`) : null
}
if (clientRel && exists(clientRel)) {
  const src = readFileSync(path.join(ROOT, clientRel), 'utf8')
  src.includes('__ModuleLoader__.load') ? ok('client.js 走 lazy-CJS ModuleLoader') : bad('client.js 未使用 __ModuleLoader__.load')
  // 入口必须在左侧「应用」栏（sidebar.panellist）+ 中央 main 页，两处 id/key 同名。
  src.includes("'sidebar.panellist'") ? ok('client.js 注册 sidebar.panellist') : bad('client.js 未注册 sidebar.panellist')
  src.includes("'main'") ? ok('client.js 注册 main 页') : bad('client.js 未注册 main 页')
  src.includes('DSH操作电脑') ? ok('client.js 侧栏名 = DSH操作电脑') : bad('client.js 侧栏名不是 DSH操作电脑')
  src.includes('shell.overlay') ? bad('client.js 仍挂 shell.overlay（应改为侧栏入口）') : ok('client.js 不再挂 shell.overlay')
  // 状态点必须内联在图标旁：行右端 0..28px 属于 unpin（大头针），绝对定位会重叠。
  src.includes('ddp-glyph') ? ok('client.js 状态点内联在图标旁（ddp-glyph）') : bad('client.js 缺少 ddp-glyph，状态点位置不明')
  src.includes('position:absolute;right:7px') || src.includes('.panelEntry:hover')
    ? bad('client.js 状态点仍绝对定位到行右端（会和大头针重叠）')
    : ok('client.js 状态点不再占用行右端')
  src.includes("exports.inject") ? ok('client.js 声明 exports.inject') : warn('client.js 未声明 exports.inject')
}

// 6. icon：0.2.x 从 package.json 顶层 icon 内联进商城/插件列表
if (!pkg.icon) {
  bad('缺少 icon（0.2.x 插件卡片的图标来源）')
} else if (!exists(pkg.icon)) {
  bad(`icon 指向不存在的文件 ${pkg.icon}`)
} else {
  const size = statSync(path.join(ROOT, pkg.icon)).size
  const ext = path.extname(pkg.icon).toLowerCase()
  const allowed = ['.svg', '.png', '.jpg', '.jpeg', '.webp']
  allowed.includes(ext) && size <= 256 * 1024
    ? ok(`icon ${pkg.icon}（${size} 字节）`)
    : bad(`icon 必须是 svg/png/jpg/jpeg/webp 且 ≤ 256 KiB，当前 ${ext} ${size} 字节`)
}

// 7. 工具：按 0.2.x 注册签名实际注册一遍
const { toolSpecs, registerTools, toParameters } = await import(pathToFileURL(path.join(ROOT, main)).href)
const dummySession = { state: 'idle', name: 'x', pid: null, lastError: null }
const dummyDeputy = { observe: () => ({}), step: () => ({}), flush: () => ({}) }
const specs = toolSpecs(dummyDeputy, dummySession)
const registered = []
const sink = registerTools({ tools: { register: (def) => registered.push(def) } }, specs)
sink.length === 0 ? ok(`${registered.length} 个工具均已注册`) : bad(`${sink.length} 个工具未注册`)
registered.length === specs.length ? ok('注册数量与 toolSpecs 一致') : bad('注册数量与 toolSpecs 不一致')

const CONCURRENCY = { deputy_sense: true, deputy_act: false, deputy_sheet: false, deputy_desktop: false }
for (const def of registered) {
  const valid =
    def.output?.schema?.type === 'object' &&
    typeof def.output?.render === 'function' &&
    typeof def.execute === 'function' &&
    def.parameters &&
    typeof def.parameters === 'object'
  valid ? ok(`${def.name}: output / parameters / execute 完整`) : bad(`${def.name}: 注册声明不完整`)
  const schemaViolations = []
  checkRawSchema(def.output?.schema, `${def.name}.output.schema`, schemaViolations)
  schemaViolations.length ? bad(`${def.name}: output schema 不合 0.2.2 子集：${schemaViolations.join('；')}`)
    : ok(`${def.name}: output schema 符合 0.2.2 子集`)
  const wantSafe = CONCURRENCY[def.name] === true
  const isSafe = typeof def.isConcurrencySafe === 'function' && def.isConcurrencySafe({}) === true
  isSafe === wantSafe ? ok(`${def.name}: isConcurrencySafe=${wantSafe}`) : bad(`${def.name}: isConcurrencySafe 应为 ${wantSafe}`)
  // 内联 required 是 0.2.x parameters 的写法：required 数组必须落到字段上
  const spec = specs.find((s) => s.name === def.name)
  const declaredRequired = spec?.inputSchema?.required ?? []
  const inline = toParameters(spec?.inputSchema)
  for (const field of declaredRequired) {
    inline?.[field]?.required === true ? null : bad(`${def.name}.parameters.${field} 缺少内联 required`)
  }
}
// 7b. parameters 是 author 字段表（不是标准 JSON Schema）：object 字段必须显式
// 声明 additionalProperties，否则真实 dsh-tools 编译参数时抛
// "parameters.x.additionalProperties must be explicitly true or false"。
function checkAuthorParams(node, where, violations) {
  if (!node || typeof node !== 'object') return
  if (node.type === 'object' && typeof node.additionalProperties !== 'boolean') {
    violations.push(`${where}.additionalProperties 必须显式声明 true/false`)
  }
  if (node.properties && typeof node.properties === 'object') {
    for (const [key, child] of Object.entries(node.properties)) checkAuthorParams(child, `${where}.${key}`, violations)
  }
  if (node.items) checkAuthorParams(node.items, `${where}.items`, violations)
}
for (const spec of specs) {
  const paramViolations = []
  checkAuthorParams({ type: 'object', additionalProperties: true, properties: spec.inputSchema?.properties ?? {} }, `${spec.name}.parameters`, paramViolations)
  paramViolations.length ? bad(`${spec.name}: 参数表会被真实 dsh-tools 拒绝：${paramViolations.join('；')}`)
    : ok(`${spec.name}: 参数表符合 author 规则`)
}

// 8. 图片：拼图必须走 attachments.saveImage + image content block
const sheet = specs.find((s) => s.name === 'deputy_sheet')
const saved = []
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
const imageTool = toolSpecs(
  { flush: async () => ({ frames: [{}, {}], budget: {}, deduped: false, png }) },
  dummySession,
  {
    saveImage: async (input) => {
      saved.push(input)
      return { attachmentId: 'att_check', mediaType: 'image/png', bytes: png.length, width: 8, height: 8, name: input.name }
    },
  },
).find((s) => s.name === 'deputy_sheet')
const value = await imageTool.handler({ reason: 'check' })
const blocks = imageTool.render({}, value)
saved[0]?.mediaType === 'image/png' ? ok('拼图走 attachments.saveImage（mediaType=image/png）') : bad('拼图未以 image/png 调 saveImage')
value.image?.attachmentId ? ok('工具结果带 ImageAttachmentRef 元数据') : bad('工具结果缺少 image 引用')
blocks.some((b) => b.type === 'image') ? ok('render 返回 image content block') : bad('render 未返回 image block')
sheet?.outputSchema?.properties?.image?.type === 'object' ? ok('deputy_sheet.output.schema 声明 image') : bad('deputy_sheet.output.schema 未声明 image')

// 8b. 一个包两个组件：cordis.patch.yml 必须有两条 insert，exports 子路径可解析
// （插件管理器里「包含的组件」按 insert 的 name 显示，billion-context 就是这么做的）
const COMPONENTS = [
  { id: 'dsh-deputy-os', name: 'dsh-deputy/os', sub: './os', file: 'src/os.mjs' },
  { id: 'dsh-deputy-browser', name: 'dsh-deputy/browser', sub: './browser', file: 'src/browser.mjs' },
]
const patchText = exists(patch) ? readFileSync(path.join(ROOT, patch), 'utf8') : ''
for (const c of COMPONENTS) {
  patchText.includes(`id: ${c.id}`) ? ok(`patch 有组件条目 ${c.id}`) : bad(`cordis.patch.yml 缺少 id: ${c.id}`)
  patchText.includes(`name: '${c.name}'`) ? ok(`patch 组件名 = ${c.name}`) : bad(`cordis.patch.yml 缺少 name: '${c.name}'`)
  const target = pkg.exports?.[c.sub]
  target && exists(target) ? ok(`exports["${c.sub}"] = ${target}`) : bad(`exports["${c.sub}"] 未声明或文件不存在`)
  target === `./${c.file}` ? null : warn(`exports["${c.sub}"] 期望指向 ./ ${c.file}`)
}
patchText.match(/^\s*-\s*insert:/gm)?.length === 1 ? ok('patch 只有一条 insert（两个组件放同一条）') : warn('patch 的 insert 条目数量不是 1')

// 8c. 浏览器组件的 5 个工具：同样要过 0.2.2 的 schema 子集与 author 参数表
const { browserToolSpecs } = await import(pathToFileURL(path.join(ROOT, 'src/browser/tools.mjs')).href)
const fakeDaemon = {
  state: 'stopped',
  status: () => ({ state: 'stopped' }),
  ensureStarted: async () => ({ state: 'running' }),
  navigate: async () => ({ ok: true }),
  observe: async () => ({ ok: true, text: '', refs: [] }),
  act: async () => ({ ok: true }),
  close: async () => {},
}
const browserSpecs = browserToolSpecs(fakeDaemon, {})
const browserRegistered = []
const browserSink = registerTools({ tools: { register: (def) => browserRegistered.push(def) } }, browserSpecs)
browserSink.length === 0 ? ok(`browser 工具全部注册（${browserRegistered.length} 个）`) : bad(`browser 有 ${browserSink.length} 个工具未注册`)
const WANT_BROWSER_TOOLS = ['browser_open', 'browser_observe', 'browser_act', 'browser_status', 'browser_close']
for (const want of WANT_BROWSER_TOOLS) {
  browserRegistered.some((d) => d.name === want) ? ok(`browser 工具 ${want} 已注册`) : bad(`browser 缺少工具 ${want}`)
}
for (const def of browserRegistered) {
  const schemaViolations = []
  checkRawSchema(def.output?.schema, `${def.name}.output.schema`, schemaViolations)
  schemaViolations.length ? bad(`${def.name}: output schema 不合 0.2.2 子集：${schemaViolations.join('；')}`)
    : ok(`${def.name}: output schema 符合 0.2.2 子集`)
  const spec = browserSpecs.find((s) => s.name === def.name)
  const paramViolations = []
  checkAuthorParams(
    { type: 'object', additionalProperties: true, properties: spec?.inputSchema?.properties ?? {} },
    `${def.name}.parameters`,
    paramViolations,
  )
  paramViolations.length ? bad(`${def.name}: 参数表会被真实 dsh-tools 拒绝：${paramViolations.join('；')}`)
    : ok(`${def.name}: 参数表符合 author 规则`)
}

// 8d. 状态总线：两个组件各自报状态，合成面板上的那个点
const status = await import(pathToFileURL(path.join(ROOT, 'src/status.mjs')).href)
status.resetStatus()
const idleLevel = status.snapshot().level
status.setOsStatus({ state: 'opened', running: true })
const runningLevel = status.snapshot().level
status.noteFailure('browser', new Error('boom'))
const errorSnapshot = status.snapshot()
status.setBrowserStatus({ error: null })
const clearedLevel = status.snapshot().level
status.resetStatus()
idleLevel === 'idle' ? ok('状态总线：初始 level=idle') : bad(`状态总线初始 level 应为 idle，实际 ${idleLevel}`)
runningLevel === 'running' ? ok('状态总线：os 运行中 level=running') : bad(`运行中 level 应为 running，实际 ${runningLevel}`)
errorSnapshot.level === 'error' && errorSnapshot.browser.error === 'boom'
  ? ok('状态总线：任一组件报错 level=error')
  : bad('状态总线：noteFailure 未把 level 推到 error')
clearedLevel === 'running' ? ok('状态总线：清错后回到 running') : bad(`清错后 level 应为 running，实际 ${clearedLevel}`)

// 9. 依赖数量仍为 0（只用 Node 内置 + react 单例）
Object.keys(pkg.dependencies ?? {}).length === 0 ? ok('运行时依赖 0 个') : warn('出现了 dependencies')

console.log(problems.length ? `\n${problems.length} 个问题` : '\n全部通过')
process.exit(problems.length ? 1 : 0)
