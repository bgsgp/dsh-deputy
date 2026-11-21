// 三层等待：导航/网络、元素、动作后的最小静默。
// 所有函数都操作 daemon 的公开状态，便于用假 CDP 做无浏览器单测。
import { browserError } from './errors.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function pendingForSession(daemon) {
  const prefix = `${daemon.pageSession}:`
  let count = 0
  for (const key of daemon.networkPending.keys()) if (key.startsWith(prefix)) count++
  return count
}

/** readyState=complete + 当前 target 网络静默；后台标签的请求不会阻塞当前页。 */
export async function waitForLoad(daemon, { timeoutMs = 10000, quietMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const ready = await daemon.evaluate('document.readyState').catch(() => 'loading')
      const quietSince = daemon.networkActivity.get(daemon.pageSession) ?? 0
      if (ready === 'complete' && pendingForSession(daemon) === 0 && Date.now() - quietSince >= quietMs) return true
    } catch (e) {
      lastError = e
    }
    await sleep(100)
  }
  throw browserError('NAV_TIMEOUT', `导航在 ${timeoutMs}ms 内没稳定${lastError ? `：${lastError.message}` : ''}`)
}

/** 等待 CSS 选择器或当前快照 ref 可见且可交互。 */
export async function waitForElement(daemon, { selector = null, ref = null, timeoutMs = 10000, visible = true } = {}) {
  if (!selector && !ref) throw browserError('BAD_ARGS', 'waitFor 需要 selector 或 ref')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (selector) {
        const expression = `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const s = getComputedStyle(el); const r = el.getBoundingClientRect(); const shown = s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity || 1) > 0 && r.width > 0 && r.height > 0; return ${visible ? 'shown' : '!shown'}; })()`
        if (await daemon.evaluate(expression)) return { ok: true, selector }
      }
      if (ref) {
        const node = daemon.nodes.get(ref)
        if (node && node.epoch === daemon.docEpoch && !node.disabled) {
          const { model } = await daemon.cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }, daemon.pageSession)
          const quad = model?.border ?? model?.content
          if (quad && quad.length >= 8) return { ok: true, ref }
        }
      }
    } catch {
      // 导航中执行脚本/取盒子会短暂失败，等到超时再分类。
    }
    await sleep(100)
  }
  throw browserError('ELEMENT_TIMEOUT', `元素在 ${timeoutMs}ms 内未就绪`, { hint: '重新 observe，或检查 selector/可见条件是否写错' })
}

/**
 * 动作后等待第一个有效信号：换代、URL、DOM/网络静默或预期文本。
 * 超时不算动作失败；只说明没有拿到更多证据。
 */
export async function settleAfterAction(daemon, { timeoutMs = 1200, quietMs = 180, expectText = null } = {}) {
  const epoch = daemon.docEpoch
  const url = daemon.lastUrl
  const started = Date.now()
  const deadline = started + timeoutMs
  while (Date.now() < deadline) {
    if (daemon.docEpoch !== epoch) return { reason: 'document-changed', elapsedMs: Date.now() - started }
    if (daemon.lastUrl !== url) return { reason: 'url-changed', elapsedMs: Date.now() - started }
    if (expectText) {
      const found = await daemon.evaluate(`document.body?.innerText?.includes(${JSON.stringify(expectText)}) ?? false`).catch(() => false)
      if (found) return { reason: 'expect-text', elapsedMs: Date.now() - started }
    }
    const domQuiet = Date.now() - (daemon.domChangedAt.get(daemon.pageSession) ?? 0) >= quietMs
    const netQuiet = Date.now() - (daemon.networkActivity.get(daemon.pageSession) ?? 0) >= quietMs
    if (Date.now() >= started + quietMs && domQuiet && netQuiet && pendingForSession(daemon) === 0) return { reason: 'quiet', elapsedMs: Date.now() - started }
    await sleep(50)
  }
  return { reason: 'timeout', elapsedMs: Date.now() - started }
}
