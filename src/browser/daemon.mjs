// 常驻浏览器 daemon：独立浏览器进程、CDP 多 target、ref 注册表与可恢复状态。
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CdpConnection } from './cdp.mjs'
import { browserError } from './errors.mjs'
import { launchBrowser } from './launch.mjs'
import { buildSnapshot } from './snapshot.mjs'
import { runSteps } from './act.mjs'
import { settleAfterAction, waitForElement, waitForLoad } from './wait.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const safeUrl = (value) => {
  try {
    const url = new URL(value)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value ? String(value).split(/[?#]/, 1)[0] : ''
  }
}

export class BrowserDaemon {
  constructor(options = {}) {
    this.options = {
      exe: options.exe ?? null,
      headless: options.headless ?? false,
      userDataDir: options.userDataDir ?? null,
      statePath: options.statePath ?? null,
      downloadDir: options.downloadDir ?? path.join(os.tmpdir(), 'dsh-deputy-downloads'),
      restoreState: options.restoreState !== false,
      timeoutMs: options.timeoutMs ?? 15000,
      loginState: options.loginState ?? null,
      launch: options.launch ?? launchBrowser,
    }
    this.browser = null
    this.cdp = null
    this.starting = null
    this.pageSession = null
    this.targetId = null
    this.docEpoch = 0
    this.targets = new Map() // targetId -> { type, url, title, sessionId, epoch }
    this.nodes = new Map() // ref -> { backendNodeId, epoch, role, name, box, disabled }
    this.networkPending = new Map() // `${sessionId}:${requestId}` -> url（不输出 URL）
    this.networkActivity = new Map() // sessionId -> timestamp
    this.domChangedAt = new Map() // sessionId -> timestamp
    this.downloads = new Map() // guid -> 不含页面凭据的下载元数据
    this.actionResults = new Map() // idempotencyKey -> { at, result }
    this.actionInflight = new Map()
    this.lastUrl = null
    this.lastError = null
    this.unsubscribe = null
    this.login = null
    this.cookieCount = null
  }

  get state() {
    if (this.browser && this.cdp && !this.cdp.disconnected && this.pageSession) return 'running'
    if (this.browser || this.starting) return 'starting'
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
      targets: [...this.targets.values()].filter((t) => t.type === 'page').length,
      docEpoch: this.docEpoch,
      refs: this.nodes.size,
      url: this.lastUrl,
      error: this.lastError,
      downloads: [...this.downloads.values()].slice(-10).map((d) => ({ ...d })),
      cookies: {
        inherit: Boolean(this.login?.inherit),
        source: this.login?.source ?? null,
        profile: this.login?.profile ?? null,
        bytes: this.login?.bytes ?? 0,
        reason: this.login?.reason ?? null,
        count: this.cookieCount,
      },
    }
  }

  /** 幂等启动：并发调用共享同一个启动 Promise。 */
  async ensureStarted() {
    if (this.browser?.closed) {
      this.cdp?.close()
      this.cdp = null
      this.browser = null
      this.pageSession = null
      this.targetId = null
      this.nodes.clear()
    } else if (this.cdp?.disconnected) {
      this.cdp.close()
      this.cdp = null
      this.pageSession = null
      this.targetId = null
      this.nodes.clear()
      for (const target of this.targets.values()) delete target.sessionId
    }
    if (this.cdp && this.pageSession) return this.status()
    if (this.starting) return this.starting
    this.starting = (async () => {
      try {
        if (!this.browser) {
          this.browser = await this.options.launch({
            exe: this.options.exe,
            userDataDir: this.options.userDataDir,
            headless: this.options.headless,
            timeoutMs: this.options.timeoutMs,
            loginState: this.options.loginState,
          })
          this.login = this.browser.loginState ?? null
        }
        if (!this.cdp) {
          this.cdp = await CdpConnection.connect(this.browser.wsUrl, { timeoutMs: this.options.timeoutMs })
          this.unsubscribe = this.cdp.on((msg) => this.#onEvent(msg))
        }
        mkdirSync(this.options.downloadDir, { recursive: true })
        await this.cdp
          .send('Browser.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: this.options.downloadDir,
            eventsEnabled: true,
          })
          .catch(() => {})
        await this.#attachDefaultPage()
        await this.#countCookies()
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

  async #countCookies() {
    try {
      const r = await this.cdp.send('Storage.getCookies', {}, this.pageSession)
      this.cookieCount = Array.isArray(r?.cookies) ? r.cookies.length : 0
    } catch {
      this.cookieCount = null
    }
  }

  async #attachDefaultPage() {
    const targets = await this.listTargets()
    const saved = this.options.restoreState ? this.readState() : null
    let page = targets.find((t) => t.targetId === saved?.activeTarget)
    if (!page && saved?.activeTarget) {
      const old = saved.targets?.find((t) => t.targetId === saved.activeTarget)
      // 进程重启后 targetId 会变；用脱敏 URL 找回 Chrome 恢复的标签。
      if (old?.url) page = targets.find((t) => safeUrl(t.url) === old.url)
    }
    page ??= targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
    if (!page) {
      const created = await this.cdp.send('Target.createTarget', { url: 'about:blank' })
      page = { targetId: created.targetId, type: 'page', url: 'about:blank', title: '' }
    }
    await this.attach(page.targetId)
  }

  async listTargets() {
    if (!this.cdp) throw browserError('NOT_RUNNING', '浏览器还没启动')
    const { targetInfos = [] } = await this.cdp.send('Target.getTargets')
    const seen = new Set()
    for (const info of targetInfos) {
      if (info.type !== 'page' || info.url?.startsWith('devtools://')) continue
      seen.add(info.targetId)
      const old = this.targets.get(info.targetId) ?? {}
      this.targets.set(info.targetId, {
        ...old,
        targetId: info.targetId,
        type: info.type,
        url: info.url ?? old.url ?? '',
        title: info.title ?? old.title ?? '',
      })
    }
    for (const id of this.targets.keys()) if (!seen.has(id) && id !== this.targetId) this.targets.delete(id)
    await this.#persist()
    return [...this.targets.values()].map((t) => ({
      targetId: t.targetId,
      url: t.url,
      title: t.title,
      active: t.targetId === this.targetId,
      attached: Boolean(t.sessionId),
    }))
  }

  /** attach 并激活一个 page target；重复 attach 会复用 flatten session。 */
  async attach(targetId, { activate = false } = {}) {
    if (!this.cdp) throw browserError('NOT_RUNNING', '浏览器还没启动')
    let current = this.targets.get(targetId)
    let sessionId = current?.sessionId
    if (!sessionId) {
      const attached = await this.cdp.send('Target.attachToTarget', { targetId, flatten: true })
      sessionId = attached.sessionId
    }
    if (!sessionId) throw browserError('CDP_ERROR', `attach ${targetId} 没返回 sessionId`)
    current = { type: 'page', url: '', title: '', ...current, targetId, sessionId, epoch: ++this.docEpoch }
    this.targets.set(targetId, current)
    this.pageSession = sessionId
    this.targetId = targetId
    this.lastUrl = current.url || this.lastUrl
    this.nodes.clear()
    for (const domain of ['Page.enable', 'Runtime.enable', 'DOM.enable', 'Network.enable']) {
      await this.cdp.send(domain, {}, sessionId).catch(() => {})
    }
    if (activate) await this.cdp.send('Page.bringToFront', {}, sessionId).catch(() => {})
    await this.#persist()
    return { targetId, sessionId, epoch: current.epoch }
  }

  async switchTarget(targetId) {
    if (typeof targetId !== 'string' || !targetId) throw browserError('BAD_ARGS', '切换标签需要 targetId')
    const targets = await this.listTargets()
    if (!targets.some((t) => t.targetId === targetId)) throw browserError('BAD_ARGS', `标签不存在：${targetId}`)
    const session = await this.attach(targetId, { activate: true })
    const target = this.targets.get(targetId)
    this.lastUrl = target?.url ?? ''
    return { ok: true, ...session, url: this.lastUrl, title: target?.title ?? '' }
  }

  async newTarget(url = 'about:blank') {
    if (!this.cdp) throw browserError('NOT_RUNNING', '浏览器还没启动')
    if (/^(javascript|data):/i.test(url)) throw browserError('BAD_ARGS', '新标签不接受 javascript: / data: URL')
    const created = await this.cdp.send('Target.createTarget', { url: url || 'about:blank' })
    this.targets.set(created.targetId, { targetId: created.targetId, type: 'page', url: url || 'about:blank', title: '' })
    await this.attach(created.targetId, { activate: true })
    await this.waitForLoad({ timeoutMs: this.options.timeoutMs, quietMs: 200 }).catch(() => {})
    return { ok: true, targetId: created.targetId, url: this.lastUrl ?? url }
  }

  async closeTarget(targetId = this.targetId) {
    if (!this.cdp) throw browserError('NOT_RUNNING', '浏览器还没启动')
    if (!targetId) throw browserError('BAD_ARGS', '没有可关闭的标签')
    const wasActive = targetId === this.targetId
    await this.cdp.send('Target.closeTarget', { targetId })
    this.targets.delete(targetId)
    if (wasActive) {
      this.pageSession = null
      this.targetId = null
      this.lastUrl = null
      this.nodes.clear()
      const next = [...this.targets.values()].find((t) => t.type === 'page')
      if (next) await this.switchTarget(next.targetId)
    }
    await this.#persist()
    return { ok: true, closed: targetId, activeTarget: this.targetId }
  }

  #onEvent(msg) {
    if (msg.method === 'Target.targetInfoChanged') {
      const info = msg.params?.targetInfo
      if (info?.targetId) this.targets.set(info.targetId, { ...this.targets.get(info.targetId), ...info })
      if (info?.targetId === this.targetId && info.url) this.lastUrl = info.url
      return
    }
    if (msg.method === 'Target.targetDestroyed') {
      const id = msg.params?.targetId
      const old = this.targets.get(id)
      this.targets.delete(id)
      if (old?.sessionId) {
        for (const key of this.networkPending.keys()) if (key.startsWith(`${old.sessionId}:`)) this.networkPending.delete(key)
        this.networkActivity.delete(old.sessionId)
        this.domChangedAt.delete(old.sessionId)
      }
      if (id === this.targetId) {
        this.targetId = null
        this.pageSession = null
        this.nodes.clear()
        this.docEpoch++
      }
      return
    }

    if (msg.method === 'Browser.downloadWillBegin') {
      const p = msg.params ?? {}
      if (p.guid) this.downloads.set(p.guid, {
        id: p.guid,
        state: 'inProgress',
        filename: path.basename(p.suggestedFilename || p.guid),
        url: safeUrl(p.url),
        receivedBytes: 0,
        totalBytes: p.totalBytes ?? null,
      })
      return
    }
    if (msg.method === 'Browser.downloadProgress') {
      const p = msg.params ?? {}
      const old = this.downloads.get(p.guid)
      if (old) this.downloads.set(p.guid, { ...old, state: p.state, receivedBytes: p.receivedBytes ?? 0, totalBytes: p.totalBytes ?? old.totalBytes })
      return
    }

    const sid = msg.sessionId
    if (!sid) return
    if (msg.method === 'Network.requestWillBeSent') {
      const id = msg.params?.requestId
      if (id) this.networkPending.set(`${sid}:${id}`, true)
      this.networkActivity.set(sid, Date.now())
      return
    }
    if (msg.method === 'Network.loadingFinished' || msg.method === 'Network.loadingFailed') {
      const id = msg.params?.requestId
      if (id) this.networkPending.delete(`${sid}:${id}`)
      this.networkActivity.set(sid, Date.now())
      return
    }
    if (msg.method === 'DOM.documentUpdated') this.domChangedAt.set(sid, Date.now())

    const entry = [...this.targets.values()].find((t) => t.sessionId === sid)
    if (msg.method === 'Page.frameNavigated') {
      const frame = msg.params?.frame
      if (entry && frame?.url && !frame.parentId) entry.url = frame.url
      if (sid === this.pageSession && frame?.url && !frame.parentId) this.lastUrl = frame.url
    }
    if (
      sid === this.pageSession &&
      (msg.method === 'Page.frameNavigated' || msg.method === 'DOM.documentUpdated' || msg.method === 'Page.navigatedWithinDocument')
    ) {
      this.docEpoch++
      this.nodes.clear()
      this.#persist().catch(() => {})
    }
  }

  async #persist() {
    const statePath = this.options.statePath
    if (!statePath) return
    const payload = {
      version: 2,
      at: Date.now(),
      docEpoch: this.docEpoch,
      activeTarget: this.targetId,
      // URL 去掉 query/hash，避免把登录令牌写进 state.json。
      targets: [...this.targets.values()].map((t) => ({ targetId: t.targetId, url: safeUrl(t.url), epoch: t.epoch })),
    }
    try {
      mkdirSync(path.dirname(statePath), { recursive: true })
      const tmp = `${statePath}.tmp`
      writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: 'utf8', mode: 0o600 })
      renameSync(tmp, statePath)
    } catch {
      // 状态落盘失败不影响主流程。
    }
  }

  readState() {
    if (!this.options.statePath) return null
    try {
      const parsed = JSON.parse(readFileSync(this.options.statePath, 'utf8'))
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }

  async navigate(url) {
    if (!this.cdp || !this.pageSession) throw browserError('NOT_RUNNING', '浏览器还没启动')
    if (typeof url !== 'string' || !url.trim()) throw browserError('BAD_ARGS', 'navigate 需要 url')
    const value = url.trim()
    if (/^(javascript|data):/i.test(value)) throw browserError('BAD_ARGS', 'navigate 不接受 javascript: / data: URL')
    await this.cdp.send('Page.navigate', { url: value }, this.pageSession)
    this.lastUrl = value
    await this.waitForLoad()
    return { ok: true, url: value, docEpoch: this.docEpoch }
  }

  async waitForLoad(options) {
    return waitForLoad(this, options)
  }

  async waitForElement(options) {
    return waitForElement(this, options)
  }

  async settle(options) {
    return settleAfterAction(this, options)
  }

  async evaluate(expression) {
    if (!this.cdp || !this.pageSession) throw browserError('NOT_RUNNING', '浏览器还没启动')
    const r = await this.cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, this.pageSession)
    if (r?.exceptionDetails) throw browserError('CDP_ERROR', r.exceptionDetails.text ?? '页面脚本抛错')
    return r?.result?.value
  }

  async screenshot({ format = 'png' } = {}) {
    if (!this.cdp || !this.pageSession) throw browserError('NOT_RUNNING', '浏览器还没启动')
    if (!['png', 'jpeg'].includes(format)) throw browserError('BAD_ARGS', '截图格式只支持 png/jpeg')
    const [shot, viewport] = await Promise.all([
      this.cdp.send('Page.captureScreenshot', { format, fromSurface: true }, this.pageSession),
      this.evaluate('({ width: innerWidth, height: innerHeight, devicePixelRatio })').catch(() => ({ width: 0, height: 0, devicePixelRatio: 1 })),
    ])
    if (!shot?.data) throw browserError('CDP_ERROR', '截图没有返回图像数据')
    return { base64: shot.data, format, ...viewport }
  }

  async waitForDownload(before = new Set(), { timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      for (const item of this.downloads.values()) {
        if (before.has(item.id)) continue
        if (item.state === 'canceled') throw browserError('DOWNLOAD_FAILED', `下载被取消：${item.filename}`)
        if (item.state === 'completed') {
          const file = path.join(this.options.downloadDir, item.filename)
          const exists = existsSync(file)
          return { ...item, path: exists ? file : null, bytes: exists ? statSync(file).size : item.receivedBytes }
        }
      }
      await sleep(100)
    }
    throw browserError('DOWNLOAD_TIMEOUT', `下载在 ${timeoutMs}ms 内未完成`)
  }

  async observe(options = {}) {
    await this.ensureStarted()
    return buildSnapshot(this, options)
  }

  async act(options = {}) {
    await this.ensureStarted()
    const key = typeof options.idempotencyKey === 'string' ? options.idempotencyKey.trim() : ''
    if (key && this.actionResults.has(key)) {
      const cached = structuredClone(this.actionResults.get(key).result)
      return { ...cached, deduped: true }
    }
    if (key && this.actionInflight.has(key)) return this.actionInflight.get(key)
    const running = runSteps(this, options)
    if (key) this.actionInflight.set(key, running)
    try {
      const result = await running
      if (key) {
        this.actionResults.set(key, { at: Date.now(), result: structuredClone(result) })
        while (this.actionResults.size > 50) this.actionResults.delete(this.actionResults.keys().next().value)
      }
      return result
    } finally {
      if (key) this.actionInflight.delete(key)
    }
  }

  async close() {
    try {
      this.unsubscribe?.()
    } catch {
      // ignore
    }
    this.unsubscribe = null
    if (this.cdp) {
      await this.cdp.send('Browser.close').catch(() => {})
      this.cdp.close()
    }
    this.cdp = null
    this.pageSession = null
    this.targetId = null
    this.lastUrl = null
    this.nodes.clear()
    this.networkPending.clear()
    this.cookieCount = null
    if (this.browser) await this.browser.close().catch(() => {})
    this.browser = null
    await this.#persist()
    return { ok: true, state: 'stopped' }
  }
}
