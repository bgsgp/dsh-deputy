// dsh-deputy/browser 组件入口：CDP 浏览器控制。
//
// 这个包在插件管理器里是两行组件：
//   dsh-deputy/os      → src/os.mjs      （隔离桌面，四个 deputy_* 工具 + 面板端点）
//   dsh-deputy/browser → 本文件          （CDP daemon，browser_* 五个工具）
//
// 浏览器半：独立 profile、DOM+AX 快照、epoch ref、结构化等待、遮挡检查、
// 多标签、上传下载、截图附件、幂等写操作与异常状态恢复。
import path from 'node:path'
import { BrowserDaemon } from './browser/daemon.mjs'
import { findUserDataDir } from './browser/cookies.mjs'
import { registerBrowserTools } from './browser/tools.mjs'
import { setBrowserStatus } from './status.mjs'

export const name = 'dsh-deputy/browser'
export const inject = ['tools', 'attachments']

export const config = {
  enabled: true,
  exe: null,
  headless: false,
  userDataDir: null,
  statePath: null, // null = %LOCALAPPDATA%/dsh-deputy/browser-state.json；false = 禁用恢复
  downloadDir: null, // null = %LOCALAPPDATA%/dsh-deputy/downloads
  restoreState: true,
  // 登录态：默认继承本机 Edge/Chrome 的 cookie（复制进临时 profile）。
  // 'inherit' | false；风险与实现见 docs/BROWSER.md「登录态与风险」。
  cookies: 'inherit',
  cookiesProfile: 'auto', // 'auto' | 'Default' | 'Profile 1' …
  cookiesSource: null, // 显式指定 User Data 目录；null = 按浏览器自动找
  // 独立 profile 默认落在本机固定位置，这样「在面板里登录一次」能跨启动保留；
  // 设 false 则每次启动都用一次性临时目录（更干净，但登录态不保留）。
  persistProfile: true,
}

export const state = { daemon: null }

export function apply(ctx = {}) {
  const log = (m) => ctx.logger?.warn?.(m)
  const cfg = config ?? {}
  if (cfg.enabled === false) {
    setBrowserStatus({ state: 'paused', running: false, error: null })
    log('[dsh-deputy/browser] config.enabled=false，浏览器组件未启用')
    return { daemon: null }
  }

  // 继承登录态：源只能是用户日常浏览器的 User Data（不是 daemon 自己的 userDataDir）。
  const loginState =
    cfg.cookies === false
      ? null
      : {
          sourceRoot: cfg.cookiesSource ?? findUserDataDir({ exe: cfg.exe ?? null }),
          profile: cfg.cookiesProfile ?? 'auto',
        }
  if (cfg.cookies !== false && !loginState.sourceRoot) {
    log('[dsh-deputy/browser] 没找到本机 Edge/Chrome 的 User Data，浏览器将以未登录状态启动')
  }

  const dataDir = path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData/Local'), 'dsh-deputy')
  const profileDir = cfg.userDataDir ?? (cfg.persistProfile === false ? null : path.join(dataDir, 'browser-profile'))
  const statePath = cfg.statePath === false ? null : cfg.statePath ?? path.join(dataDir, 'browser-state.json')

  const daemon = new BrowserDaemon({
    exe: cfg.exe ?? null,
    headless: cfg.headless ?? false,
    userDataDir: profileDir,
    statePath,
    downloadDir: cfg.downloadDir ?? path.join(dataDir, 'downloads'),
    restoreState: cfg.restoreState !== false,
    loginState,
  })
  state.daemon = daemon
  setBrowserStatus({ state: 'stopped', running: false, error: null })

  const saveImage = ctx.attachments?.saveImage?.bind(ctx.attachments) ?? null
  if (!saveImage) log('[dsh-deputy/browser] attachments.saveImage 不可用，观察截图只回 base64 数据')
  const sink = registerBrowserTools(ctx, daemon, { saveImage, log })
  if (sink.length) log(`[dsh-deputy/browser] 没有可用的 tools.register，${sink.length} 个工具未挂载`)

  const heartbeat = setInterval(() => {
    const current = daemon.status()
    setBrowserStatus({ state: current.state, running: current.state === 'running', error: current.error })
  }, 5000)
  heartbeat.unref()

  // 浏览器是懒启动：注册时不弹窗口，第一次 browser_open/observe 才真的起进程。
  ctx.effect(() => () => {
    clearInterval(heartbeat)
    const closing = daemon.close().catch(() => {})
    setBrowserStatus({ state: 'stopped', running: false, error: null })
    return () => void closing
  })

  return { daemon }
}
