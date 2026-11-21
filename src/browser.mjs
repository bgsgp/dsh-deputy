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
import { BrowserDaemon } from './browser/daemon.mjs'
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

  const daemon = new BrowserDaemon({
    exe: cfg.exe ?? null,
    headless: cfg.headless ?? false,
    userDataDir: cfg.userDataDir ?? null,
    statePath: cfg.statePath ?? null,
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
