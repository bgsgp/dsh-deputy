// 桌面面板的数据面：一个只绑 127.0.0.1 的极简 HTTP 端点。
//
// 路由（全部 JSON，全部 cache-control: no-store）：
//   GET  /api/health          → { ok, platform, state, name, pid }
//   GET  /api/status          → os + browser 两个组件的合成状态（侧栏状态点读这个）
//   GET  /api/frame           → { ok, png(彩色 PNG base64), width, height, color, ts }
//                               （宿主不支持彩色快照时退回灰度帧，color:false）
//                               失败时 ok:false + reason + code（NOWINDOW = 桌面里还没有窗口）
//   POST /api/open            → 开桌面（Windows 上会弹 UAC）
//   POST /api/close           → 收桌面
//   POST /api/launch { exe }  → 在隔离桌面里起程序
//                    { app: 'edge' | 'notepad' }  → 用内置预设启动（面板按钮走这条）
//   POST /api/input  { type: 'click', x, y }  x/y 为 0..1 归一化坐标
//                    { type: 'type', text }
// input 同时兼容 op 字段；点击会被换算成像素坐标再交给宿主。
import http from 'node:http'
import { existsSync } from 'node:fs'
import { encodeGrayPng } from './png.mjs'
import { snapshot, setOsStatus, noteFailure } from './status.mjs'

/** 面板里的「启动 xxx」按钮用预设，省得客户端硬编码路径。 */
const APP_PRESETS = {
  edge: {
    candidates: [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    ],
    args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--window-size=1440,900', '--new-window', 'about:blank'],
  },
  notepad: { candidates: ['C:/Windows/System32/notepad.exe'], args: [] },
}

function resolveApp(app) {
  const preset = APP_PRESETS[app]
  if (!preset) return null
  const exe = preset.candidates.find((p) => existsSync(p)) ?? preset.candidates[preset.candidates.length - 1]
  return { exe, args: [...preset.args] }
}

export const DEFAULT_VIEW_PORT = 17872
const MAX_BODY_BYTES = 1_000_000

function badRequest(message, statusCode = 400) {
  const err = new Error(message)
  err.statusCode = statusCode
  return err
}

