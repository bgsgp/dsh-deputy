// RUNNER 层：observe → act → verify 的闭环，依赖全部注入，便于在没有 Windows 的环境里跑单测
//
// 与逐帧截图的传统做法相比，这里的两个关键收敛：
//  1) 只在"变化跨档"时把帧收进 buffer，攒满 16 帧才推 1 张拼图；
//  2) 每个动作后只校验它本该影响的那块 ROI，而不是整屏重看。
import { scoreFrame, tierOf, DEFAULT_SENSE } from './diff.mjs'
import { packSheet, labelOf } from './sheet.mjs'
import { expandBox, verifyAction, DEFAULT_ROI } from './roi.mjs'
import { Budget } from './budget.mjs'

const TIER_RANK = { still: 0, minor: 1, meaningful: 2, major: 3 }

export function roiForAction(a, ctx) {
  const size = { width: ctx.width, height: ctx.height }
  if (a.payload?.ref?.rect) return expandBox(a.payload.ref.rect, size)
  if (a.payload?.x != null && a.payload?.y != null) {
    return expandBox({ x: a.payload.x - 2, y: a.payload.y - 2, w: 4, h: 4 }, size)
  }
  if (ctx.lastBox) return expandBox(ctx.lastBox, size)
  return expandBox(null, size)
}

/**
 * @param {object} deps
 * @param {{capture:()=>Promise<{gray:Uint8Array,width:number,height:number}>}} deps.sensor
 * @param {{perform:(a:object)=>Promise<void>}} deps.actuator
 * @param {(ev:object)=>Promise<void>|void} [deps.onEvidence] 把拼图交给会话（DSH 里就是 attachments）
 */
export function createDeputy({ sensor, actuator, onEvidence, budget = new Budget(), policy = {} }) {
  const cfg = {
    sense: { ...DEFAULT_SENSE, ...(policy.sense ?? {}) },
    roi: { ...DEFAULT_ROI, ...(policy.roi ?? {}) },
    shipAt: policy.shipAt ?? 'meaningful', // 达到这个档才值得花一张图的 token
    settleMs: policy.settleMs ?? 220,       // 动作后等 UI 渲染稳定
    ...policy,
  }

  let prev = null
  let lastBox = null
  let lastShippedHash = null
  let pending = []
  let index = 0

  async function grab() {
    const f = await sensor.capture()
    budget.noteCapture()
    return f
  }

  /** 采一帧并打分；越过 shipAt 的帧进缓冲，满 16 帧自动出图 */
  async function observe() {
    if (!budget.canCapture()) return { skipped: 'budget' }
    const f = await grab()
    if (!prev) {
      prev = f
      return { first: true, tier: 'major', score: 1 }
    }
    const s = scoreFrame(prev.gray, f.gray, f.width, f.height, cfg.sense)
    const deg = budget.degradation()
    if (deg.captureRatio < 1 && s.tier !== 'major') {
      prev = f
      return { skipped: 'coarse', ...s }
    }
    const passed = TIER_RANK[s.tier] >= TIER_RANK[cfg.shipAt]
    if (passed) {
      pending.push({ gray: f.gray, width: f.width, height: f.height, score: s.score, tier: s.tier })
      index++
      lastBox = s.box
      if (pending.length >= budget.cfg.maxFramesPerSheet) await flush()
    }
    prev = f
    return s
  }

  async function flush(reason = 'full') {
    if (!pending.length) return null
    if (!budget.canShipSheet()) {
      pending = []
      return { dropped: 'sheet-budget' }
    }
    const frames = pending.splice(0, budget.cfg.maxFramesPerSheet)
    const sheet = packSheet(
      frames.map((f, i) => ({ gray: f.gray, width: f.width, height: f.height, label: labelOf(i, f.score) })),
    )
    budget.noteSheet()
    // 同一画面反复出现的（光标闪烁、时钟跳秒）不该重复占预算
    const hashKey = frames.map((f) => f.tier + f.score.toFixed(2)).join('|')
    const deduped = hashKey === lastShippedHash
    lastShippedHash = hashKey
    const ev = {
      reason,
      sheet,
      png: sheet.png(),
      frames: frames.map((f) => ({ score: f.score, tier: f.tier })),
      deduped,
      budget: budget.snapshot(),
    }
    if (onEvidence && !deduped) await onEvidence(ev)
    return ev
  }

  /**
   * 执行一个动作并校验它的影响域
   * @returns {{ok:boolean, verdict:string, error?:string, retries:number}}
   */
  async function step(a) {
    if (!budget.canStep()) return { ok: false, verdict: 'halt', retries: 0, error: '步数或时间预算用尽' }
    const before = prev ?? (await grab())
    let retries = 0
    let result
    while (true) {
      try {
        await actuator.perform(a)
      } catch (err) {
        if (!budget.allowRetry(a.id ?? 'anon')) {
          return { ok: false, verdict: 'error', retries, error: String(err?.message ?? err) }
        }
        retries++
        await sleep(cfg.settleMs)
        continue
      }
      budget.noteStep()
      if (cfg.settleMs) await sleep(cfg.settleMs)
      const after = await grab()
      const roi = roiForAction(a, { width: after.width, height: after.height, lastBox })
      result = verifyAction(before.gray, after.gray, after.width, after.height, roi, {
        expect: a.verify?.expect ?? cfg.roi.expect ?? 0.02,
        outsideRatioLimit: cfg.roi.outsideRatioLimit,
      })
      prev = after
      if (result.verdict === 'ok') return { ok: true, ...result, retries }
      if (result.verdict === 'no-effect' && budget.allowRetry(a.id ?? 'anon')) {
        retries++
        continue // 同一动作重试，注意只会重试有限次
      }
      return { ok: false, ...result, retries }
    }
  }

  return {
    observe,
    step,
    flush,
    snapshot: () => budget.snapshot(),
    get last() {
      return prev
    },
    get pendingCount() {
      return pending.length
    },
    tierOf: (score) => tierOf(score, cfg.sense.tiers),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
