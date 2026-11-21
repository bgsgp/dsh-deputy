// dsh-deputy/browser 组件入口：浏览器操作骨架（设计依据 C:/Users/LJL/Desktop/context.md）
//
// 这个包在插件管理器里是两行组件：
//   dsh-deputy/os      → src/os.mjs      （隔离桌面，四个 deputy_* 工具 + 面板端点）
//   dsh-deputy/browser → 本文件          （CDP daemon，browser_* 五个工具）
//
// 骨架范围（MVP 阶段一，调优交给 kimi，见 docs/BROWSER.md）：
//   - 独立 user-data-dir 起浏览器、CDP 连接、单标签 attach；
//   - DOMSnapshot + AX 树合成一行一节点的观察文本，ref = 生成 epoch + 节点序号；
//   - ref 上的 click / type / key / hover / scroll / navigate / press；
//   - docEpoch 变化即让旧 ref 失效（STALE_REF），批处理遇变化即停；
//   - 失败统一 { code, message, hint }。
import path from 'node:path'
import { BrowserDaemon } from './browser/daemon.mjs'
import { findUserDataDir } from './browser/cookies.mjs'
import { browserToolSpecs } from './browser/tools.mjs'
import { registerTools } from './registry.mjs'
import { setBrowserStatus } from './status.mjs'

export const name = 'dsh-deputy/browser'
export const inject = ['tools']

export const config = {
  enabled: true,
  exe: null,
  headless: false,
  userDataDir: null,
  statePath: null,
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

  const profileDir =
    cfg.userDataDir ??
    (cfg.persistProfile === false
      ? null
      : path.join(process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData/Local'), 'dsh-deputy', 'browser-profile'))

  const daemon = new BrowserDaemon({
    exe: cfg.exe ?? null,
    headless: cfg.headless ?? false,
    userDataDir: profileDir,
    statePath: cfg.statePath ?? null,
    loginState,
  })
  state.daemon = daemon
  setBrowserStatus({ state: 'stopped', running: false, error: null })

  const sink = registerTools(ctx, browserToolSpecs(daemon, { log }), log)
  if (sink.length) log(`[dsh-deputy/browser] 没有可用的 tools.register，${sink.length} 个工具未挂载`)

  // 浏览器是懒启动：注册时不弹窗口，第一次 browser_open/observe 才真的起进程。
  ctx.effect(() => () => {
    const closing = daemon.close().catch(() => {})
    setBrowserStatus({ state: 'stopped', running: false, error: null })
    return () => void closing
  })

  return { daemon }
}
