// 观察（context.md 第 3 条）：一次往返拿到「够模型决策」的结构快照。
//
// 数据源配比：
//   DOMSnapshot.captureSnapshot —— DOM + 每个节点的 layout quad + 关键计算样式（一次拿全）
//   Accessibility.getFullAXTree —— 语义角色与可读名（补 DOM 看不出来的角色/名称）
//
// 剪枝：零/负尺寸、display:none、visibility:hidden、opacity:0、aria-hidden、被 AX 判为 ignored。
// 排序：视口内 > 视口外；可交互 > 静态。
// 渲染：一行一节点「缩进 + ref + role + 可读名 + 当前值/状态位」。
// 预算：budget=summary 只给结构摘要 + 视口内明细；budget=full 给全部（由模型用 within= 二次展开）。
//
// 骨架阶段已知粗糙的地方（TODO(kimi)）：
//   - text 只取 nodeValue，不合并行内文本，长文本会截断；
//   - iframe 内容不展开（OOPIF 需要 Target.setAutoAttach）；
//   - shadow DOM 里的可交互元素在 AX 树里能看到，但 ref 解析依赖 DOMSnapshot 的 backendNodeId 对齐。
import { browserError } from './errors.mjs'

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
])

const SKIP_NAME = new Set(['html', 'head', 'script', 'style', 'meta', 'link', 'noscript', 'template'])

const clip = (s, n = 72) => (typeof s === 'string' && s.length > n ? s.slice(0, n - 1) + '…' : s ?? '')

function attrsOf(node, attributes) {
  const out = {}
  const list = attributes?.[node] ?? []
  for (let i = 0; i + 1 < list.length; i += 2) out[list[i]] = list[i + 1]
  return out
}

function styleOf(doc, layoutIndex) {
  const styles = doc.layout?.styles
  if (!styles) return {}
  const keys = styles.computedStyle ?? []
  const raw = styles.computedStyleValues?.[layoutIndex] ?? []
  const out = {}
  for (let i = 0; i < keys.length; i++) out[keys[i]] = raw[i]
  return out
}