export function createViewer({ session, port = DEFAULT_VIEW_PORT, host = '127.0.0.1' } = {}) {
  if (!session) throw new TypeError('createViewer 需要 session')
  let server = null
  let lastFrame = null
  let frameInFlight = null

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  }

  function json(res, status, body, headers = {}) {
    if (res.writableEnded) return
    res.writeHead(status, { ...cors, ...headers, 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = ''
      let size = 0
      let settled = false
      const fail = (err) => {
        if (settled) return
        settled = true
        raw = ''
        reject(err)
      }
      req.on('data', (chunk) => {
        if (settled) return
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          fail(badRequest(`请求体超过 ${MAX_BODY_BYTES} 字节`, 413))
          return
        }
        raw += chunk
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        if (!raw) return resolve({})
        try {
          const value = JSON.parse(raw)
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return reject(badRequest('JSON 请求体必须是对象'))
          }
          resolve(value)
        } catch (e) {
          reject(badRequest(`JSON 解析失败: ${e.message}`))
        }
      })
      req.on('error', fail)
    })
  }

  async function bodyOf(req) {
    try {
      return await readBody(req)
    } catch (e) {
      throw e.statusCode ? e : badRequest(e.message)
    }
  }

  async function captureFrame() {
    // 轮询、手动刷新、点击后补帧可能同时到来；合并成一次 BitBlt，避免把宿主打满。
    if (frameInFlight) return frameInFlight
    frameInFlight = (async () => {
      // 面板要「用户看到的画面」：优先彩色快照（宿主侧直接编码 PNG）。
      // 老宿主/测试假宿主没有 snapshot 就退回灰度帧，行为不变。
      if (typeof session.snapshot === 'function') {
        try {
          // 面板宽度一般 1000px 出头，缩到 1600 再编码能把 PNG 体积砍一半以上。
          const s = await session.snapshot({ target: session.mode === 'isolated' ? 'window' : 'screen', maxWidth: 1600 })
          return {
            png: s.png,
            width: s.width,
            height: s.height,
            frameWidth: s.frameWidth ?? s.width,
            frameHeight: s.frameHeight ?? s.height,
            originX: s.originX ?? 0,
            originY: s.originY ?? 0,
            color: true,
            ts: Date.now(),
          }
        } catch (e) {
          if (e.code === 'NOWINDOW') throw e
          /* 其它失败退回灰度帧 */
        }
      }
      const f = await session.capture()
      if (!Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width <= 0 || f.height <= 0) {
        throw new Error('宿主返回了非法帧尺寸')
      }
      return {
        png: encodeGrayPng(f.gray, f.width, f.height).toString('base64'),
        width: f.width,
        height: f.height,
        frameWidth: f.width,
        frameHeight: f.height,
        originX: f.originX ?? 0,
        originY: f.originY ?? 0,
        color: false,
        ts: Date.now(),
      }
    })()
    try {
      const frame = await frameInFlight
      lastFrame = frame
      return frame
    } finally {
      frameInFlight = null
    }
  }

  function methodNotAllowed(res, allow) {
    return json(res, 405, { ok: false, reason: '方法不允许' }, { allow })
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${host}:${port}`)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }

    if (url.pathname === '/api/health') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      return json(res, 200, {
        ok: true,
        platform: process.platform,
        state: session.state,
        name: session.name,
        pid: session.pid ?? null,
      })
    }

    if (url.pathname === '/api/status') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      // 桌面这一段的实时状态以 session 为准（进程重启后总线是新的，session 也是新的，二者一致）
      setOsStatus({
        state: session.state,
        running: session.state === 'opened' || session.state === 'running',
        detail: session.name,
      })
      return json(res, 200, { ...snapshot(), platform: process.platform, desktop: { state: session.state, name: session.name, pid: session.pid ?? null } })
    }

    if (url.pathname === '/api/frame') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      if (session.state !== 'opened' && session.state !== 'running') {
        return json(res, 200, {
          ok: false,
          state: session.state,
          reason: session.state === 'closed' ? '桌面已关闭' : '桌面还没打开',
        })
      }
      try {
        const frame = await captureFrame()
        return json(res, 200, { ok: true, ...frame })
      } catch (e) {
        // code 透传给页面：NOWINDOW 表示桌面里还没有窗口，页面要给"启动程序"的引导而不是一张黑图
        return json(res, 200, { ok: false, state: session.state, reason: e.message, code: e.code ?? null })
      }
    }

    if (url.pathname === '/api/open') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      try {
        const body = await readBody(req)
        if (body?.mode && typeof session.setMode === 'function') await session.setMode(body.mode)
        await session.ensureOpen()
        setOsStatus({ state: session.state, running: true, error: null })
        return json(res, 200, { ok: true, state: session.state, name: session.name, mode: session.mode })
      } catch (e) {
        noteFailure('os', e)
        return json(res, 200, { ok: false, reason: e.message, code: e.code ?? null })
      }
    }

    if (url.pathname === '/api/close') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      try {
        const r = await session.close()
        lastFrame = null
        setOsStatus({ state: 'closed', running: false, error: null })
        return json(res, 200, { ok: true, ...r })
      } catch (e) {
        noteFailure('os', e)
        return json(res, 200, { ok: false, reason: e.message, code: e.code ?? null })
      }
    }

    if (url.pathname === '/api/apps') {
      if (req.method !== 'GET') return methodNotAllowed(res, 'GET')
      try {
        await session.ensureOpen()
        const apps = await session.listApps()
        return json(res, 200, { ok: true, apps, count: apps.length })
      } catch (e) {
        noteFailure('os', e)
        return json(res, 200, { ok: false, reason: e.message, code: e.code ?? null })
      }
    }

    if (url.pathname === '/api/launch-app') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      try {
        const b = await bodyOf(req)
        if (typeof b.name !== 'string' || !b.name.trim()) throw badRequest('name 必须是开始菜单里的应用名')
        await session.ensureOpen()
        const r = await session.launchApp(b.name)
        setOsStatus({ state: session.state, running: true, error: null })
        return json(res, 200, { ok: true, name: r.name, target: r.target, pid: r.pid ?? null })
      } catch (e) {
        noteFailure('os', e)
        return json(res, 200, { ok: false, reason: e.message, code: e.code ?? null, candidates: e.candidates ?? null })
      }
    }

    if (url.pathname === '/api/launch') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      try {
        const b = await bodyOf(req)
        let exe = typeof b.exe === 'string' ? b.exe.trim() : ''
        let args = b.args ?? []
        if (!exe && b.app) {
          const preset = resolveApp(String(b.app))
          if (!preset) throw badRequest(`未知的 app 预设 ${String(b.app)}`)
          exe = preset.exe
          if (!Array.isArray(b.args)) args = preset.args
        }
        if (!exe) throw badRequest('launch 需要非空 exe（或用 app 预设）')
        if (!Array.isArray(args) || args.some((v) => typeof v !== 'string')) {
          throw badRequest('args 必须是字符串数组')
        }
        await session.ensureOpen()
        const r = await session.startApp(exe, args)
        setOsStatus({ state: session.state, running: true, error: null })
        return json(res, 200, { ok: true, exe, ...r })
      } catch (e) {
        noteFailure('os', e)
        return json(res, e.statusCode ?? 200, { ok: false, reason: e.message, code: e.code ?? null })
      }
    }

    if (url.pathname === '/api/input') {
      if (req.method !== 'POST') return methodNotAllowed(res, 'POST')
      try {
        const b = await bodyOf(req)
        const kind = b.type ?? b.op // 旧客户端曾使用 op，两种都接受
        // 帧可能被宿主等比缩小过，点击必须换算到原始像素；缩放只影响显示，不影响坐标。
        const width = lastFrame?.frameWidth ?? lastFrame?.width ?? session.captureWidth ?? 0
        const height = lastFrame?.frameHeight ?? lastFrame?.height ?? session.captureHeight ?? 0
        let input
        if (kind === 'click') {
          const x = Number(b.x)
          const y = Number(b.y)
          if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
            throw badRequest('click 的 x/y 必须是 0..1 的有限数值')
          }
          if (!(width > 0 && height > 0)) throw badRequest('还没有可用于坐标换算的帧尺寸', 409)
          input = {
            op: 'click',
            x: Math.min(width - 1, Math.round(x * width)),
            y: Math.min(height - 1, Math.round(y * height)),
            button: b.button === 'right' ? 'right' : 'left',
          }
        } else if (kind === 'type') {
          if (typeof b.text !== 'string') throw badRequest('type 需要字符串 text')
          if (b.text.length > 100_000) throw badRequest('text 过长', 413)
          input = { op: 'type', text: b.text }
        } else {
          throw badRequest(`未知输入类型 ${String(kind)}`)
        }
        await session.input(input)
        return json(res, 200, { ok: true, input, width, height })
      } catch (e) {
        return json(res, e.statusCode ?? 200, { ok: false, reason: e.message, code: e.code ?? null })
      }
    }

    return json(res, 404, { ok: false, reason: `未注册路由 ${url.pathname}` })
  }

  return {
    port,
    url: `http://${host}:${port}/`,
    async start() {
      if (server?.listening) return this.url
      server = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          try {
            json(res, e.statusCode ?? 500, { ok: false, reason: e.message })
          } catch {
            res.destroy()
          }
        })
      })
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject)
          server.listen(port, host, resolve)
        })
      } catch (e) {
        const failed = server
        server = null
        failed?.close()
        throw e
      }
      this.port = server.address().port // port=0 时返回系统分配的空闲端口，便于测试与并行实例
      this.url = `http://${host}:${this.port}/`
      return this.url
    },
    async stop() {
      if (!server) return
      const s = server
      server = null
      frameInFlight = null
      lastFrame = null
      const closed = new Promise((resolve) => s.close(resolve))
      s.closeAllConnections?.() // 不让 keep-alive 连接卡住插件卸载
      await closed
    },
  }
}
