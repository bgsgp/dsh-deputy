// DESKTOP 层：一个真正活着的虚拟桌面会话
//
// Windows 桌面对象由常驻宿主持有；这里负责它的进程协议与生命周期。
// 生命周期： idle → opened → running → closed
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPTS = path.resolve(HERE, '..', 'scripts')

export class DesktopError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'DesktopError'
    this.code = code
  }
}

/** 常驻宿主：一行 JSON 一条命令，一行 JSON 一条回执。 */
export function createHostTransport({ script = path.join(SCRIPTS, 'windows-desktop.ps1'), timeoutMs = 12000 } = {}) {
  let child = null
  let seq = 0
  const waiting = new Map()

  function rejectAll(err) {
    for (const p of waiting.values()) p.reject(err)
    waiting.clear()
  }

  function start(name) {
    if (process.platform !== 'win32') {
      return Promise.reject(new DesktopError('虚拟桌面宿主仅在 win32 可用', 'ENOPLATFORM'))
    }
    if (child) return Promise.reject(new DesktopError('宿主已经启动', 'EHOSTRUNNING'))

    const proc = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Op', 'host', '-Name', name],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    child = proc
    proc.stdout.setEncoding('utf8')
    let buf = ''
    proc.stdout.on('data', (chunk) => {
      buf += chunk
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const msg = JSON.parse(line)
          const p = waiting.get(msg.id)
          if (p) {
            waiting.delete(msg.id)
            msg.ok ? p.resolve(msg) : p.reject(new DesktopError(msg.error ?? 'host error', msg.code))
          }
        } catch {
          /* PowerShell 的非协议输出忽略 */
        }
      }
    })
    // 必须监听 error：可执行文件缺失时，未监听的 spawn error 会让整个 Node 进程退出。
    proc.on('error', (err) => {
      rejectAll(new DesktopError(`宿主启动失败: ${err.message}`, 'ESPAWN'))
      if (child === proc) child = null
    })
    proc.on('exit', (code) => {
      rejectAll(new DesktopError(`宿主退出 ${code}`, 'EHOSTEXIT'))
      if (child === proc) child = null
    })
    return request({ op: 'create', name })
  }

  function request(payload) {
    const proc = child
    if (!proc) return Promise.reject(new DesktopError('宿主未启动', 'ENOHOST'))
    const id = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id)
        reject(new DesktopError(`宿主无响应 (${payload.op})`, 'ETIMEOUT'))
      }, timeoutMs)
      waiting.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      try {
        proc.stdin.write(JSON.stringify({ ...payload, id }) + '\n', (err) => {
          if (!err) return
          const p = waiting.get(id)
          waiting.delete(id)
          p?.reject(new DesktopError(`写入宿主失败: ${err.message}`, 'EWRITE'))
        })
      } catch (err) {
        const p = waiting.get(id)
        waiting.delete(id)
        p?.reject(new DesktopError(`写入宿主失败: ${err.message}`, 'EWRITE'))
      }
    })
  }

  function stop() {
    const proc = child
    if (!proc) return
    child = null
    rejectAll(new DesktopError('宿主已停止', 'ECLOSED'))
    try {
      proc.stdin.end()
      proc.kill()
    } catch {
      /* 已退出 */
    }
  }

  return { start, request, stop }
}

/** 内存假宿主：非 Windows 也能测状态机与 HTTP 数据面。 */
export function createFakeTransport() {
  const state = { desktop: null, pid: null, frames: 0, inputs: 0, closed: false, starts: 0 }
  return {
    state,
    start: async (name) => {
      state.starts++
      state.closed = false
      state.desktop = name
      return { ok: true, desktop: name }
    },
    request: async (payload) => {
      if (state.closed) throw new DesktopError('会话已关闭', 'ECLOSED')
      switch (payload.op) {
        case 'launch':
          state.pid = (state.pid ?? 4320) + 1
          return { ok: true, pid: state.pid }
        case 'capture': {
          state.frames++
          const w = 32
          const h = 24
          const gray = new Uint8Array(w * h).fill(200)
          return { ok: true, width: w, height: h, grayBase64: Buffer.from(gray).toString('base64') }
        }
        case 'tree':
          return { ok: true, tree: { name: 'deputy-desktop', type: 'Pane', children: [] } }
        case 'input':
          state.inputs++
          return { ok: true }
        default:
          return { ok: true }
      }
    },
    stop: () => {
      state.closed = true
    },
  }
}

