// DESKTOP 层：一个真正活着的虚拟桌面会话
//
// 关键点：Windows 的桌面对象是"引用计数"的——创建它的进程一退出，桌面就没了。
// 所以不能"建一下、记个 handle、下次再用"，必须有一个**常驻宿主进程**攒着这个桌面，
// 由它承接后续的启动进程 / 采帧 / 取树 / 键鼠。这里就是那个宿主的客户端封装。
//
// 生命周期： idle → opened → running → closed
//   open()   ：创建独立 Desktop（需要管理员，GENERIC_ALL）
//   start()  ：在隔离桌面里 CreateProcess，目标程序的窗口只存在于该桌面
//   capture()：宿主线程 SetThreadDesktop 后 BitBlt 取帧（非活动桌面不能用 WGC）
//   tree()   ：宿主线程在该桌面上取 UIA 树（RootElement 指向线程所在桌面）
//   input()  ：宿主线程在该桌面上 SendInput
//   close()  ：宿主退出 → 桌面对象销毁，目标进程随之结束
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

/**
 * 常驻宿主：一行 JSON 一条命令，一行 JSON 一条回执。
 * 生产环境建议换成编译好的 worker exe（PowerShell 自身的隐藏窗口会污染 UIA 树，
 * 这点在 scripts/windows-desktop.ps1 的注释里也写明了）。
 */
export function createHostTransport({ script = path.join(SCRIPTS, 'windows-desktop.ps1'), timeoutMs = 12000 } = {}) {
  let child = null
  let seq = 0
  const waiting = new Map()

  function start(name) {
    if (process.platform !== 'win32') {
      return Promise.reject(new DesktopError('虚拟桌面宿主仅在 win32 可用', 'ENOPLATFORM'))
    }
    child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Op', 'host', '-Name', name],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    )
    child.stdout.setEncoding('utf8')
    let buf = ''
    child.stdout.on('data', (chunk) => {
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
          /* 非协议输出（PS 警告）忽略 */
        }
      }
    })
    child.on('exit', (code) => {
      for (const p of waiting.values()) p.reject(new DesktopError(`宿主退出 ${code}`, 'EHOSTEXIT'))
      waiting.clear()
      child = null
    })
    return request({ op: 'create', name })
  }

  function request(payload) {
    if (!child) return Promise.reject(new DesktopError('宿主未启动', 'ENOHOST'))
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
      child.stdin.write(JSON.stringify({ ...payload, id }) + '\n')
    })
  }

  function stop() {
    if (!child) return
    try {
      child.stdin.end()
      child.kill()
    } catch {
      /* ignore */
    }
    child = null
  }

  return { start, request, stop }
}

/** 内存假宿主：非 Windows 也能测状态机与降级逻辑 */
export function createFakeTransport() {
  const state = { desktop: null, pid: null, frames: 0, inputs: 0, closed: false }
  return {
    state,
    start: async (name) => {
      state.desktop = name
      return { ok: true, desktop: name }
    },
    request: async (payload) => {
      if (state.closed) throw new DesktopError('会话已关闭', 'ECLOSED')
      switch (payload.op) {
        case 'launch':
          state.pid = 4321
          return { ok: true, pid: 4321 }
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
  }

  async open() {
    if (this.state !== 'idle') throw new DesktopError(`open 只能在 idle 时调用，当前 ${this.state}`, 'ESTATE')
    try {
      await this.transport.start(this.name)
      this.state = 'opened'
      return this
    } catch (err) {
      this.lastError = err
      throw err
    }
  }

  /** 在隔离桌面里启动目标程序；它之后的所有窗口都不会出现在用户主桌面 */
  async startApp(exe, args = []) {
    if (this.state !== 'opened') throw new DesktopError(`startApp 需要 opened，当前 ${this.state}`, 'ESTATE')
    const r = await this.transport.request({ op: 'launch', exe, args: args.join(' '), desktop: this.name })
    this.pid = r.pid ?? null
    this.state = 'running'
    return r
  }

  async capture(region) {
    if (this.state === 'idle') throw new DesktopError('会话未打开', 'ESTATE')
    const r = await this.transport.request({ op: 'capture', desktop: this.name, region: region ?? null })
    // 宿主回传 8bit 灰度 base64，直接喂给 diff.mjs，不用再转 RGBA
    return {
      gray: Uint8Array.from(Buffer.from(r.grayBase64, 'base64')),
      width: r.width ?? this.captureWidth,
      height: r.height ?? this.captureHeight,
    }
  }

  async tree(depth = 4) {
    if (this.state === 'idle') throw new DesktopError('会话未打开', 'ESTATE')
    return this.transport.request({ op: 'tree', desktop: this.name, depth })
  }

  async input(input) {
    if (this.state === 'idle') throw new DesktopError('会话未打开', 'ESTATE')
    return this.transport.request({ op: 'input', input, desktop: this.name })
  }

  /** 幂等关闭：宿主退出即桌面销毁，不残留 */
  async close() {
    if (this.state === 'closed' || this.state === 'idle') {
      this.state = 'closed'
      return { ok: true, already: true }
    }
    try {
      await this.transport.request({ op: 'close' })
    } finally {
      this.transport.stop()
      this.state = 'closed'
    }
    return { ok: true }
  }

  /** 权限不足时的显式降级：不偷偷在主桌面乱点，而是报错让人决定 */
  async ensureOpen() {
    if (this.state === 'opened' || this.state === 'running') return this
    await this.open()
    return this
  }
}

/** 把会话包成 runner 的 sensor（采帧永远走隔离桌面） */
export function sessionSensor(session) {
  return { capture: () => session.capture() }
}

/** 把会话包成 runner 的 actuator（动作永远发在隔离桌面里） */
export function sessionActuator(session) {
  return {
    async perform(a) {
      switch (a.kind) {
        case 'input':
          return session.input(a.payload)
        case 'uia':
          // UIA pattern 需要宿主侧在同一桌面解析 ref，这里透传给宿主
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
