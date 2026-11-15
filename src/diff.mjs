// SENSE 层：帧差评分
// 目标不是"画面像不像"，而是"这一帧值不值得花 token 送进会话"。
// 三个信号：dHash 距离（全局结构漂移）、网格变化占比（局部动作痕迹）、网格变化包围盒（后续 ROI 校验的锚点）
export const DEFAULT_SENSE = {
  hashW: 9,
  hashH: 8,
  gridCols: 8,
  gridRows: 8,
  cellThreshold: 0.06, // 单元格平均灰度差超过它才算"变了"
  weights: { hash: 0.4, grid: 0.6 },
  tiers: { still: 0.08, minor: 0.26, meaningful: 0.5 }, // 分数 < 阈值即落入该档
}

/** RGBA(4通道) 或 RGB(3通道) → 灰度 */
export function toGray(buf, width, height, channels = 4) {
  const out = new Uint8Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += channels) {
    out[i] = (buf[p] * 77 + buf[p + 1] * 151 + buf[p + 2] * 28) >> 8
  }
  return out
}

/** 盒式下采样（整数比邻域平均），速度优先于质量 */
export function downscaleGray(gray, width, height, dw, dh) {
  const out = new Uint8Array(dw * dh)
  const sx = width / dw
  const sy = height / dh
  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * sy)
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * sx)
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx))
      let sum = 0
      let n = 0
      for (let yy = y0; yy < y1 && yy < height; yy++) {
        const row = yy * width
        for (let xx = x0; xx < x1 && xx < width; xx++) {
          sum += gray[row + xx]
          n++
        }
      }
      out[y * dw + x] = n ? sum / n : 0
    }
  }
  return out
}

/** 64bit 差值哈希：相邻像素比较，抗全局亮度漂移 */
export function dHash(graySmall, w, h) {
  let bits = 0n
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      bits <<= 1n
      if (graySmall[y * w + x] > graySmall[y * w + x + 1]) bits |= 1n
    }
  }
  return bits
}

export function hamming(a, b) {
  let v = a ^ b
  let n = 0
  while (v) {
    n += Number(v & 1n)
    v >>= 1n
  }
  return n
}

/** 网格级变化：返回变化占比 + 像素坐标包围盒 */
export function gridDelta(prev, next, width, height, opts = {}) {
  const cols = opts.gridCols ?? DEFAULT_SENSE.gridCols
  const rows = opts.gridRows ?? DEFAULT_SENSE.gridRows
  const cellThreshold = opts.cellThreshold ?? DEFAULT_SENSE.cellThreshold
  const cells = []
  let changed = 0
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      const x0 = Math.floor((gx * width) / cols)
      const x1 = Math.floor(((gx + 1) * width) / cols)
      const y0 = Math.floor((gy * height) / rows)
      const y1 = Math.floor(((gy + 1) * height) / rows)
      let sum = 0
      let n = 0
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = y * width + x
          sum += Math.abs(next[i] - prev[i])
          n++
        }
      }
      const delta = n ? sum / n / 255 : 0
      const hit = delta > cellThreshold
      cells.push({ gx, gy, delta, hit })
      if (hit) {
        changed++
        if (x0 < minX) minX = x0
        if (y0 < minY) minY = y0
        if (x1 > maxX) maxX = x1
        if (y1 > maxY) maxY = y1
      }
    }
  }
  const ratio = cols * rows ? changed / (cols * rows) : 0
  // 变化幅度加权：同样是"变了 3 个格子"，全屏弹窗和光标闪烁不该同档
  const magnitude = cells.reduce((a, c) => a + c.delta, 0) / (cols * rows)
  const box = changed
    ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
    : { x: 0, y: 0, w: 0, h: 0 }
  return { ratio, magnitude, box, changed, cells }
}

export function tierOf(score, tiers = DEFAULT_SENSE.tiers) {
  if (score < tiers.still) return 'still'
  if (score < tiers.minor) return 'minor'
  if (score < tiers.meaningful) return 'meaningful'
  return 'major'
}

/**
 * 两帧（已灰度、同尺寸）合成一个证据分。
 * @returns {{score:number,tier:string,hashDistance:number,ratio:number,magnitude:number,box:object}}
 */
export function scoreFrame(prev, next, width, height, opts = {}) {
  const cfg = { ...DEFAULT_SENSE, ...opts }
  const w = cfg.hashW
  const h = cfg.hashH
  const pSmall = downscaleGray(prev, width, height, w, h)
  const nSmall = downscaleGray(next, width, height, w, h)
  const hd = hamming(dHash(pSmall, w, h), dHash(nSmall, w, h))
  const g = gridDelta(prev, next, width, height, cfg)
  const hashPart = hd / ((w - 1) * h)
  const score = cfg.weights.hash * hashPart + cfg.weights.grid * Math.min(1, g.ratio * 0.7 + g.magnitude * 3)
  return {
    score: Number(score.toFixed(4)),
    tier: tierOf(score, cfg.tiers),
    hashDistance: hd,
    ratio: Number(g.ratio.toFixed(4)),
    magnitude: Number(g.magnitude.toFixed(4)),
    box: g.box,
    cells: g.cells,
  }
}
