// 落盘回读：保存类动作的像素校验再"像"，也不证明文件真的写到磁盘上。
//
// 动机：保存一次文档，ROI 里变化的往往只是保存对话框的消失或状态栏一闪；反过来，
// 对话框挡住 ROI 时画面没变化，文件却已经写好了。像素在这里既会误判成功也会误判失败，
// 唯一可靠的证据是文件系统本身（存在 + 大小 + 是不是普通文件）。
//
// 纯判定 + 可注入 fs：单测在没有 Windows 的机器上也能跑全部分支。
import { statSync } from 'node:fs'

/** 落盘回读的结论码；同时作为 deputy_act 失败时的 verdict，模型一眼能看懂卡在哪。 */
export const FILE_VERDICT = {
  OK: 'file-ok',
  NO_PATH: 'file-no-path',
  MISSING: 'file-missing',
  NOT_FILE: 'file-not-a-file',
  TOO_SMALL: 'file-too-small',
}

/**
 * 回读一个文件，判断它是否真的落盘。
 * @param {{path:string,minBytes?:number}} spec
 * @param {{statSync?:Function}} [deps] 单测注入
 * @returns {{verified:boolean,reason:string,path?:string,bytes?:number,minBytes?:number}}
 */
export function verifyFile(spec, deps = {}) {
  const stat = deps.statSync ?? statSync
  const path = typeof spec?.path === 'string' ? spec.path.trim() : ''
  if (!path) return { verified: false, reason: FILE_VERDICT.NO_PATH }
  const minBytes = Number.isFinite(Number(spec?.minBytes)) ? Number(spec.minBytes) : 0
  let st
  try {
    st = stat(path)
  } catch {
    return { verified: false, reason: FILE_VERDICT.MISSING, path }
  }
  if (typeof st?.isFile === 'function' && !st.isFile()) {
    return { verified: false, reason: FILE_VERDICT.NOT_FILE, path }
  }
  const bytes = Number(st?.size ?? 0)
  if (bytes < minBytes) {
    return { verified: false, reason: FILE_VERDICT.TOO_SMALL, path, bytes, minBytes }
  }
  return { verified: true, reason: FILE_VERDICT.OK, path, bytes, minBytes }
}

/**
 * 把像素闭环的结论和落盘回读的结论合成一个。
 *
 * 保存类动作以文件为最终裁判：
 *  - 文件在 → 即使像素"没变化"也算成功（对话框挡住了 ROI 就是这种情况）；
 *  - 文件不在 → 即使像素"变了"也必须判失败（变的是对话框，不是磁盘）。
 * 动作本身已经硬失败（halt/error）时保留原判，别让文件结论盖掉真正的故障。
 */
export function mergeVerdict(pixel, file) {
  const p = pixel ?? {}
  // 动作根本没执行成功（halt/error）：文件状态只是附带信息，不能翻案。
  if (p.ok === false && p.verdict !== 'no-effect') return { ...p, file }
  if (file?.verified) return { ...p, ok: true, verdict: FILE_VERDICT.OK, file }
  return { ...p, ok: false, verdict: file?.reason ?? FILE_VERDICT.MISSING, file }
}