export async function buildSnapshot(daemon, { within = null, budget = 'summary', types = null } = {}) {
  const cdp = daemon.cdp
  const sid = daemon.pageSession
  if (!cdp || !sid) throw browserError('NOT_RUNNING', '浏览器还没启动')

  const [{ documents = [] }, ax] = await Promise.all([
    cdp.send(
      'DOMSnapshot.captureSnapshot',
      {
        computedStyles: ['display', 'visibility', 'opacity', 'cursor', 'overflow'],
        includePaintOrder: true,
        includeDOMRects: true,
      },
      sid,
    ),
    cdp.send('Accessibility.getFullAXTree', {}, sid).catch(() => ({ nodes: [] })),
  ])

  const doc = documents[0]
  if (!doc) throw browserError('CDP_ERROR', 'DOMSnapshot 没返回文档（页面可能还没加载）')

  const axByBackend = new Map()
  for (const n of ax.nodes ?? []) {
    const id = n.backendDOMNodeId
    if (!id) continue
    const role = n.role?.value ?? ''
    const name = n.name?.value ?? ''
    axByBackend.set(id, { role, name, ignored: Boolean(n.ignored) })
  }

  const viewport = await daemon
    .evaluate(`(() => ({ w: innerWidth, h: innerHeight, url: location.href, title: document.title }))()`)
    .catch(() => ({ w: 0, h: 0, url: daemon.lastUrl, title: '' }))

  const nodes = doc.nodes ?? {}
  const backendIds = nodes.backendNodeId ?? []
  const parentIndex = nodes.parentIndex ?? []
  const nodeName = nodes.nodeName ?? []
  const nodeValue = nodes.nodeValue ?? []
  const attributes = nodes.attributes
  const layout = doc.layout ?? {}
  const layoutNodes = layout.nodeIndex ?? []
  const bounds = layout.bounds ?? []

  // 只保留有 layout 盒子、可见、非装饰的节点；顺便算缩进深度。
  // ref 的代数必须等于 daemon.docEpoch：ref 只在「生成它的那一代文档」里有效，
  // 一旦 frameNavigated / documentUpdated 让 docEpoch 前进，旧 ref 立即 STALE_REF。
  const epoch = daemon.docEpoch
  const kept = []
  const refOf = new Map() // nodeIndex -> ref

  function depthOf(index) {
    let d = 0
    let cur = index
    while (cur >= 0 && d < 40) {
      const p = parentIndex[cur]
      if (p === undefined || p < 0) break
      cur = p
      d++
    }
    return d
  }

  for (let i = 0; i < layoutNodes.length; i++) {
    const nodeIndex = layoutNodes[i]
    const quad = bounds[i]
    if (!quad || quad.length < 4) continue
    const [x, y, w, h] = quad
    if (!(w > 0 && h > 0)) continue
    const tag = String(nodeName[nodeIndex] ?? '').toLowerCase()
    if (SKIP_NAME.has(tag)) continue
    const backendId = backendIds[nodeIndex]
    const axInfo = axByBackend.get(backendId) ?? null
    if (axInfo?.ignored && !axInfo.name) continue
    const style = styleOf(doc, i)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') continue
    if (style.opacity !== undefined && Number(style.opacity) === 0) continue
    const attrs = attrsOf(nodeIndex, attributes)
    if (attrs['aria-hidden'] === 'true') continue
    if (within) {
      const target = String(within)
      const hit = (attrs.id ?? '') === target || (axInfo?.name ?? '').includes(target)
      if (!hit) continue
    }
    const role = axInfo?.role || tag || 'generic'
    const name = clip(axInfo?.name || attrs['aria-label'] || attrs.title || nodeValue[nodeIndex] || '', 64)
    if (!name && role === 'generic' && !INTERACTIVE_ROLES.has(role)) {
      // 无名又不可交互的容器不占行，避免刷屏
      if (!['input', 'textarea', 'select', 'a', 'button'].includes(tag)) continue
    }
    if (types && Array.isArray(types) && !types.includes(role)) continue
    const onScreen = viewport.w > 0 ? x < viewport.w && y < viewport.h && x + w > 0 && y + h > 0 : true
    kept.push({
      nodeIndex,
      tag,
      role,
      name,
      // 元素节点的 nodeValue 是 -1 这类数字，只有文本节点的值才有意义
      value: typeof nodeValue[nodeIndex] === 'string' ? clip(nodeValue[nodeIndex], 40) : '',
      attrs,
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
      onScreen,
      depth: depthOf(nodeIndex),
      interactive: INTERACTIVE_ROLES.has(role) || ['input', 'textarea', 'select', 'a', 'button'].includes(tag),
    })
  }

  // 视口内优先，其次可交互，最后按文档顺序（保持稳定可读）
  kept.sort((a, b) => {
    if (a.onScreen !== b.onScreen) return a.onScreen ? -1 : 1
    if (a.interactive !== b.interactive) return a.interactive ? -1 : 1
    return 0
  })

  const limit = budget === 'full' ? kept.length : Math.max(60, Math.min(240, kept.length))
  const shown = kept.slice(0, limit)

  daemon.nodes.clear()
  const lines = []
  lines.push(
    `页面：${viewport.url || daemon.lastUrl || 'about:blank'}${viewport.title ? ` · ${clip(viewport.title, 60)}` : ''}` +
      ` · 视口 ${viewport.w}x${viewport.h} · epoch ${epoch}`,
  )
  lines.push(`可见节点 ${kept.length}，本屏列出 ${shown.length}${budget === 'full' ? '（full）' : '（summary；需要更多用 within= 或 budget=full）'}`)

  for (const n of shown) {
    const ref = `e${epoch}.${n.nodeIndex}`
    daemon.nodes.set(ref, { backendNodeId: backendIds[n.nodeIndex], epoch, nodeIndex: n.nodeIndex, role: n.role, name: n.name, box: [n.x, n.y, n.w, n.h] })
    refOf.set(n.nodeIndex, ref)
    const indent = '  '.repeat(Math.min(12, Math.max(0, n.depth - 1)))
    const state = []
    if (n.attrs.disabled === '' || n.attrs['aria-disabled'] === 'true') state.push('disabled')
    if (n.attrs.checked !== undefined || n.attrs['aria-checked'] !== undefined) state.push(`checked=${n.attrs.checked ?? n.attrs['aria-checked']}`)
    if (n.attrs.href) state.push(clip(n.attrs.href, 48))
    if (!n.onScreen) state.push('off-screen')
    const boxText = `@${n.x},${n.y} ${n.w}x${n.h}`
    lines.push(`${indent}[${ref}] ${n.role}${n.name ? ` "${n.name}"` : ''}${n.value ? ` = "${n.value}"` : ''} ${boxText}${state.length ? ' · ' + state.join(' ') : ''}`)
  }

  const text = lines.join('\n')
  return {
    ok: true,
    text,
    refs: shown.map((n) => ({ ref: refOf.get(n.nodeIndex), role: n.role, name: n.name, box: [n.x, n.y, n.w, n.h], onScreen: n.onScreen })),
    state: { url: viewport.url ?? daemon.lastUrl, title: viewport.title ?? '', docEpoch: epoch, listed: shown.length, visible: kept.length },
  }
}
