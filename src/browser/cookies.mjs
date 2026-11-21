// 登录态继承：把本机 Edge / Chrome 的 cookie 库复制进 daemon 自己的临时 profile。
//
// 为什么是"复制"而不是"直连"：
//  - 直连用户 profile 会被浏览器单实例合并、且写坏用户配置的风险不可接受；
//  - Chromium 的 cookie 是 `Local State` 里的 os_crypt.encrypted_key + DPAPI 加密的 AES-GCM，
//    同机同用户复制这两份文件后，新实例通常仍能解密（DPAPI 是用户级，不绑进程）。
//
// 边界：Windows / Chrome 127+ 引入了 App-Bound Encryption（cookie 绑应用身份），
// 复制后可能解不开。这里不做保证，只用 CDP 的 Storage.getCookies 数一下数量回传，
// 真实结果由调用方如实报告（见 docs/BROWSER.md「登录态与风险」）。
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

/** 已知浏览器的 User Data 根目录（Windows 惯例路径）。 */
export const USER_DATA_ROOTS = {
  edge: ['Microsoft', 'Edge', 'User Data'],
  chrome: ['Google', 'Chrome', 'User Data'],
}

/** 从可执行文件名判断是 Edge 还是 Chrome；认不出来返回 null。 */
export function browserFlavor(exe) {
  if (typeof exe !== 'string' || !exe) return null
  const base = path.basename(exe).toLowerCase()
  if (base === 'msedge.exe' || base.includes('edge')) return 'edge'
  if (base === 'chrome.exe' || base.includes('chrome')) return 'chrome'
  return null
}

function localAppData() {
  return process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
}

/** 某个浏览器的 User Data 根目录（不保证存在）。 */
export function userDataRoot(flavor) {
  const parts = USER_DATA_ROOTS[flavor]
  if (!parts) return null
  return path.join(localAppData(), ...parts)
}

/**
 * 找本机可用的 User Data 目录：显式路径 > 与浏览器同族的默认路径 > 任一存在的候选。
 * 找不到返回 null（不抛错 —— 继承登录态是尽力而为的增强）。
 */
export function findUserDataDir({ exe = null, userDataDir = null } = {}) {
  if (userDataDir && existsSync(userDataDir)) return userDataDir
  const flavor = browserFlavor(exe)
  const ordered = flavor ? [flavor, ...Object.keys(USER_DATA_ROOTS).filter((k) => k !== flavor)] : Object.keys(USER_DATA_ROOTS)
  for (const f of ordered) {
    const root = userDataRoot(f)
    if (root && existsSync(root)) return root
  }
  return null
}

function cookieFile(profileDir) {
  return path.join(profileDir, 'Network', 'Cookies')
}

/**
 * 列出 User Data 下真有 cookie 库的 profile 名（Default / Profile 1 …）。
 * 跳过 System Profile / Guest Profile / 以 . 开头的目录。
 */
export function listProfiles(root) {
  if (!root || !existsSync(root)) return []
  let names = []
  try {
    names = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .filter((n) => !/^(System Profile|Guest Profile|Crashpad|ShaderCache|GrShaderCache|GraphiteDawnCache|component_crx_cache|extensions_crx_cache)$/i.test(n))
  } catch {
    return []
  }
  return names
    .filter((n) => existsSync(cookieFile(path.join(root, n))))
    .sort((a, b) => {
      // Default 优先，其余按 Cookies 的修改时间新→旧
      if (a === 'Default') return -1
      if (b === 'Default') return 1
      return mtime(cookieFile(path.join(root, b))) - mtime(cookieFile(path.join(root, a)))
    })
}

function mtime(p) {
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 选一个 profile：'auto' = Default 若可读、否则最新的；指定名字则直接用（不存在就回退 auto）。
 */
export function pickProfile(root, wanted = 'auto') {
  const list = listProfiles(root)
  if (!list.length) return null
  if (wanted && wanted !== 'auto' && list.includes(wanted)) return wanted
  return list[0]
}

function copyOne(from, to) {
  mkdirSync(path.dirname(to), { recursive: true })
  copyFileSync(from, to)
  return statSize(to)
}

function statSize(p) {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

/**
 * 把源 profile 的登录态复制到 destDir（一个新的 user-data-dir）：
 *   Local State（DPAPI 加密密钥）+ <profile>/Network/Cookies（含 -journal/-wal/-shm）。
 * 返回 { ok, sourceRoot, profile, bytes, files, reason }，永不抛错。
 */
export function copyLoginState({ sourceRoot = null, profile = 'auto', destDir }) {
  const out = { ok: false, sourceRoot, profile: null, bytes: 0, files: [], reason: null }
  if (!destDir) return { ...out, reason: 'NO_DEST' }
  if (!sourceRoot || !existsSync(sourceRoot)) return { ...out, reason: 'NO_SOURCE' }

  const chosen = pickProfile(sourceRoot, profile)
  if (!chosen) return { ...out, reason: 'NO_PROFILE' }
  out.profile = chosen

  const srcProfile = path.join(sourceRoot, chosen)
  try {
    const localState = path.join(sourceRoot, 'Local State')
    if (existsSync(localState)) out.bytes += copyOne(localState, path.join(destDir, 'Local State'))
    for (const name of ['Cookies', 'Cookies-journal', 'Cookies-wal', 'Cookies-shm']) {
      const from = path.join(srcProfile, 'Network', name)
      if (!existsSync(from)) continue
      const to = path.join(destDir, chosen, 'Network', name)
      out.bytes += copyOne(from, to)
      out.files.push(name)
    }
    out.ok = existsSync(path.join(destDir, chosen, 'Network', 'Cookies'))
    if (!out.ok) out.reason = 'COPY_FAILED'
  } catch (e) {
    out.ok = false
    out.reason = e?.code ?? 'COPY_FAILED'
    out.error = e?.message ?? String(e)
  }
  return out
}

/** 让 launch 的返回对象能安全序列化（不把 fs 句柄之类带出去）。 */
export function loginStateSummary(state) {
  if (!state) return { inherit: false, reason: 'DISABLED' }
  return {
    inherit: Boolean(state.ok),
    source: state.sourceRoot ?? null,
    profile: state.profile ?? null,
    bytes: state.bytes ?? 0,
    files: state.files ?? [],
    reason: state.reason ?? null,
    error: state.error ?? null,
  }
}
