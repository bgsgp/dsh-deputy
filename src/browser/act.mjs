// 动作：ref 校验 → 可达性/遮挡检查 → 执行 → 最小等待 → 结构化差异。
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { browserError, wireError } from './errors.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const clamp = (value, min, max, fallback) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Number(value) : fallback))

export function resolveRef(daemon, ref) {
  if (typeof ref !== 'string' || !ref) throw browserError('BAD_ARGS', '动作需要 ref')
  const node = daemon.nodes.get(ref)
  if (!node) throw browserError('STALE_REF', `ref ${ref} 不在当前快照里`)
  if (node.epoch !== daemon.docEpoch) throw browserError('STALE_REF', `ref ${ref} 属于旧文档（epoch ${node.epoch}，当前 ${daemon.docEpoch}）`)
  return node
}

export async function boxOf(daemon, node) {
  if (!node?.backendNodeId) throw browserError('STALE_REF', 'ref 里没有 backendNodeId')
  await daemon.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node.backendNodeId }, daemon.pageSession).catch(() => {})
  try {
    const { model } = await daemon.cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }, daemon.pageSession)
    const q = model?.border ?? model?.content
    if (!q || q.length < 8) throw new Error('box model 为空')
    const xs = [q[0], q[2], q[4], q[6]]
    const ys = [q[1], q[3], q[5], q[7]]
    return {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    }
  } catch (e) {
    throw browserError('STALE_REF', `拿不到节点盒子：${e.message}`)
  }
}

export async function clickAt(daemon, x, y, { button = 'left', clicks = 1 } = {}) {
  for (let i = 0; i < clicks; i++) {
    const clickCount = i + 1
    const base = { x: Math.round(x), y: Math.round(y), button, clickCount, buttons: button === 'left' ? 1 : 2 }
    await daemon.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed' }, daemon.pageSession)
    await daemon.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }, daemon.pageSession)
  }
}

