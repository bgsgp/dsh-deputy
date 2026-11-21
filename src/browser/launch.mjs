// 浏览器进程生命周期：起一个带 --remote-debugging-port 的独立实例，等 DevTools 端点就绪。
//
// 关键约束（context.md 第 1、8 条）：
//  - 永远用独立 --user-data-dir：不污染用户日常浏览器，也不被单实例合并到用户已开的窗口里；
//  - 端口用系统分配的空闲端口（0 也可以，但显式找一个更好排查）；
//  - 登录态：可选把本机 Edge/Chrome 的 cookie 库复制进临时 profile（见 cookies.mjs / docs/BROWSER.md），
//    复制发生在 spawn 之前，浏览器启动时就已经带上用户已登录的会话。
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { copyLoginState, loginStateSummary } from './cookies.mjs'
import { browserError } from './errors.mjs'

export const BROWSER_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
]

export function findBrowser(exe) {
  if (exe) {
    if (!existsSync(exe)) throw browserError('BAD_ARGS', `浏览器可执行文件不存在：${exe}`)
    return exe
  }
  const hit = BROWSER_CANDIDATES.find((p) => existsSync(p))
  if (!hit) throw browserError('BAD_ARGS', '没找到 Edge / Chrome，请在 config.browser.exe 里指定')
  return hit
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port
      srv.close(() => resolve(port))
    })
  })
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 轮询 /json/version，拿到 webSocketDebuggerUrl。 */
async function waitForEndpoint(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastErr = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { cache: 'no-store' })
      if (res.ok) {
        const info = await res.json()
        if (info.webSocketDebuggerUrl) return info
        lastErr = new Error('版本信息里没有 webSocketDebuggerUrl')
      } else lastErr = new Error(`HTTP ${res.status}`)
    } catch (e) {
      lastErr = e
    }
    await sleep(150)
  }
  throw browserError('CDP_ERROR', `DevTools 端点没起来（port ${port}）: ${lastErr?.message ?? 'timeout'}`)
}

/**
 * 起浏览器。返回的 close() 会先尝试 Browser.close，再兜底杀进程。
 * headless 用新 headless（--headless=new），调试与真实渲染都更接近。
 */
export async function launchBrowser({ exe, args = [], userDataDir, headless = false, timeoutMs = 20000, loginState = null } = {}) {
  const bin = findBrowser(exe)
  const dir = userDataDir ?? mkdtempSync(path.join(os.tmpdir(), 'dsh-deputy-browser-'))
  // 复制登录态必须在浏览器启动之前：Chromium 只在启动时加载 cookie 库。
  const login = loginState ? loginStateSummary(copyLoginState({ ...loginState, destDir: dir })) : loginStateSummary(null)
  const port = await freePort()
  const argv = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${dir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--restore-last-session',
    '--hide-crash-restore-bubble',
    '--disable-background-networking',
    ...(headless ? ['--headless=new', '--disable-gpu'] : []),
    ...args,
    'about:blank',
  ]
  const child = spawn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: false })
  let stderr = ''
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (c) => {
    stderr = (stderr + c).slice(-4000)
  })
  child.on('error', (e) => {
    stderr = `${stderr}\n${e.message}`
  })
  const exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)))
  exited.then(() => {})

  try {
    const info = await waitForEndpoint(port, timeoutMs)
    return {
      exe: bin,
      pid: child.pid,
      port,
      userDataDir: dir,
      wsUrl: info.webSocketDebuggerUrl,
      browser: info.Browser ?? 'unknown',
      loginState: login,
      get closed() {
        return child.exitCode !== null || child.signalCode !== null
      },
      get stderr() {
        return stderr
      },
      async close() {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/json/close`, { method: 'PUT' }).catch(() => null)
          void res
        } catch {
          /* 旧版本没有这个端点 */
        }
        try {
          child.kill()
        } catch {
          /* 已经退了 */
        }
      },
    }
  } catch (e) {
    try {
      child.kill()
    } catch {
      /* ignore */
    }
    throw Object.assign(e, { stderr })
  }
}
