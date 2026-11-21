// 常驻浏览器 daemon（context.md 第 1、2 条）
//
// - 它持有浏览器实例、CDP 连接、target 注册表和节点注册表；
// - 工具只是一个连 localhost 的瘦客户端，离散调用之间不靠内存传递状态；
// - 状态双写：内存（活的）+ statePath 指向的 state.json（重启后能认出上次的 target）。
//
// 骨架阶段的取舍：单标签、单 session、单浏览器实例；多标签 / iframe / target 切换留给后续调优。
// TODO(kimi): 多 target 并行 attach、iframe OOPIF、下载与上传、状态快照恢复。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CdpConnection } from './cdp.mjs'
import { browserError } from './errors.mjs'
import { launchBrowser } from './launch.mjs'
import { buildSnapshot } from './snapshot.mjs'
import { runSteps } from './act.mjs'

export class BrowserDaemon {
  constructor(options = {}) {
    this.options = {
      exe: options.exe ?? null,
      headless: options.headless ?? false,
      userDataDir: options.userDataDir ?? null,
      statePath: options.statePath ?? null,
      timeoutMs: options.timeoutMs ?? 15000,
      launch: options.launch ?? launchBrowser,
    }
    this.browser = null
    this.cdp = null
    this.starting = null
    this.pageSession = null
    this.targetId = null
    this.docEpoch = 0
    this.targets = new Map() // targetId -> { type, url, title, sessionId, epoch }
    this.nodes = new Map() // ref -> { backendNodeId, epoch, role, name }
    this.lastUrl = null
    this.lastError = null
    this.unsubscribe = null
  }

  get state() {
    if (this.browser && this.pageSession) return 'running'
    if (this.browser) return 'starting'
    return 'stopped'
  }

  status() {
    return {
      state: this.state,
      exe: this.browser?.exe ?? this.options.exe,
      pid: this.browser?.pid ?? null,
      port: this.browser?.port ?? null,
      userDataDir: this.browser?.userDataDir ?? this.options.userDataDir,
      targetId: this.targetId,
      docEpoch: this.docEpoch,
      refs: this.nodes.size,
      url: this.lastUrl,
      error: this.lastError,
    }
  }

  /** 幂等启动：并发调用共享同一个启动 Promise */
  async ensureStarted() {
    if (this.cdp && this.pageSession) return this.status()
    if (this.starting) return this.starting
    this.starting = (async () => {
      try {
        if (!this.browser) this.browser = await this.options.launch({
          exe: this.options.exe,
          userDataDir: this.options.userDataDir,
          headless: this.options.headless,
          timeoutMs: this.options.timeoutMs,
        })
        if (!this.cdp) {
          this.cdp = await CdpConnection.connect(this.browser.wsUrl, { timeoutMs: this.options.timeoutMs })
          this.unsubscribe = this.cdp.on((msg) => this.#onEvent(msg))
        }
        await this.#attachDefaultPage()
        this.lastError = null
        return this.status()
      } catch (e) {
        this.lastError = e?.message ?? String(e)
        await this.close().catch(() => {})
        throw e
      } finally {
        this.starting = null
      }
    })()
    return this.starting
  }

  async #attachDefaultPage() {
    const { targetInfos = [] } = await this.cdp.send('Target.getTargets')
    let page = targetInfos.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    if (!page) {
      const created = await this.cdp.send('Target.createTarget', { url: 'about:blank' })
      page = { targetId: created.targetId, type: 'page', url: 'about:blank', title: '' }
    }
    await this.attach(page.targetId)
  }

