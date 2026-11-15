// BUDGET 层：把"看"和"做"都纳入预算，超了就必须降级而不是硬撑
// 桌面自动化最容易翻车的不是能力不够，是死循环：一直截图、一直重试、token 烧光。
export const DEFAULT_BUDGET = {
  maxSheetsPerTask: 12,     // 整个任务最多推几张拼图进会话
  maxFramesPerSheet: 16,    // 4×4
  maxCapturePerTask: 4000,  // 本地采帧上限（不花 token，防 CPU 空转）
  maxSteps: 40,             // 单任务动作步数
  maxWallMs: 6 * 60 * 1000, // 墙钟上限
  maxRetriesPerAction: 2,
}

export class Budget {
  constructor(overrides = {}) {
    this.cfg = { ...DEFAULT_BUDGET, ...overrides }
    this.sheets = 0
    this.frames = 0
    this.steps = 0
    this.retries = new Map()
    this.t0 = Date.now()
  }

  get elapsed() {
    return Date.now() - this.t0
  }

  canCapture() {
    return this.frames < this.cfg.maxCapturePerTask && this.elapsed < this.cfg.maxWallMs
  }

  canShipSheet() {
    return this.sheets < this.cfg.maxSheetsPerTask && this.elapsed < this.cfg.maxWallMs
  }

  canStep() {
    return this.steps < this.cfg.maxSteps && this.elapsed < this.cfg.maxWallMs
  }

  noteCapture() {
    this.frames++
  }

  noteSheet() {
    this.sheets++
  }

  noteStep() {
    this.steps++
  }

  /** 同一动作的重复重试计数，超限返回 false 让上层换策略 */
  allowRetry(actionKey) {
    const n = (this.retries.get(actionKey) ?? 0) + 1
    this.retries.set(actionKey, n)
    return n <= this.cfg.maxRetriesPerAction
  }

  /**
   * 预算紧张时的降级建议：档位越靠后，感知越粗、动作越保守
   */
  degradation() {
    if (this.sheets >= this.cfg.maxSheetsPerTask || this.elapsed >= this.cfg.maxWallMs * 0.8) {
      return { level: 'halt', shipSheet: false, captureRatio: 0, reason: '拼图或时间预算用尽，停止新增感知，改为汇报当前证据' }
    }
    if (this.sheets >= this.cfg.maxSheetsPerTask * 0.7) {
      return { level: 'coarse', shipSheet: true, captureRatio: 0.4, reason: '拼图预算过半，降采样率、只留 major 帧' }
    }
    return { level: 'normal', shipSheet: true, captureRatio: 1, reason: '预算充足' }
  }

  snapshot() {
    return {
      sheets: this.sheets,
      frames: this.frames,
      steps: this.steps,
      elapsedMs: this.elapsed,
      limits: this.cfg,
      degradation: this.degradation(),
    }
  }
}
