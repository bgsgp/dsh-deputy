// 极简 CDP 客户端：一条 WebSocket，多 target 用 flatten sessionId 复用。
//
// 只做协议：send() 等回执、on() 收事件、close() 收尾。
// 语义（快照、等待、动作）在上层 snapshot.mjs / act.mjs 里，别把业务塞进来。
import { browserError } from './errors.mjs'

export class CdpConnection {
  constructor(ws, { timeoutMs = 15000 } = {}) {
    this.ws = ws
    this.timeoutMs = timeoutMs
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.closed = false
    ws.addEventListener('message', (ev) => this.#onMessage(ev.data))
    ws.addEventListener('close', () => this.#failAll('连接已关闭'))
    ws.addEventListener('error', () => this.#failAll('连接出错'))
  }

  static connect(url, opts = {}) {
    if (typeof WebSocket !== 'function') {
      return Promise.reject(browserError('CDP_ERROR', '当前 Node 没有全局 WebSocket（需要 >= 22）'))
    }
    return new Promise((resolve, reject) => {
      let ws
      try {
        ws = new WebSocket(url)
      } catch (e) {
        reject(browserError('CDP_ERROR', `连不上 ${url}: ${e.message}`))
        return
      }
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { ws.close() } catch { /* 忽略关闭异常 */ }
        reject(browserError('CDP_ERROR', `连接 ${url} 超时`))
      }, opts.timeoutMs ?? 15000)
      ws.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(new CdpConnection(ws, opts))
      })
      ws.addEventListener('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(browserError('CDP_ERROR', `连接 ${url} 失败`))
      })
      ws.addEventListener('close', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(browserError('CDP_ERROR', `连接 ${url} 在握手前关闭`))
      })
    })
  }

  #onMessage(raw) {
    let msg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.reject(browserError('CDP_ERROR', `${p.method}: ${msg.error.message}`))
      else p.resolve(msg.result)
      return
    }
    for (const fn of this.listeners) {
      try {
        fn(msg)
      } catch {
        /* 单个监听器抛错不影响协议 */
      }
    }
  }

  #failAll(reason) {
    this.closed = true
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(browserError('CDP_ERROR', reason))
    }
    this.pending.clear()
  }

  /** 发一条 CDP 命令；sessionId 用于 flatten 模式下的某个 target。 */
  send(method, params = {}, sessionId) {
    if (this.disconnected) return Promise.reject(browserError('CDP_ERROR', '连接已关闭'))
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(browserError('CDP_ERROR', `${method} 超时`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer, method })
      try {
        this.ws.send(JSON.stringify(payload))
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(browserError('CDP_ERROR', `发送失败: ${e.message}`))
      }
    })
  }

  get disconnected() {
    return this.closed || !this.ws || this.ws.readyState === WebSocket.CLOSING || this.ws.readyState === WebSocket.CLOSED
  }

  on(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  close() {
    this.#failAll('主动关闭')
    try {
      this.ws.close()
    } catch {
      /* 已经关了 */
    }
  }
}
