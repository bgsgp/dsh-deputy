// 动作（context.md 第 4、6、7 条）：ref + verb，前置自检 → 执行 → 只回差异。
//
// 骨架阶段已实现的：ref/epoch 校验（STALE_REF）、scrollIntoViewIfNeeded、box 取中心、
// 遮挡粗检（elementFromPoint）、成对 mouse 事件、Input.insertText、key、navigate、scroll。
// TODO(kimi)：
//   - disabled 判定要用 AX 的 properties，而不是只看 DOM 属性；
//   - 遮挡命中后自动找 close/dismiss 按钮（OVERLAY 分类）；
//   - 动作后的最小静默期改成「DOM 静默/URL 变化/预期元素 先到算谁」；
//   - 写动作的 expect 断言与表单指纹去重（第 7 条）。
import { browserError, wireError } from './errors.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function boxOf(daemon, node) {
  if (!node?.backendNodeId) throw browserError('STALE_REF', 'ref 里没有 backendNodeId')
  try {
    await daemon.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId }, daemon.pageSession)
  } catch {
    /* 有些节点不支持 scrollIntoView，直接读盒子 */
  }
  try {
    const { model } = await daemon.cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }, daemon.pageSession)
    const q = model.border ?? model.content
    if (!q || q.length < 8) throw new Error('box model 为空')
    const xs = [q[0], q[2], q[4], q[6]]
    const ys = [q[1], q[3], q[5], q[7]]
    const x = (Math.min(...xs) + Math.max(...xs)) / 2
    const y = (Math.min(...ys) + Math.max(...ys)) / 2
    return { x, y, w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
  } catch (e) {
    throw browserError('STALE_REF', `拿不到节点盒子：${e.message}`)
  }
}

async function hitTest(daemon, x, y) {
  const expr = `(() => { const el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)}); if (!el) return null; return { tag: el.tagName.toLowerCase(), id: el.id || '', text: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 60) } })()`
  try {
    return await daemon.evaluate(expr)
  } catch {
    return null
  }
}

async function clickAt(daemon, x, y, { button = 'left', clickCount = 1 } = {}) {
  const base = { x: Math.round(x), y: Math.round(y), button, clickCount, buttons: button === 'left' ? 1 : 2 }
  await daemon.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, daemon.pageSession)
  await daemon.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }, daemon.pageSession)
}

function resolveRef(daemon, ref) {
  if (typeof ref !== 'string' || !ref) throw browserError('BAD_ARGS', '动作需要 ref')
  const node = daemon.nodes.get(ref)
  if (!node) throw browserError('STALE_REF', `ref ${ref} 不在当前快照里`)
  if (node.epoch !== daemon.docEpoch) throw browserError('STALE_REF', `ref ${ref} 属于旧文档（epoch ${node.epoch}，当前 ${daemon.docEpoch}）`)
  return node
}

