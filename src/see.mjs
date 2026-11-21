// 观察层（豆包式"先看控件再动手"）：把 UIA 的窗口列表/控件树压成几行文字。
//
// 与像素感测的分工：
//   - src/runner.mjs 的 sense/ROI 回答"画面变没变"（省图、判断成效）；
//   - 这里回答"屏幕上有什么、能不能点、点了哪个"（语义）。
// 纯函数，不碰 Windows，单测覆盖（test/run-tests.mjs 的 "see.mjs" 段）。

/** 默认预算：一个窗口的控件树给模型 120 行足够定位，再深就是噪声。 */
export const SEE = { depth: 3, maxNodes: 120, maxWindows: 40 }

const CONTROL = /^ControlType\./

/** 把 UIA 的 ProgrammaticName（"InvokePatternIdentifiers.Invoke"）压成短名。 */
export function shortName(programmatic) {
  if (typeof programmatic !== 'string') return ''
  const tail = programmatic.split('.').pop() ?? ''
  return CONTROL.test(programmatic) ? tail : tail.replace(/Pattern$/, '')
}

/**
 * 按"先 hwnd、再标题、再进程名"的顺序挑窗口；同分时前台窗口优先。
 * @param {Array<{hwnd:number,title?:string,process?:string,focused?:boolean}>} windows
 * @param {string|number} query
 * @returns {object|null}
 */
export function matchWindow(windows, query) {
  const list = Array.isArray(windows) ? windows : []
  if (!list.length || query == null) return null
  const q = String(query).trim()
  if (!q) return null
  const score = (w) => {
    const title = String(w.title ?? '')
    const proc = String(w.process ?? '')
    let s = 0
    // ApplicationFrameHost 只是 UWP 的外框，内容真正的窗口是另一个进程的同名窗口
    const shellFrame = proc.toLowerCase() === 'applicationframehost'
    if (String(w.hwnd) === q) s = 100
    else if (title === q) s = shellFrame ? 85 : 90
    else if (title.toLowerCase() === q.toLowerCase()) s = 88
    else if (title && title.toLowerCase().includes(q.toLowerCase())) s = 70
    else if (proc && proc.toLowerCase().includes(q.toLowerCase())) s = 50
    if (s && w.focused) s += 1
    return s
  }
  let best = null
  let bestScore = 0
  for (const w of list) {
    const s = score(w)
    if (s > bestScore) {
      best = w
      bestScore = s
    }
  }
  return best
}

/**
 * 深度优先展开控件树，节点带 path（从窗口根节点开始的子索引路径）。
 * 节点数超预算就停，并标记 truncated —— 宁少给也不给一份读不完的树。
 * @param {object} root 后端返回的节点对象（children 递归）
 * @returns {{nodes:Array<object>, truncated:boolean, total:number}}
 */
export function flattenTree(root, { maxNodes = SEE.maxNodes } = {}) {
  const nodes = []
  let total = 0
  let truncated = false
  const walk = (node, path, depth) => {
    if (!node) return
    total++
    if (nodes.length >= maxNodes) {
      truncated = true
      return
    }
    nodes.push({ path, depth, node })
    // 后端偶尔会吐出 null 占位（UIA 的虚空节点）：跳过它，但保留原始下标，
    // 否则 path 会和后端 Ref 的 children 下标错位，点击会落到别的控件上。
    const children = Array.isArray(node.children) ? node.children : []
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (!child || typeof child !== 'object') continue
      if (nodes.length >= maxNodes) {
        truncated = true
        return
      }
      walk(child, path.concat(i), depth + 1)
    }
  }
  walk(root, [], 0)
  return { nodes, truncated, total }
}

/** 一个节点的单行摘要：缩进 + 类型 + 名字 + 路径 + 可用动作 + 旗标。 */
export function formatNode({ path, depth, node }) {
  const type = shortName(node.type) || 'Node'
  const name = String(node.name ?? '').replace(/\s+/g, ' ').trim()
  const label = name ? `"${name.slice(0, 60)}"` : '(无名)'
  const bits = [`${'  '.repeat(depth)}[${type}] ${label}`]
  if (node.aid) bits.push(`aid=${node.aid}`)
  const patterns = Array.isArray(node.patterns) ? node.patterns.map(shortName).filter(Boolean) : []
  if (patterns.length) bits.push(patterns.join(','))
  const flags = []
  if (node.password) flags.push('密码框')
  if (node.enabled === false) flags.push('禁用')
  if (node.offscreen) flags.push('不可见')
  if (flags.length) bits.push(`(${flags.join('/')})`)
  bits.push(`@${path.join('.') || 'root'}`)
  return bits.join(' ')
}

/** 窗口列表的文本形（给模型看，也给人看）。 */
export function formatWindows(windows, { maxWindows = SEE.maxWindows } = {}) {
  const list = Array.isArray(windows) ? windows.slice(0, maxWindows) : []
  return list.map((w) => {
    const title = String(w.title ?? '').replace(/\s+/g, ' ').trim() || '(无标题)'
    const rect = w.rect ? ` ${w.rect.w}x${w.rect.h}` : ''
    return `#${w.hwnd} pid ${w.pid ?? '?'} ${w.process ?? '?'} "${title}"${w.focused ? ' [前台]' : ''}${rect}`
  })
}

/**
 * 把后端返回（windows / tree 两种形状）统一成给模型的文本与结构化摘要。
 * 返回对象的字段都非空可选，方便 0.2.2 的 output.schema 校验（不许 null）。
 */
export function describe(result, { maxNodes = SEE.maxNodes } = {}) {
  const out = { kind: 'windows' }
  if (Array.isArray(result?.windows)) {
    const lines = formatWindows(result.windows)
    out.kind = 'windows'
    out.count = result.windows.length
    out.lines = lines
    out.text = lines.length ? lines.join('\n') : '（没有可见的顶层窗口）'
    if (result.foreground?.title) out.foreground = String(result.foreground.title)
    return out
  }
  const window = result?.window
  const flat = flattenTree(result?.node ?? result?.tree ?? null, { maxNodes })
  const lines = flat.nodes.map(formatNode)
  out.kind = 'tree'
  out.count = flat.nodes.length
  out.truncated = flat.truncated
  out.lines = lines
  out.text = lines.length ? lines.join('\n') : '（这个窗口没有可读的控件）'
  if (window?.hwnd != null) out.hwnd = Number(window.hwnd)
  if (window?.title) out.window = String(window.title)
  if (flat.truncated) out.text += `\n…已截断：只给前 ${maxNodes} 个节点（共扫到 ${flat.total}）`
  return out
}