  /** attach 一个 page target；flatten 模式下所有命令都带 sessionId */
  async attach(targetId) {
    const { sessionId } = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })
    const session = { targetId, sessionId, epoch: ++this.docEpoch }
    this.targets.set(targetId, { type: 'page', url: this.lastUrl ?? '', title: '', ...session })
    this.pageSession = sessionId
    this.targetId = targetId
    for (const domain of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'Network.enable']) {
      try {
        await this.cdp.send(domain, {}, sessionId)
      } catch {
        /* Network/DOM 在极简 target 上可能不可用，忽略 */
      }
    }
    await this.#persist()
    return session
  }

  #onEvent(msg) {
    if (!msg.sessionId || msg.sessionId !== this.pageSession) return
    if (msg.method === 'Page.frameNavigated' || msg.method === 'DOM.documentUpdated' || msg.method === 'Page.navigatedWithinDocument') {
      this.docEpoch += 1
      // 节点注册表按 epoch 失效：旧 ref 一律 STALE_REF，绝不让旧句柄点错元素
      this.nodes.clear()
      if (msg.method === 'Page.frameNavigated' && msg.params?.frame?.url) this.lastUrl = msg.params.frame.url
      this.#persist().catch(() => {})
    }
  }

  async #persist() {
    const statePath = this.options.statePath
    if (!statePath) return
    const payload = {
      at: Date.now(),
      docEpoch: this.docEpoch,
      activeTarget: this.targetId,
      targets: [...this.targets.values()].map((t) => ({ targetId: t.targetId, url: t.url, epoch: t.epoch })),
    }
    try {
      mkdirSync(path.dirname(statePath), { recursive: true })
      writeFileSync(statePath, JSON.stringify(payload, null, 2))
    } catch {
      /* 状态落盘失败不影响主流程 */
    }
  }

  readState() {
    if (!this.options.statePath) return null
    try {
      return JSON.parse(readFileSync(this.options.statePath, 'utf8'))
    } catch {
      return null
    }
  }

  async navigate(url) {
    if (!this.cdp || !this.pageSession) throw browserError('NOT_RUNNING', '浏览器还没启动')
    if (typeof url !== 'string' || !url.trim()) throw browserError('BAD_ARGS', 'navigate 需要 url')
    await this.cdp.send('Page.navigate', { url }, this.pageSession)
    this.lastUrl = url
    await this.waitForLoad()
    return { ok: true, url, docEpoch: this.docEpoch }
  }

  /**
   * 导航级等待（context.md 第 5 条的第一层）：readyState=complete + 网络静默。
   * TODO(kimi): 用 Page.lifecycleEvent 替代轮询，并把「元素级等待」放到 act 里做。
   */
  async waitForLoad({ timeoutMs = 10000, quietMs = 500 } = {}) {
    const deadline = Date.now() + timeoutMs
    let quietSince = null
    while (Date.now() < deadline) {
      let ready = 'loading'
      try {
        const r = await this.cdp.send(
          'Runtime.evaluate',
          { expression: 'document.readyState', returnByValue: true },
          this.pageSession,
        )
        ready = r?.result?.value ?? 'loading'
      } catch {
        ready = 'unknown'
      }
      if (ready === 'complete') {
        if (quietSince === null) quietSince = Date.now()
        else if (Date.now() - quietSince >= quietMs) return true
      } else {
        quietSince = null
      }
      await new Promise((r) => setTimeout(r, 100))
    }
    throw browserError('NAV_TIMEOUT', `导航在 ${timeoutMs}ms 内没稳定`)
  }

  async evaluate(expression) {
    if (!this.cdp || !this.pageSession) throw browserError('NOT_RUNNING', '浏览器还没启动')
    const r = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, this.pageSession)
    if (r?.exceptionDetails) throw browserError('CDP_ERROR', r.exceptionDetails.text ?? '页面脚本抛错')
    return r?.result?.value
  }

  async observe(options = {}) {
    await this.ensureStarted()
    return buildSnapshot(this, options)
  }

  async act(options = {}) {
    await this.ensureStarted()
    return runSteps(this, options)
  }

  async close() {
    try {
      this.unsubscribe?.()
    } catch {
      /* ignore */
    }
    this.unsubscribe = null
    if (this.cdp) {
      try {
        await this.cdp.send('Browser.close')
      } catch {
        /* 旧版本/已断连 */
      }
      this.cdp.close()
    }
    this.cdp = null
    this.pageSession = null
    this.targetId = null
    this.nodes.clear()
    if (this.browser) {
      try {
        await this.browser.close()
      } catch {
        /* ignore */
      }
    }
    this.browser = null
    await this.#persist()
    return { ok: true, state: 'stopped' }
  }
}