async function runOne(daemon, step) {
  const verb = step.verb ?? step.type
  switch (verb) {
    case 'navigate': {
      await daemon.navigate(step.url)
      return { verb, ok: true }
    }
    case 'wait': {
      // 骨架版只有定时等待；元素级等待见文件头 TODO
      await sleep(Number(step.ms ?? 500))
      return { verb, ok: true }
    }
    case 'reload': {
      await daemon.cdp.send('Page.reload', {}, daemon.pageSession)
      await daemon.waitForLoad()
      return { verb, ok: true }
    }
    case 'click': {
      const node = resolveRef(daemon, step.ref)
      const box = await boxOf(daemon, node)
      const hit = await hitTest(daemon, box.x, box.y)
      // 粗检遮挡：命中点的文字/ID 与 ref 的 name 完全无关时给 OVERLAY（不是硬失败，先告知）
      let overlay = null
      if (hit && node.name && !hit.text.includes(node.name.slice(0, 12)) && !(hit.id && hit.id === (step.ref ?? ''))) {
        overlay = hit
      }
      await clickAt(daemon, box.x, box.y, { button: step.button === 'right' ? 'right' : 'left' })
      return { verb, ok: true, ref: step.ref, at: [Math.round(box.x), Math.round(box.y)], overlay }
    }
    case 'hover': {
      const node = resolveRef(daemon, step.ref)
      const box = await boxOf(daemon, node)
      await daemon.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(box.x), y: Math.round(box.y) }, daemon.pageSession)
      return { verb, ok: true, ref: step.ref }
    }
    case 'type': {
      if (step.ref) {
        const node = resolveRef(daemon, step.ref)
        const box = await boxOf(daemon, node)
        await clickAt(daemon, box.x, box.y)
      }
      if (typeof step.text !== 'string') throw browserError('BAD_ARGS', 'type 需要 text')
      if (step.clear) {
        await daemon.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 }, daemon.pageSession)
        await daemon.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 }, daemon.pageSession)
        await daemon.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, daemon.pageSession)
        await daemon.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 }, daemon.pageSession)
      }
      await daemon.cdp.send('Input.insertText', { text: step.text }, daemon.pageSession)
      return { verb, ok: true, ref: step.ref ?? null, chars: step.text.length }
    }
    case 'key': {
      if (typeof step.key !== 'string') throw browserError('BAD_ARGS', 'key 需要 key 名称')
      await daemon.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: step.key }, daemon.pageSession)
      await daemon.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: step.key }, daemon.pageSession)
      return { verb, ok: true, key: step.key }
    }
    case 'scroll': {
      const dy = Number(step.deltaY ?? 600)
      await daemon.cdp.send(
        'Input.dispatchMouseEvent',
        { type: 'mouseWheel', x: 10, y: 10, deltaX: Number(step.deltaX ?? 0), deltaY: dy },
        daemon.pageSession,
      )
      return { verb, ok: true, deltaY: dy }
    }
    case 'press': {
      // 组合动作：ref 上按下再抬起（某些自定义控件只认 mousedown/mouseup 序列）
      const node = resolveRef(daemon, step.ref)
      const box = await boxOf(daemon, node)
      await daemon.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1, buttons: 1 }, daemon.pageSession)
      await sleep(Number(step.holdMs ?? 80))
      await daemon.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1, buttons: 0 }, daemon.pageSession)
      return { verb, ok: true, ref: step.ref }
    }
    default:
      throw browserError('NOT_IMPLEMENTED', `还不支持的动作 ${String(verb)}`)
  }
}

/**
 * 顺序执行一批动作；遇到布局变化（docEpoch 变了）就停在那里，把新快照交回模型。
 * 这是 context.md 第 4 条「批处理遇布局变化就停」的骨架实现。
 */
export async function runSteps(daemon, { steps = [], expect = null } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) throw browserError('BAD_ARGS', 'act 需要非空 steps 数组')
  const epochBefore = daemon.docEpoch
  const urlBefore = daemon.lastUrl
  const done = []
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    try {
      done.push(await runOne(daemon, step))
    } catch (e) {
      return { ok: false, steps: done, index: i, epochBefore, ...wireError(e) }
    }
    if (daemon.docEpoch !== epochBefore) {
      return {
        ok: true,
        stopped: 'document-changed',
        steps: done,
        remaining: steps.length - i - 1,
        diff: { url: daemon.lastUrl, epochBefore, epochAfter: daemon.docEpoch },
      }
    }
    if (step.settleMs) await sleep(Number(step.settleMs))
  }
  // 动作后最小静默期（骨架版：等 readyState 稳定）
  await daemon.waitForLoad({ timeoutMs: 5000, quietMs: 300 }).catch(() => {})
  const diff = { url: daemon.lastUrl, urlChanged: daemon.lastUrl !== urlBefore, epochBefore, epochAfter: daemon.docEpoch }
  if (expect && typeof expect === 'object') {
    try {
      const snap = await daemon.observe({ budget: 'summary' })
      const haystack = snap.text
      diff.expect = {}
      for (const [key, value] of Object.entries(expect)) {
        diff.expect[key] = haystack.includes(String(value))
        if (!diff.expect[key]) {
          return { ok: false, steps: done, diff, snapshot: snap.text, error: { code: 'AMBIGUOUS_TARGET', message: `期望「${value}」没出现在页面里`, hint: '先看 snapshot，再决定重试还是换锚点' } }
        }
      }
    } catch {
      /* expect 只做尽力校验 */
    }
  }
  return { ok: true, steps: done, diff }
}