/** 用真实命中节点判断是否遮挡，不再靠文字猜测。 */
async function hitTest(daemon, node, x, y) {
  let objectId = null
  try {
    const resolved = await daemon.cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId }, daemon.pageSession)
    objectId = resolved?.object?.objectId
    if (!objectId) return null // 精简 mock / 旧 target：保留兼容，不伪造命中结论
    const result = await daemon.cdp.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function(point) {
          const hit = document.elementFromPoint(Math.round(point.x), Math.round(point.y));
          if (!hit) return { owns: false, hit: null };
          return {
            owns: hit === this || this.contains(hit),
            hit: {
              tag: hit.tagName.toLowerCase(),
              id: hit.id || '',
              role: hit.getAttribute('role') || '',
              text: (hit.getAttribute('aria-label') || hit.textContent || '').trim().slice(0, 80)
            }
          };
        }`,
        arguments: [{ value: { x, y } }],
        returnByValue: true,
      },
      daemon.pageSession,
    )
    return result?.result?.value ?? null
  } catch (e) {
    throw browserError('CDP_ERROR', `遮挡命中检查失败：${e.message}`)
  } finally {
    if (objectId) await daemon.cdp.send('Runtime.releaseObject', { objectId }, daemon.pageSession).catch(() => {})
  }
}

/** 只自动点明确的关闭/取消控件；绝不把“确定/支付/发布”当遮挡处理。 */
async function findDismissButton(daemon) {
  return daemon
    .evaluate(`(() => {
      const visible = (el) => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0; };
      const dialogs = [...document.querySelectorAll('[role="dialog"],dialog,[aria-modal="true"],.modal,.el-dialog,.ant-modal')].filter(visible);
      const root = dialogs.at(-1);
      if (!root) return null;
      const pattern = /^(close|dismiss|cancel|关闭|取消|知道了|稍后|以后再说|×|✕)$/i;
      const candidates = [...root.querySelectorAll('button,[role="button"],a,[aria-label]')].filter(visible);
      for (const el of candidates) {
        const label = (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim();
        if (!pattern.test(label) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: label.slice(0, 60) };
      }
      return null;
    })()`)
    .catch(() => null)
}

function assertEnabled(node, verb) {
  if (node.disabled) throw browserError('DISABLED', `${verb} 的目标已禁用：${node.name || node.role || 'unnamed'}`)
  if (verb === 'type' && node.readonly) throw browserError('DISABLED', '输入目标是只读的')
}

async function clickNode(daemon, step, { holdMs = null } = {}) {
  const node = resolveRef(daemon, step.ref)
  assertEnabled(node, step.verb ?? 'click')
  let box = await boxOf(daemon, node)
  let hit = await hitTest(daemon, node, box.x, box.y)
  if (hit && hit.owns === false) {
    const dismiss = step.dismissOverlay === false ? null : await findDismissButton(daemon)
    if (dismiss) {
      await clickAt(daemon, dismiss.x, dismiss.y)
      await sleep(120)
      box = await boxOf(daemon, node)
      hit = await hitTest(daemon, node, box.x, box.y)
    }
    if (hit && hit.owns === false) {
      throw browserError('OVERLAY', `目标被 ${hit.hit?.tag || '其他元素'} 遮挡${hit.hit?.text ? `：${hit.hit.text}` : ''}`)
    }
  }
  if (holdMs === null) {
    await clickAt(daemon, box.x, box.y, { button: step.button === 'right' ? 'right' : 'left', clicks: clamp(step.clicks, 1, 3, 1) })
  } else {
    const base = { x: Math.round(box.x), y: Math.round(box.y), button: 'left', clickCount: 1 }
    await daemon.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 }, daemon.pageSession)
    await sleep(holdMs)
    await daemon.cdp.send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 }, daemon.pageSession)
  }
  return { node, box }
}

const MODIFIERS = new Map([
  ['alt', { bit: 1, key: 'Alt', code: 'AltLeft', vk: 18 }],
  ['ctrl', { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 }],
  ['control', { bit: 2, key: 'Control', code: 'ControlLeft', vk: 17 }],
  ['meta', { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 }],
  ['cmd', { bit: 4, key: 'Meta', code: 'MetaLeft', vk: 91 }],
  ['shift', { bit: 8, key: 'Shift', code: 'ShiftLeft', vk: 16 }],
])
const SPECIAL_KEYS = new Map([
  ['enter', ['Enter', 'Enter', 13]],
  ['esc', ['Escape', 'Escape', 27]],
  ['escape', ['Escape', 'Escape', 27]],
  ['tab', ['Tab', 'Tab', 9]],
  ['backspace', ['Backspace', 'Backspace', 8]],
  ['delete', ['Delete', 'Delete', 46]],
  ['space', [' ', 'Space', 32]],
  ['arrowup', ['ArrowUp', 'ArrowUp', 38]],
  ['arrowdown', ['ArrowDown', 'ArrowDown', 40]],
  ['arrowleft', ['ArrowLeft', 'ArrowLeft', 37]],
  ['arrowright', ['ArrowRight', 'ArrowRight', 39]],
])

function keyInfo(raw) {
  const lower = raw.toLowerCase()
  const special = SPECIAL_KEYS.get(lower)
  if (special) return { key: special[0], code: special[1], windowsVirtualKeyCode: special[2] }
  if (/^[a-z]$/i.test(raw)) return { key: raw, code: `Key${raw.toUpperCase()}`, windowsVirtualKeyCode: raw.toUpperCase().charCodeAt(0) }
  if (/^[0-9]$/.test(raw)) return { key: raw, code: `Digit${raw}`, windowsVirtualKeyCode: raw.charCodeAt(0) }
  return { key: raw, code: raw, windowsVirtualKeyCode: 0 }
}

async function keyCombo(daemon, combo) {
  if (typeof combo !== 'string' || !combo.trim()) throw browserError('BAD_ARGS', 'key 需要 key 名称或 Ctrl+A 组合')
  const parts = combo.split('+').map((s) => s.trim()).filter(Boolean)
  const main = parts.pop()
  if (!main) throw browserError('BAD_ARGS', 'key 组合缺少主键')
  const mods = []
  let modifiers = 0
  for (const part of parts) {
    const mod = MODIFIERS.get(part.toLowerCase())
    if (!mod) throw browserError('BAD_ARGS', `未知修饰键：${part}`)
    if (!mods.some((m) => m.bit === mod.bit)) {
      mods.push(mod)
      modifiers |= mod.bit
    }
  }
  for (const mod of mods) {
    await daemon.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: mod.key, code: mod.code, windowsVirtualKeyCode: mod.vk, modifiers }, daemon.pageSession)
  }
  const info = keyInfo(main)
  await daemon.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...info, modifiers }, daemon.pageSession)
  await daemon.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...info, modifiers }, daemon.pageSession)
  for (const mod of mods.reverse()) {
    modifiers &= ~mod.bit
    await daemon.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: mod.key, code: mod.code, windowsVirtualKeyCode: mod.vk, modifiers }, daemon.pageSession)
  }
}

async function selectOption(daemon, step) {
  if (step.value === undefined && step.label === undefined) throw browserError('BAD_ARGS', 'select 需要 value 或 label')
  const node = resolveRef(daemon, step.ref)
  assertEnabled(node, 'select')
  const resolved = await daemon.cdp.send('DOM.resolveNode', { backendNodeId: node.backendNodeId }, daemon.pageSession)
  const objectId = resolved?.object?.objectId
  if (!objectId) throw browserError('CDP_ERROR', 'select 无法解析目标节点')
  try {
    const result = await daemon.cdp.send(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: `function(value, label) {
          if (this.tagName !== 'SELECT') throw new Error('目标不是 select');
          const option = [...this.options].find((o) => value !== null ? o.value === value : o.label === label || o.textContent.trim() === label);
          if (!option) throw new Error('没有匹配的 option');
          this.value = option.value;
          this.dispatchEvent(new Event('input', { bubbles: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return { value: option.value, label: option.label || option.textContent.trim() };
        }`,
        arguments: [{ value: step.value ?? null }, { value: step.label ?? null }],
        returnByValue: true,
      },
      daemon.pageSession,
    )
    if (result?.exceptionDetails) throw browserError('BAD_ARGS', result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'select 失败')
    return result?.result?.value
  } finally {
    await daemon.cdp.send('Runtime.releaseObject', { objectId }, daemon.pageSession).catch(() => {})
  }
}

async function runOne(daemon, step) {
  const verb = step.verb ?? step.type
  switch (verb) {
    case 'navigate':
      await daemon.navigate(step.url)
      return { verb, ok: true, url: step.url }
    case 'wait':
      await sleep(clamp(step.ms, 0, 120000, 500))
      return { verb, ok: true }
    case 'waitFor': {
      const result = await daemon.waitForElement({
        selector: step.selector ?? null,
        ref: step.ref ?? null,
        timeoutMs: clamp(step.timeoutMs, 0, 120000, 10000),
        visible: step.visible !== false,
      })
      return { verb, ok: true, ...result }
    }
    case 'reload':
      await daemon.cdp.send('Page.reload', {}, daemon.pageSession)
      await daemon.waitForLoad()
      return { verb, ok: true }
    case 'click': {
      const { box } = await clickNode(daemon, step)
      return { verb, ok: true, ref: step.ref, at: [Math.round(box.x), Math.round(box.y)] }
    }
    case 'press': {
      await clickNode(daemon, step, { holdMs: clamp(step.holdMs, 0, 10000, 80) })
      return { verb, ok: true, ref: step.ref }
    }
    case 'hover': {
      const node = resolveRef(daemon, step.ref)
      assertEnabled(node, 'hover')
      const box = await boxOf(daemon, node)
      await daemon.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(box.x), y: Math.round(box.y) }, daemon.pageSession)
      return { verb, ok: true, ref: step.ref }
    }
    case 'type': {
      if (typeof step.text !== 'string') throw browserError('BAD_ARGS', 'type 需要 text')
      if (step.ref) {
        const node = resolveRef(daemon, step.ref)
        assertEnabled(node, 'type')
        await clickNode(daemon, { ...step, verb: 'click', clicks: 1 })
      }
      if (step.clear) {
        await keyCombo(daemon, 'Ctrl+A')
        await keyCombo(daemon, 'Backspace')
      }
      await daemon.cdp.send('Input.insertText', { text: step.text }, daemon.pageSession)
      return { verb, ok: true, ref: step.ref ?? null, chars: step.text.length }
    }
    case 'key':
      await keyCombo(daemon, step.key)
      return { verb, ok: true, key: step.key }
    case 'scroll': {
      let x = Number(step.x ?? 10)
      let y = Number(step.y ?? 10)
      if (step.ref) {
        const box = await boxOf(daemon, resolveRef(daemon, step.ref))
        x = box.x
        y = box.y
      }
      await daemon.cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Math.round(x), y: Math.round(y),
        deltaX: Number(step.deltaX ?? 0), deltaY: Number(step.deltaY ?? 600),
      }, daemon.pageSession)
      return { verb, ok: true, deltaX: Number(step.deltaX ?? 0), deltaY: Number(step.deltaY ?? 600) }
    }
    case 'select':
      return { verb, ok: true, ref: step.ref, selected: await selectOption(daemon, step) }
    case 'tab': {
      const op = step.op ?? 'list'
      if (op === 'list') return { verb, ok: true, targets: await daemon.listTargets() }
      if (op === 'new') return { verb, ...await daemon.newTarget(step.url ?? 'about:blank') }
      if (op === 'switch') return { verb, ...await daemon.switchTarget(step.targetId) }
      if (op === 'close') return { verb, ...await daemon.closeTarget(step.targetId ?? daemon.targetId) }
      throw browserError('BAD_ARGS', `未知标签操作：${op}`)
    }
    case 'upload': {
      const node = resolveRef(daemon, step.ref)
      assertEnabled(node, 'upload')
      if (!Array.isArray(step.files) || !step.files.length) throw browserError('BAD_ARGS', 'upload 需要非空 files 数组')
      const files = step.files.map((file) => {
        if (typeof file !== 'string' || !path.isAbsolute(file)) throw browserError('BAD_ARGS', 'upload 文件必须是绝对路径')
        if (!existsSync(file) || !statSync(file).isFile()) throw browserError('BAD_ARGS', `上传文件不存在：${file}`)
        return path.normalize(file)
      })
      await daemon.cdp.send('DOM.setFileInputFiles', { backendNodeId: node.backendNodeId, files }, daemon.pageSession)
      return { verb, ok: true, ref: step.ref, files }
    }
    case 'download': {
      const before = new Set(daemon.downloads.keys())
      if (step.ref) await clickNode(daemon, { ...step, verb: 'click' })
      else if (step.url) {
        if (!/^https?:\/\//i.test(step.url)) throw browserError('BAD_ARGS', 'download.url 只接受 http/https；blob 或页面内下载请用 ref')
        await daemon.evaluate(`(() => { const a = document.createElement('a'); a.href = ${JSON.stringify(step.url)}; a.download = ''; a.style.display = 'none'; document.body.appendChild(a); a.click(); a.remove(); return true; })()`)
      } else throw browserError('BAD_ARGS', 'download 需要 ref 或 url')
      const file = await daemon.waitForDownload(before, { timeoutMs: clamp(step.timeoutMs, 100, 120000, 30000) })
      return { verb, ok: true, file }
    }
    default:
      throw browserError('NOT_IMPLEMENTED', `还不支持的动作 ${String(verb)}`)
  }
}

async function checkExpect(daemon, expect) {
  if (!expect || typeof expect !== 'object') return { ok: true, details: null }
  const details = {}
  if (expect.urlIncludes !== undefined) {
    details.urlIncludes = daemon.lastUrl?.includes(String(expect.urlIncludes)) ?? false
    if (!details.urlIncludes) return { ok: false, details, message: `URL 不包含「${expect.urlIncludes}」` }
  }
  if (expect.selector !== undefined) {
    details.selector = await daemon.evaluate(`Boolean(document.querySelector(${JSON.stringify(String(expect.selector))}))`).catch(() => false)
    if (!details.selector) return { ok: false, details, message: `选择器「${expect.selector}」不存在` }
  }
  const texts = []
  if (expect.text !== undefined) texts.push(...(Array.isArray(expect.text) ? expect.text : [expect.text]))
  const legacy = Object.entries(expect).filter(([key]) => !['urlIncludes', 'selector', 'text'].includes(key))
  texts.push(...legacy.map(([, value]) => value))
  if (texts.length) {
    const snapshot = await daemon.observe({ budget: 'summary' })
    for (const value of texts) {
      const found = snapshot.text.includes(String(value))
      details[String(value)] = found
      if (!found) return { ok: false, details, snapshot: snapshot.text, message: `期望「${value}」没出现在页面里` }
    }
  }
  return { ok: true, details }
}

export async function runSteps(daemon, { steps = [], expect = null } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) throw browserError('BAD_ARGS', 'act 需要非空 steps 数组')
  const epochBefore = daemon.docEpoch
  const urlBefore = daemon.lastUrl
  const done = []
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]
    try {
      if (!step || typeof step !== 'object') throw browserError('BAD_ARGS', `第 ${i + 1} 步不是对象`)
      if (['external', 'irreversible'].includes(step.risk) && step.confirmed !== true) {
        throw browserError('CONFIRM_REQUIRED', `第 ${i + 1} 步标记为 ${step.risk}，需要 confirmed=true`)
      }
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
    if (step.settleMs) await sleep(clamp(step.settleMs, 0, 120000, 0))
  }
  const expectText = typeof expect?.text === 'string' ? expect.text : null
  const settled = daemon.settle
    ? await daemon.settle({ timeoutMs: 1200, quietMs: 180, expectText })
    : await daemon.waitForLoad({ timeoutMs: 5000, quietMs: 300 }).then(() => ({ reason: 'load' })).catch(() => ({ reason: 'timeout' }))
  const diff = { url: daemon.lastUrl, urlChanged: daemon.lastUrl !== urlBefore, epochBefore, epochAfter: daemon.docEpoch, settled }
  const expected = await checkExpect(daemon, expect).catch((e) => ({ ok: false, message: e.message, details: null }))
  diff.expect = expected.details
  if (!expected.ok) {
    return {
      ok: false,
      steps: done,
      diff,
      snapshot: expected.snapshot,
      error: { code: 'EXPECT_FAILED', message: expected.message, hint: '先重新 observe，确认动作是否部分生效；不要原样重放写操作' },
    }
  }
  return { ok: true, steps: done, diff }
}
