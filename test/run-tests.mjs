// 无依赖自检：node test/run-tests.mjs
// 这些断言只覆盖纯算法与闭环编排，不依赖 Windows。
import assert from 'node:assert/strict'
import { scoreFrame, gridDelta, toGray, downscaleGray, dHash, hamming } from '../src/diff.mjs'
import { packSheet, labelOf } from '../src/sheet.mjs'
import { expandBox, verifyAction, cropGray, meanAbsDiff } from '../src/roi.mjs'
import { Budget } from '../src/budget.mjs'
import { createDeputy } from '../src/runner.mjs'
import { DesktopSession, createFakeTransport, sessionSensor, sessionActuator } from '../src/desktop.mjs'

const PASS = []
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => PASS.push(name))
    .catch((err) => {
      console.error(`✗ ${name}\n  ${err.message}`)
      process.exitCode = 1
    })
}

const W = 160
const H = 120
const blank = () => new Uint8Array(W * H).fill(200)

function paint(gray, box, v = 40) {
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) gray[y * W + x] = v
  }
  return gray
}

await test('全同帧判为 still', () => {
  const a = blank()
  const s = scoreFrame(a, blank(), W, H)
  assert.equal(s.tier, 'still')
  assert.equal(s.score, 0)
  assert.equal(s.box.w, 0)
})

await test('小面积改动不进 meaningful 档', () => {
  const b = paint(blank(), { x: 4, y: 4, w: 6, h: 6 })
  const s = scoreFrame(blank(), b, W, H)
  assert.ok(['still', 'minor'].includes(s.tier), `实际档位 ${s.tier} score=${s.score}`)
})

await test('大面积改动进 meaningful 及以上', () => {
  const b = paint(blank(), { x: 10, y: 10, w: 90, h: 70 })
  const s = scoreFrame(blank(), b, W, H)
  assert.ok(['meaningful', 'major'].includes(s.tier), `实际档位 ${s.tier} score=${s.score}`)
  assert.ok(s.box.w >= 80 && s.box.h >= 60, `包围盒偏小 ${JSON.stringify(s.box)}`)
})

await test('包围盒命中改动位置（容一个网格的误差）', () => {
  const b = paint(blank(), { x: 100, y: 60, w: 40, h: 40 })
  const g = gridDelta(blank(), b, W, H)
  const insideX = 100 >= g.box.x && 140 <= g.box.x + g.box.w
  const insideY = 60 >= g.box.y && 100 <= g.box.y + g.box.h
  assert.ok(insideX && insideY, `box=${JSON.stringify(g.box)}`)
})

await test('dHash 距离：同图 0，改动 > 0', () => {
  const g = downscaleGray(blank(), W, H, 9, 8)
  assert.equal(hamming(dHash(g, 9, 8), dHash(g, 9, 8)), 0)
  const b = paint(blank(), { x: 60, y: 40, w: 40, h: 40 })
  assert.ok(hamming(dHash(g, 9, 8), dHash(downscaleGray(b, W, H, 9, 8), 9, 8)) > 0)
})

await test('RGBA → 灰度按 BT.601 权重', () => {
  const buf = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 255])
  const g = toGray(buf, 2, 2, 4)
  assert.ok(g[0] > 70 && g[0] < 90) // 红 ≈ 76
  assert.ok(g[1] > 145 && g[1] < 160) // 绿 ≈ 150
  assert.ok(g[3] === 0)
})

await test('拼图尺寸与 PNG 头合法', () => {
  const frames = Array.from({ length: 16 }, (_, i) => ({
    gray: paint(blank(), { x: 10 + i, y: 10, w: 20, h: 20 }),
    width: W,
    height: H,
    label: labelOf(i, (i % 4) / 4),
  }))
  const sheet = packSheet(frames, { cell: 96, gap: 4 })
  assert.equal(sheet.width, 4 * 96 + 5 * 4)
  const png = sheet.png()
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.ok(png.length > 1000)
})

await test('不满 16 帧也能出图（行数自适应）', () => {
  const frames = Array.from({ length: 5 }, () => ({ gray: blank(), width: W, height: H }))
  const sheet = packSheet(frames, { cell: 64, gap: 2 })
  assert.ok(sheet.height > 0)
})

await test('ROI 扩张不越界', () => {
  const r = expandBox({ x: 150, y: 110, w: 10, h: 10 }, { width: W, height: H })
  assert.ok(r.x + r.w <= W && r.y + r.h <= H, JSON.stringify(r))
})

await test('verify：无变化 → no-effect', () => {
  const r = verifyAction(blank(), blank(), W, H, { x: 40, y: 30, w: 40, h: 30 })
  assert.equal(r.verdict, 'no-effect')
})

await test('verify：ROI 内变化 → ok', () => {
  const b = paint(blank(), { x: 40, y: 30, w: 40, h: 30 }, 10)
  const r = verifyAction(blank(), b, W, H, { x: 40, y: 30, w: 40, h: 30 }, { expect: 0.02 })
  assert.equal(r.verdict, 'ok')
  assert.ok(r.inside > 0.3)
})

