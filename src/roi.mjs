// VERIFY 层：动作影响域（ROI）推导与校验
// 核心假设：一次动作只应该改变它该改变的那一小块。若动作后 ROI 内没变化 → 动作没生效；
// 若 ROI 外大面积变化 → 有弹窗/遮挡/意外副作用。两种都是要上报的异常信号。
export const DEFAULT_ROI = { margin: 24, minSize: 96, outsideRatioLimit: 0.12 }

export function expandBox(box, { margin = DEFAULT_ROI.margin, minSize = DEFAULT_ROI.minSize, width, height } = {}) {
  if (!box || box.w <= 0 || box.h <= 0) {
    // 没有可用包围盒时退化为整屏（宁可贵一点，不要漏判）
    return { x: 0, y: 0, w: width ?? 0, h: height ?? 0 }
  }
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  let w = Math.max(box.w + margin * 2, minSize)
  let h = Math.max(box.h + margin * 2, minSize)
  let x = Math.round(cx - w / 2)
  let y = Math.round(cy - h / 2)
  if (width != null && height != null) {
    w = Math.min(w, width)
    h = Math.min(h, height)
    x = Math.max(0, Math.min(x, width - w))
    y = Math.max(0, Math.min(y, height - h))
  }
  return { x, y, w: Math.round(w), h: Math.round(h) }
}

/** 把整屏灰度裁成 ROI 灰度 */
export function cropGray(gray, width, roi) {
  const out = new Uint8Array(roi.w * roi.h)
  for (let y = 0; y < roi.h; y++) {
    const src = (roi.y + y) * width + roi.x
    out.set(gray.subarray(src, src + roi.w), y * roi.w)
  }
  return out
}

/** ROI 内的平均绝对差（0..1），比整屏分更灵敏 */
export function meanAbsDiff(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return a.length ? sum / a.length / 255 : 0
}

/**
 * 校验一次动作：ROI 内变化是否落在期望区间，ROI 外是否被污染。
 * @param {{expect:number, tolerate:number}} policy expect=期望最小变化量
 */
export function verifyAction(before, after, width, height, roi, policy = {}) {
  const expect = policy.expect ?? 0.02
  const tolerate = policy.outsideRatioLimit ?? DEFAULT_ROI.outsideRatioLimit
  const roiBefore = cropGray(before, width, roi)
  const roiAfter = cropGray(after, width, roi)
  const inside = meanAbsDiff(roiBefore, roiAfter)
  const full = meanAbsDiff(before, after)
  const outside = full > inside
    ? Math.max(0, (full * before.length - inside * roiBefore.length) / Math.max(1, before.length - roiBefore.length))
    : 0
  const verdict = inside < expect ? 'no-effect' : outside > tolerate ? 'side-effect' : 'ok'
  return { inside: Number(inside.toFixed(4)), outside: Number(outside.toFixed(4)), verdict, roi }
}
