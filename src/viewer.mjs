// 桌面面板的数据面：一个只绑 127.0.0.1 的极简 HTTP 端点。
//
// 为什么不用宿主路由：DSH 的 host 路由 API 各版本不一致，而面板只服务本机浏览器，
// 自己起一个 node:http 服务最稳，也不依赖 api-gateway。
//
// 路由（全部 JSON，全部 cache-control: no-store）：
//   GET  /api/health          → { ok, platform, state, name, pid }
//   GET  /api/frame           → { ok, png(base64 灰度 PNG), width, height, ts }
//   POST /api/open            → 开桌面（Windows 上会弹 UAC）
//   POST /api/close           → 收桌面
//   POST /api/launch { exe }  → 在隔离桌面里起程序
//   POST /api/input  { type: 'click', x, y }  x/y 为 0..1 归一化坐标
//                    { type: 'type', text }
// 点击会被换算成像素坐标再交给宿主（宿主协议就是像素，见 windows-desktop.ps1）。
import http from 'node:http'
import { encodeGrayPng } from './png.mjs'

export const DEFAULT_VIEW_PORT = 17872

export function createViewer({ session, port = DEFAULT_VIEW_PORT, host = '127.0.0.1' } = {}) {
  let server = null
  let lastFrame = null

  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'cache-control': 'no-store',
  }

  function json(res, status, body) {
    res.writeHead(status, { ...cors, 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = ''
      req.on('data', (chunk) => {
        raw += chunk
        if (raw.length > 1_000_000) reject(new Error('body too large'))
      })
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : {})
        } catch (e) {
          reject(new Error(`JSON 解析失败: ${e.message}`))
        }
      })
      req.on('error', reject)
    })
  }

  async function handle(req, res) {
    const url = new URL(req.url, `http://${host}:${port}`)

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors)
      return res.end()
    }

    if (url.pathname === '/api/health') {
      return json(res, 200, {
        ok: true,
        platform: process.platform,
        state: session.state,
        name: session.name,
        pid: session.pid ?? null,
      })
    }

    if (url.pathname === '/api/frame') {
      if (session.state !== 'opened' && session.state !== 'running') {
        return json(res, 200, {
          ok: false,
          state: session.state,
          reason: session.state === 'closed' ? '桌面已关闭' : '桌面还没打开',
        })
      }
      try {
        const f = await session.capture()
        lastFrame = {
          png: encodeGrayPng(f.gray, f.width, f.height).toString('base64'),
          width: f.width,
          height: f.height,
          ts: Date.now(),
        }
        return json(res, 200, { ok: true, ...lastFrame })
      } catch (e) {
        return json(res, 200, { ok: false, state: session.state, reason: e.message })
      }
    }

    if (url.pathname === '/api/open' && req.method === 'POST') {
      try {
        await session.ensureOpen()
        return json(res, 200, { ok: true, state: session.state, name: session.name })
      } catch (e) {
        return json(res, 200, { ok: false, reason: e.message })
      }
    }

    if (url.pathname === '/api/close' && req.method === 'POST') {
      try {
        const r = await session.close()
        lastFrame = null
        return json(res, 200, { ok: true, ...r })
      } catch (e) {
        return json(res, 200, { ok: false, reason: e.message })
      }
    }

    if (url.pathname === '/api/launch' && req.method === 'POST') {
      const b = await readBody(req)
      try {
        await session.ensureOpen()
        const r = await session.startApp(String(b.exe), b.args ?? [])
        return json(res, 200, { ok: true, ...r })
      } catch (e) {
        return json(res, 200, { ok: false, reason: e.message })
      }
    }

    if (url.pathname === '/api/input' && req.method === 'POST') {
      const b = await readBody(req)
      const width = lastFrame?.width ?? session.captureWidth ?? 0
      const height = lastFrame?.height ?? session.captureHeight ?? 0
      let input
      if (b.type === 'click') {
        // 归一化 → 像素：面板怎么缩放都不影响命中点
        input = {
          op: 'click',
          x: Math.round(Number(b.x ?? 0.5) * width),
          y: Math.round(Number(b.y ?? 0.5) * height),
          button: b.button === 'right' ? 'right' : 'left',
        }
      } else if (b.type === 'type') {
        input = { op: 'type', text: String(b.text ?? '') }
      } else {
        return json(res, 400, { ok: false, reason: `未知 type ${b.type}` })
      }
      try {
        await session.input(input)
        return json(res, 200, { ok: true, input, width, height })
      } catch (e) {
        return json(res, 200, { ok: false, reason: e.message })
      }
    }

    return json(res, 404, { ok: false, reason: `未注册路由 ${url.pathname}` })
  }

  return {
    port,
    url: `http://${host}:${port}/`,
    async start() {
      if (server) return this.url
      server = http.createServer((req, res) => {
        handle(req, res).catch((e) => {
          try {
            json(res, 500, { ok: false, reason: e.message })
          } catch {
            res.destroy()
          }
        })
      })
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, resolve)
      })
      return this.url
    },
    async stop() {
      if (!server) return
      const s = server
      server = null
      await new Promise((resolve) => s.close(resolve))
    },
  }
}