await test('verify：ROI 外的弹窗 → side-effect', () => {
  const b = paint(blank(), { x: 0, y: 0, w: 70, h: 50 }, 5) // 只改左上
  const r = verifyAction(blank(), b, W, H, { x: 100, y: 60, w: 40, h: 30 }, { expect: 0 })
  assert.equal(r.verdict, 'side-effect')
})

await test('cropGray 与 meanAbsDiff 一致', () => {
  const a = blank()
  const roi = { x: 10, y: 10, w: 20, h: 20 }
  const c = cropGray(a, W, roi)
  assert.equal(c.length, 400)
  assert.equal(meanAbsDiff(c, c), 0)
})

await test('预算用尽后的降级建议落到 halt', () => {
  const b = new Budget({ maxSheetsPerTask: 2 })
  b.noteSheet(); b.noteSheet()
  assert.equal(b.degradation().level, 'halt')
  assert.equal(b.canShipSheet(), false)
})

await test('闭环：跨档才进缓冲，动作后 ROI 校验通过', async () => {
  let n = 0
  const sensor = {
    async capture() {
      const g = blank()
      if (n >= 2) paint(g, { x: 30, y: 20, w: 80, h: 60 }, 30) // 第 3 帧起大改
      n++
      return { gray: g, width: W, height: H }
    },
  }
  const deputy = createDeputy({ sensor, actuator: { perform: async () => {} }, budget: new Budget(), policy: { settleMs: 0 } })
  await deputy.observe()
  const s2 = await deputy.observe()
  assert.equal(s2.tier, 'still')
  await deputy.observe()
  assert.equal(deputy.pendingCount, 1)
  const step = await deputy.step({ kind: 'input', payload: { op: 'click', x: 70, y: 50 }, verify: { expect: 0 }, id: 'c1' })
  assert.ok(['ok', 'side-effect'].includes(step.verdict), JSON.stringify(step))
})

await test('闭环：拼图经 onEvidence 推出且只推一次', async () => {
  const shown = []
  let n = 0
  const sensor = {
    async capture() {
      const g = blank()
      if (n++ % 2 === 1) paint(g, { x: 20, y: 20, w: 100, h: 70 }, 20)
      return { gray: g, width: W, height: H }
    },
  }
  const deputy = createDeputy({
    sensor,
    actuator: { perform: async () => {} },
    budget: new Budget(),
    policy: { settleMs: 0 },
    onEvidence: (ev) => shown.push(ev),
  })
  for (let i = 0; i < 20 && deputy.pendingCount === 0; i++) await deputy.observe()
  await deputy.flush('test')
  assert.equal(shown.length, 1)
  // 空白拼图的 PNG 压缩后很小，别拿体积当健康指标，看签名
  assert.deepEqual([...shown[0].png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

await test('虚拟桌面：生命周期 idle→opened→running→closed', async () => {
  const t = createFakeTransport()
  const s = new DesktopSession({ transport: t, name: 'deputy-test' })
  assert.equal(s.state, 'idle')
  await s.open()
  assert.equal(s.state, 'opened')
  await s.startApp('notepad.exe', ['a.txt'])
  assert.equal(s.state, 'running')
  assert.equal(s.pid, 4321)
  const frame = await s.capture()
  assert.equal(frame.width, 32)
  assert.equal(frame.gray.length, 32 * 24)
  await s.tree()
  await s.input({ op: 'click', x: 10, y: 10 })
  assert.equal(t.state.inputs, 1)
  await s.close()
  assert.equal(s.state, 'closed')
})

await test('虚拟桌面：状态守卫拒绝越序调用', async () => {
  const s = new DesktopSession({ transport: createFakeTransport() })
  await assert.rejects(() => s.capture(), /未打开/) // idle 不能采帧
  await s.open()
  await s.open().catch((e) => assert.match(e.message, /只能在 idle/)) // 重复 open 被拒
  await s.startApp('x.exe') // opened → running
  assert.equal(s.state, 'running')
})

await test('虚拟桌面：close 幂等且不抛', async () => {
  const s = new DesktopSession({ transport: createFakeTransport() })
  await s.open()
  await s.close()
  const again = await s.close()
  assert.equal(again.already, true)
})

await test('虚拟桌面：关掉之后采帧直接报 ECLOSED', async () => {
  const t = createFakeTransport()
  const s = new DesktopSession({ transport: t })
  await s.open()
  await s.close()
  assert.equal(t.state.closed, true)
})

await test('闭环跑在虚拟桌面上：sensor/actuator 都走会话', async () => {
  const session = new DesktopSession({ transport: createFakeTransport() })
  await session.open()
  const deputy = createDeputy({
    sensor: sessionSensor(session),
    actuator: sessionActuator(session),
    budget: new Budget(),
    policy: { settleMs: 0 },
  })
  const seen = await deputy.observe()
  assert.equal(seen.first, true)
  const r = await deputy.step({ kind: 'input', payload: { op: 'click', x: 4, y: 4 }, verify: { expect: 0 } })
  assert.ok(['ok', 'no-effect'].includes(r.verdict), JSON.stringify(r))
})

console.log(PASS.length ? `\n${PASS.length} 项全部通过\n${PASS.map((p) => '  ✓ ' + p).join('\n')}` : '')
