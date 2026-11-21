// Windows 后端桥：把 PowerShell 侧的 UIA / 隔离桌面能力当子进程用
// 与 dsh-computer-use-win 的取舍差异：那边把 UIA 全能力铺开（上百个控件语义），
// 这边只保留闭环真正要用的 4 个原语：tree / invoke / setValue / sendInput。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS = path.resolve(HERE, '..', 'scripts')

export class UiaBridge {
  constructor({ script = path.join(SCRIPTS, 'windows-uia.ps1'), timeoutMs = 8000 } = {}) {
    this.script = script
    this.timeoutMs = timeoutMs
  }

  /** @param {object} payload 会被 JSON 序列化后经 stdin 交给 PS 脚本 */
  call(payload) {
    if (process.platform !== 'win32') {
      return Promise.reject(new Error('UIA 后端仅在 win32 可用；请在 Windows 上运行或改用 mock sensor'))
    }
    return new Promise((resolve, reject) => {
      const ps = spawn(
        'powershell.exe',
        // -STA 不能省：UIA 客户端要在 STA 线程上用（MTA 下拿控件树常常是空树或超时）
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', this.script],
        { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
      )
      let out = ''
      let err = ''
      const timer = setTimeout(() => {
        ps.kill()
        reject(new Error(`UIA 调用超时 ${this.timeoutMs}ms (op=${payload.op})`))
      }, this.timeoutMs)
      ps.stdout.on('data', (d) => (out += d))
      ps.stderr.on('data', (d) => (err += d))
      ps.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      ps.on('close', (code) => {
        clearTimeout(timer)
        if (code !== 0) {
          // 后端失败时也会吐一行 JSON（{ok:false,error}）；那条 error 比 stderr 有用得多
          let detail = null
          try {
            const parsed = JSON.parse(out)
            if (parsed && parsed.error) detail = String(parsed.error)
          } catch {
            /* 不是 JSON 就退回 stderr */
          }
          return reject(new Error(`UIA 后端退出码 ${code}: ${detail ?? err.trim().slice(0, 400)}`))
        }
        try {
          resolve(JSON.parse(out))
        } catch {
          // PS 有时会混入警告行，取最后一行 JSON
          const last = out.trim().split('\n').pop()
          try {
            resolve(JSON.parse(last))
          } catch {
            reject(new Error(`UIA 返回不是合法 JSON: ${out.slice(0, 200)}`))
          }
        }
      })
      ps.stdin.end(JSON.stringify(payload))
    })
  }

  tree({ root = 0, depth = 4, desktop = null } = {}) {
    return this.call({ op: 'tree', root, depth, desktop })
  }

  invoke(ref) {
    return this.call({ op: 'invoke', ref })
  }

  setValue(ref, text) {
    return this.call({ op: 'setValue', ref, text })
  }

  sendInput(input) {
    return this.call({ op: 'sendInput', input })
  }

  capture({ desktop = null, region = null } = {}) {
    return this.call({ op: 'capture', desktop, region })
  }

  /** 当前桌面上的可见顶层窗口（观察层的第一步：先知道有什么）。 */
  windows() {
    return this.call({ op: 'windows' })
  }

  /** 取一个窗口的控件树；定位窗口用 hwnd / title / process 之一。 */
  see({ hwnd, title, process: proc, depth, maxNodes } = {}) {
    const payload = { op: 'tree' }
    if (typeof hwnd === 'number' && hwnd > 0) payload.hwnd = hwnd
    if (title) payload.title = title
    if (proc) payload.process = proc
    if (typeof depth === 'number') payload.depth = depth
    if (typeof maxNodes === 'number') payload.maxNodes = maxNodes
    return this.call(payload)
  }

  /** 语义动作：按控件路径 invoke/setValue/click/focus。 */
  act({ hwnd, title, process: proc, path, action, text: value } = {}) {
    const payload = { op: 'act', action: action ?? 'invoke', ref: { path: Array.isArray(path) ? path : [] } }
    if (typeof hwnd === 'number' && hwnd > 0) payload.hwnd = hwnd
    if (title) payload.title = title
    if (proc) payload.process = proc
    if (value != null) payload.text = String(value)
    return this.call(payload)
  }
}

/** 把 uia-bridge 包成 runner 需要的 actuator */
export function createUiaActuator(bridge) {
  return {
    async perform(a) {
      switch (a.kind) {
        case 'uia':
          if (a.payload.op === 'invoke') return bridge.invoke(a.payload.ref)
          if (a.payload.op === 'setValue') return bridge.setValue(a.payload.ref, a.payload.text)
          throw new Error(`未知 UIA 动作 ${a.payload.op}`)
        case 'input':
          return bridge.sendInput(a.payload)
        case 'shell':
          return bridge.call({ op: 'shell', payload: a.payload })
        case 'wait':
          await new Promise((r) => setTimeout(r, a.payload.ms))
          return null
        default:
          throw new Error(`未知动作类型 ${a.kind}`)
      }
    },
  }
}

/** 把 capture 包成 runner 需要的 sensor */
export function createWindowsSensor(bridge, { channels = 4 } = {}) {
  return {
    async capture() {
      const r = await bridge.capture()
      // PS 侧返回 base64 灰度图；这里假设已转为 {gray,w,h}
      return { gray: Uint8Array.from(Buffer.from(r.grayBase64, 'base64')), width: r.width, height: r.height, channels }
    },
  }
}
