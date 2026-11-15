// SHEET 层：把多帧压成一张 4×4 联系表（contact sheet）
// 为什么拼图：会话里每送一帧 = 一次图像 token 计费。逐帧送 16 帧的成本 ≈ 16 张图；
// 拼成一张 4×4 只花 1 张图的价钱，却保留了 16 个时间切片。这是 deputy 省 token 的主要手段。
import { encodeGrayPng } from './png.mjs'

// 3×5 点阵字体，够画 "F07 0.42" 这种标签即可
const FONT = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '010', '010', '010', '010'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '011', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '001', '001', '001'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '#': ['101', '111', '101', '111', '101'],
  '.': ['000', '000', '000', '000', '010'],
  ':': ['000', '010', '000', '010', '000'],
  '-': ['000', '000', '111', '000', '000'],
  x: ['000', '101', '000', '101', '000'],
  F: ['111', '100', '111', '100', '100'],
  S: ['111', '100', '111', '001', '111'],
  T: ['111', '010', '010', '010', '010'],
  ' ': ['000', '000', '000', '000', '000'],
}

function drawText(gray, width, height, text, x0, y0, scale = 2, ink = 255) {
  let x = x0
  for (const ch of String(text)) {
    const glyph = FONT[ch] ?? FONT[' ']
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 3; col++) {
        if (glyph[row][col] !== '1') continue
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = x + col * scale + dx
            const py = y0 + row * scale + dy
            if (px >= 0 && px < width && py >= 0 && py < height) gray[py * width + px] = ink
          }
        }
      }
    }
    x += 4 * scale
  }
  return x
}

function blit(gray, width, src, sw, sh, dx, dy, dw, dh) {
  for (let y = 0; y < dh; y++) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dh))
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dw))
      const px = dx + x
      const py = dy + y
      if (px < 0 || px >= width) continue
      gray[py * width + px] = src[sy * sw + sx]
    }
  }
}

/**
 * @param {Array<{gray:Uint8Array,width:number,height:number,label?:string}>} frames 最多 16 帧
 * @param {{cols?:number,cell?:number,gap?:number,labelScale?:number}} opts
 */
export function packSheet(frames, opts = {}) {
  const cols = opts.cols ?? 4
  const rows = Math.ceil(frames.length / cols)
  const cell = opts.cell ?? 192
  const gap = opts.gap ?? 6
  const labelScale = opts.labelScale ?? 2
  const labelH = 5 * labelScale + 4

  const width = cols * cell + (cols + 1) * gap
  const height = rows * (cell + labelH) + (rows + 1) * gap
  const sheet = new Uint8Array(width * height).fill(18) // 深灰底

  frames.forEach((f, i) => {
    const r = Math.floor(i / cols)
    const c = i % cols
    const x = gap + c * (cell + gap)
    const y = gap + r * (cell + labelH + gap)
    // 帧区
    const imgY = y + labelH
    for (let yy = 0; yy < cell; yy++) {
      const rowStart = (imgY + yy) * width + x
      sheet.fill(0, rowStart, rowStart + cell)
    }
    blit(sheet, width, f.gray, f.width, f.height, x, imgY, cell, cell)
    // 标签条
    drawText(sheet, width, height, f.label ?? `#${String(i).padStart(2, '0')}`, x + 2, y, labelScale)
  })

  return {
    gray: sheet,
    width,
    height,
    frames: frames.length,
    png: () => encodeGrayPng(sheet, width, height),
  }
}

/** 每帧给一个 "#idx score" 的标签，方便模型在拼图里直接读到量化信息 */
export function labelOf(index, score) {
  return `#${String(index).padStart(2, '0')} ${score.toFixed(2)}`
}