export class DesktopSession {
  constructor({ transport, name, captureWidth = 1280, captureHeight = 800 } = {}) {
    this.transport = transport ?? createHostTransport()
    this.name = name ?? `deputy-${Math.random().toString(16).slice(2, 8)}`
    this.state = 'idle'
    this.pid = null
    this.lastError = null
    this.captureWidth = captureWidth
    this.captureHeight = captureHeight
    this._opening = null
    this._closing = null
  }

  assertActive(action = '操作') {
    if (this.state === 'closed') throw new DesktopError('会话已关闭', 'ECLOSED')
    if (this.state !== 'opened' && this.state !== 'running') {
      throw new DesktopError(`${action} 需要已打开的桌面，当前 ${this.state}`, 'ESTATE')
    }
  }

  async open() {
    if (this._opening) return this._opening
    if (this.state !== 'idle') throw new DesktopError(`open 只能在 idle 时调用，当前 ${this.state}`, 'ESTATE')
    const opening = (async () => {
      try {
        await this.transport.start(this.name)
        this.state = 'opened'
        this.lastError = null
        return this
      } catch (err) {
        this.lastError = err
        this.transport.stop()
        throw err
      }
    })()
    this._opening = opening
    try {
      return await opening
    } finally {
      if (this._opening === opening) this._opening = null
    }
  }

  /** 在隔离桌面里启动程序；running 时也允许再开其它程序。 */
  async startApp(exe, args = []) {
    this.assertActive('startApp')
    if (typeof exe !== 'string' || !exe.trim()) throw new DesktopError('startApp 需要非空 exe', 'EARGS')
    if (!Array.isArray(args) || args.some((v) => typeof v !== 'string')) {
      throw new DesktopError('args 必须是字符串数组', 'EARGS')
    }
    const r = await this.transport.request({ op: 'launch', exe: exe.trim(), args: args.join(' '), desktop: this.name })
    this.pid = r.pid ?? this.pid
    this.state = 'running'
    return r
  }

  async capture(region) {
    this.assertActive('capture')
    const r = await this.transport.request({ op: 'capture', desktop: this.name, region: region ?? null })
    const width = r.width ?? this.captureWidth
    const height = r.height ?? this.captureHeight
    if (typeof r.grayBase64 !== 'string' || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new DesktopError('宿主返回了非法帧数据', 'EFRAME')
    }
    const gray = Uint8Array.from(Buffer.from(r.grayBase64, 'base64'))
    if (gray.length !== width * height) {
      throw new DesktopError(`帧字节数不匹配：${gray.length} != ${width * height}`, 'EFRAME')
    }
    return { gray, width, height }
  }

  async tree(depth = 4) {
    this.assertActive('tree')
    return this.transport.request({ op: 'tree', desktop: this.name, depth })
  }

  async input(input) {
    this.assertActive('input')
    return this.transport.request({ op: 'input', input, desktop: this.name })
  }

  /** 幂等关闭；并发 close 共享同一个 Promise，不重复终止宿主。 */
  async close() {
    if (this._closing) return this._closing
    const closing = (async () => {
      if (this._opening) {
        try {
          await this._opening
        } catch {
          /* 打开失败后仍按关闭流程回收 */
        }
      }
      if (this.state === 'closed' || this.state === 'idle') {
        this.transport.stop()
        this.state = 'closed'
        this.pid = null
        return { ok: true, already: true }
      }
      try {
        await this.transport.request({ op: 'close' })
      } finally {
        this.transport.stop()
        this.state = 'closed'
        this.pid = null
      }
      return { ok: true }
    })()
    this._closing = closing
    try {
      return await closing
    } finally {
      if (this._closing === closing) this._closing = null
    }
  }

  /** 权限不足时显式报错；并发 ensureOpen 只创建一个桌面。 */
  async ensureOpen() {
    if (this.state === 'opened' || this.state === 'running') return this
    if (this.state === 'closed') throw new DesktopError('会话已关闭，不能重新打开同一会话', 'ECLOSED')
    return this.open()
  }
}

export function sessionSensor(session) {
  return { capture: () => session.capture() }
}

export function sessionActuator(session) {
  return {
    async perform(a) {
      switch (a.kind) {
        case 'input':
          return session.input(a.payload)
        case 'uia':
          session.assertActive('uia')
          return session.transport.request({ op: 'uia', desktop: session.name, payload: a.payload })
        case 'shell':
          return session.startApp(a.payload.file, a.payload.args ?? [])
        case 'wait':
          await new Promise((r) => setTimeout(r, a.payload.ms))
          return null
        default:
          throw new DesktopError(`未知动作 ${a.kind}`, 'EACTION')
      }
    },
  }
}
