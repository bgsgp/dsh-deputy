// 进程内状态总线
//
// dsh-deputy/os 与 dsh-deputy/browser 是同一个插件包里的两个组件（同一个 Node 进程、同一份模块实例），
// 但它们在插件管理器里各自是独立的 Cordis 条目，彼此不 inject。状态点又要把两个组件的健康度合成一个颜色，
// 所以在模块层放一个极小的共享存储：两个组件各写自己的一段，客户端只读快照。
//
// 语义（与侧栏状态点一致）：
//   running  = 有活着的宿主/浏览器实例
//   error    = 最近一次操作失败，且没有被后续成功清掉
//   idle     = 既没在跑也没出错 → 灰点
const blank = (state) => ({ state, running: false, error: null, at: 0, detail: null })

const store = {
  os: blank('idle'),
  browser: blank('stopped'),
}

function normalize(patch, prev) {
  const next = { ...prev, ...patch, at: Date.now() }
  next.running = Boolean(patch.running ?? next.running)
  // 传 error 才能改错误位：成功路径显式传 error: null 清掉红点。
  if (Object.prototype.hasOwnProperty.call(patch, 'error')) next.error = patch.error ? String(patch.error) : null
  return next
}

export function setOsStatus(patch = {}) {
  store.os = normalize(patch, store.os)
  return store.os
}

export function setBrowserStatus(patch = {}) {
  store.browser = normalize(patch, store.browser)
  return store.browser
}

/** 把一段错误记到某个组件上（红点） */
export function noteFailure(which, error) {
  const patch = { running: false, error: error?.message ?? String(error ?? '未知错误'), state: 'error' }
  return which === 'browser' ? setBrowserStatus(patch) : setOsStatus(patch)
}

export function snapshot() {
  const os = store.os
  const browser = store.browser
  const errored = Boolean(os.error || browser.error)
  const running = Boolean(os.running || browser.running)
  return {
    ok: true,
    // 侧栏状态点只认这个：error > running > idle
    level: errored ? 'error' : running ? 'running' : 'idle',
    os: { ...os },
    browser: { ...browser },
    at: Date.now(),
  }
}

/** 测试用：把总线恢复到初始态 */
export function resetStatus() {
  store.os = blank('idle')
  store.browser = blank('stopped')
}
