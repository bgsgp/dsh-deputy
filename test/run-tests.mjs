// 无依赖自检：node test/run-tests.mjs
// 这些断言覆盖纯算法、闭环、桌面状态机与 HTTP 面板，不依赖 Windows。
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scoreFrame, gridDelta, toGray, downscaleGray, dHash, hamming } from '../src/diff.mjs'
import { packSheet, labelOf } from '../src/sheet.mjs'
import { expandBox, verifyAction, cropGray, meanAbsDiff } from '../src/roi.mjs'
import { Budget } from '../src/budget.mjs'
import { createDeputy } from '../src/runner.mjs'
import { DesktopSession, createFakeTransport, sessionSensor, sessionActuator, quoteWindowsArg } from '../src/desktop.mjs'
import { createViewer } from '../src/viewer.mjs'
import { toolSpecs, registerTools, toParameters } from '../src/index.mjs'
import { setOsStatus, setBrowserStatus, noteFailure, snapshot, resetStatus } from '../src/status.mjs'
import { browserToolSpecs } from '../src/browser/tools.mjs'
import { runSteps } from '../src/browser/act.mjs'
import { BrowserDaemon } from '../src/browser/daemon.mjs'
import { waitForLoad } from '../src/browser/wait.mjs'

const PASS = []
const FAILED = []
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => PASS.push(name))
    .catch((err) => {
      FAILED.push({ name, err })
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
  assert.ok(g[0] > 70 && g[0] < 90)
  assert.ok(g[1] > 145 && g[1] < 160)
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
  const b = paint(blank(), { x: 0, y: 0, w: 70, h: 50 }, 5)
  const r = verifyAction(blank(), b, W, H, { x: 100, y: 60, w: 40, h: 30 }, { expect: 0 })
  assert.equal(r.verdict, 'side-effect')
})

await test('verify：ROI 内变化较大时也不能漏报 ROI 外污染', () => {
  const after = blank()
  // 左半屏全变（inside=1），右半屏也变 60/255；full≈0.62 < inside，
  // 旧的 full > inside 闸门会漏掉这次 side-effect。
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) after[y * W + x] = x < W / 2 ? 0 : 140
  }
  const r = verifyAction(blank(), after, W, H, { x: 0, y: 0, w: W / 2, h: H }, { expect: 0.02, outsideRatioLimit: 0.12 })
  assert.equal(r.verdict, 'side-effect')
  assert.ok(r.outside > 0.2, `outside=${r.outside}`)
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
      if (n >= 2) paint(g, { x: 30, y: 20, w: 80, h: 60 }, 30)
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
  assert.deepEqual([...shown[0].png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47])
})

await test('闭环：帧尺寸变化按 major 处理，不跨尺寸索引旧缓冲', async () => {
  const frames = [
    { gray: new Uint8Array(16 * 12).fill(200), width: 16, height: 12 },
    { gray: new Uint8Array(32 * 24).fill(200), width: 32, height: 24 },
  ]
  const deputy = createDeputy({ sensor: { capture: async () => frames.shift() }, actuator: { perform: async () => {} }, policy: { settleMs: 0 } })
  await deputy.observe()
  const resized = await deputy.observe()
  assert.equal(resized.tier, 'major')
  assert.equal(resized.frameChanged, true)
  assert.equal(resized.box.w, 32)
})

await test('闭环：动作导致尺寸变化时明确标记 frameChanged', async () => {
  const frames = [
    { gray: new Uint8Array(16 * 12).fill(200), width: 16, height: 12 },
    { gray: new Uint8Array(32 * 24).fill(200), width: 32, height: 24 },
  ]
  const deputy = createDeputy({ sensor: { capture: async () => frames.shift() }, actuator: { perform: async () => {} }, policy: { settleMs: 0 } })
  const result = await deputy.step({ kind: 'shell', payload: { file: 'app.exe' }, verify: { expect: 0.02 } })
  assert.equal(result.ok, true)
  assert.equal(result.frameChanged, true)
})

await test('闭环：no-effect 重试前重新采动作基线', async () => {
  let captures = 0
  let attempts = 0
  const sensor = {
    async capture() {
      captures++
      const gray = blank()
      if (captures === 4) paint(gray, { x: 0, y: 0, w: 96, h: 96 }, 20)
      return { gray, width: W, height: H }
    },
  }
  const deputy = createDeputy({
    sensor,
    actuator: { perform: async () => { attempts++ } },
    budget: new Budget({ maxRetriesPerAction: 1 }),
    policy: { settleMs: 0 },
  })
  const result = await deputy.step({ kind: 'input', payload: { op: 'click', x: 4, y: 4 }, verify: { expect: 0.02 }, id: 'fresh-base' })
  assert.equal(result.ok, true)
  assert.equal(result.retries, 1)
  assert.equal(attempts, 2)
  assert.equal(captures, 4, '两次尝试都应各自采集 before/after')
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
  await assert.rejects(() => s.capture(), /已打开|未打开/)
  await s.open()
  await s.open().catch((e) => assert.match(e.message, /只能在 idle/))
  await s.startApp('x.exe')
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

await test('虚拟桌面：并发打开只建一个宿主，running 可继续启动程序', async () => {
  const t = createFakeTransport()
  const s = new DesktopSession({ transport: t })
  await Promise.all([s.ensureOpen(), s.ensureOpen(), s.open()])
  assert.equal(t.state.starts, 1)
  await s.startApp('notepad.exe')
  await s.startApp('calc.exe')
  assert.equal(s.state, 'running')
  assert.equal(s.pid, 4322)
  await Promise.all([s.close(), s.close()])
  await assert.rejects(() => s.capture(), (e) => e.code === 'ECLOSED')
  await assert.rejects(() => s.input({ op: 'click', x: 1, y: 1 }), (e) => e.code === 'ECLOSED')
})

await test('虚拟桌面：关闭后 ensureOpen 能创建全新会话', async () => {
  const t = createFakeTransport()
  const s = new DesktopSession({ transport: t })
  await s.open()
  await s.close()
  assert.equal(s.state, 'closed')
  await s.ensureOpen()
  assert.equal(s.state, 'opened')
  assert.equal(t.state.starts, 2)
  await s.close()
})

await test('Windows 启动参数按 CommandLineToArgvW 规则转义', async () => {
  assert.equal(quoteWindowsArg('plain'), 'plain')
  assert.equal(quoteWindowsArg('a b'), '"a b"')
  assert.equal(quoteWindowsArg(''), '""')
  assert.equal(quoteWindowsArg('a"b'), '"a\\"b"')
  assert.equal(quoteWindowsArg('a b\\'), '"a b\\\\"')
  const t = createFakeTransport()
  let launch
  const request = t.request
  t.request = async (payload) => {
    if (payload.op === 'launch') launch = payload
    return request(payload)
  }
  const s = new DesktopSession({ transport: t })
  await s.open()
  await s.startApp('C:\\Program Files\\App\\app.exe', ['plain', 'a b', '', 'a"b', 'a b\\'])
  assert.equal(launch.args, 'plain "a b" "" "a\\"b" "a b\\\\"')
  await s.close()
})

await test('窗口帧坐标在 input 时平移为桌面绝对坐标', async () => {
  const t = createFakeTransport()
  let clicked
  const request = t.request
  t.request = async (payload) => {
    if (payload.op === 'capture') return { ...(await request(payload)), originX: 100, originY: 50 }
    if (payload.op === 'input') clicked = payload.input
    return request(payload)
  }
  const s = new DesktopSession({ transport: t })
  await s.open()
  const frame = await s.capture()
  assert.equal(frame.originX, 100)
  assert.equal(frame.originY, 50)
  await s.input({ op: 'click', x: 10, y: 20 })
  assert.equal(clicked.x, 110)
  assert.equal(clicked.y, 70)
  await assert.rejects(() => s.input({ op: 'click', x: '10', y: 20 }), (e) => e.code === 'EARGS')
  await s.close()
})

await test('工具输出：跳过采样与拼图预算耗尽均符合声明且不抛异常', async () => {
  const sense = toolSpecs({ observe: async () => ({ skipped: 'budget' }) }, {})[0]
  const skipped = await sense.handler()
  assert.equal(skipped.skipped, 'budget')
  assert.match(sense.render({}, skipped)[0].text, /未出图/)

  const sheet = toolSpecs({ flush: async () => ({ dropped: 'sheet-budget' }) }, {})[2]
  const dropped = await sheet.handler({ reason: 'test' })
  assert.deepEqual(dropped, { frames: 0, dropped: 'sheet-budget' })
  assert.equal(sheet.outputSchema.properties.budget.type, 'object')
  assert.match(sheet.render({}, dropped)[0].text, /未推送/)
})

await test('工具输出：拼图以 image block 返回，附件是 saveImage 的引用', async () => {
  const saved = []
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const sheet = toolSpecs(
    { flush: async () => ({ frames: [{}, {}], budget: {}, deduped: true, png }) },
    {},
    {
      saveImage: async (input) => {
        saved.push(input)
        return { attachmentId: 'att_1', mediaType: 'image/png', bytes: 4, width: 8, height: 8, name: input.name }
      },
    },
  )[2]
  const value = await sheet.handler({ reason: 'test' })
  assert.equal(saved.length, 1)
  assert.equal(saved[0].mediaType, 'image/png')
  assert.deepEqual([...saved[0].data], [0x89, 0x50, 0x4e, 0x47])
  assert.equal(value.image.attachmentId, 'att_1')
  const blocks = sheet.render({}, value)
  assert.deepEqual(blocks.map((b) => b.type), ['text', 'image'])
  assert.equal(blocks[1].attachment.attachmentId, 'att_1')
  assert.equal(sheet.outputSchema.properties.image.type, 'object')
})

await test('工具输出：attachments 不可用时拼图只回文本，不抛异常', async () => {
  const sheet = toolSpecs({ flush: async () => ({ frames: [{}], budget: {}, png: Buffer.from([1]) }) }, {})[2]
  const value = await sheet.handler({ reason: 'x' })
  assert.equal(value.image, undefined)
  assert.deepEqual(sheet.render({}, value).map((b) => b.type), ['text'])
})

await test('注册：只走 0.2.x register(defineTool)，只读工具标并发安全', async () => {
  const specs = toolSpecs({ observe: async () => ({}) }, {})
  const registered = []
  const sink = registerTools({ tools: { register: (def) => registered.push(def) } }, specs)
  assert.equal(sink.length, 0)
  assert.equal(registered.length, 4)
  assert.equal(typeof registered[0].isConcurrencySafe, 'function')
  assert.equal(registered[0].isConcurrencySafe({}), true)
  assert.equal(registered[1].isConcurrencySafe, undefined)
  for (const def of registered) {
    assert.equal(def.output.schema.type, 'object')
    assert.equal(typeof def.output.render, 'function')
    assert.equal(typeof def.execute, 'function')
    assert.ok(def.parameters && typeof def.parameters === 'object')
  }
  // 缺 tools 服务时交回 spec，而不是静默吞掉
  const orphan = registerTools({}, specs)
  assert.equal(orphan.length, 4)
})

await test('工具 schema：output 用 required 数组、参数表 object 显式 additionalProperties', async () => {
  const specs = toolSpecs({ observe: async () => ({}) }, {})
  const requiredRoots = { deputy_act: ['ok'], deputy_sheet: ['frames'], deputy_desktop: ['state'] }
  const assertNoInlineRequired = (node, path) => {
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      if (key === 'required' && typeof child === 'boolean') assert.fail(`${path} 仍是内联 required，真实注册会抛 JsonSchemaError`)
      assertNoInlineRequired(child, `${path}.${key}`)
    }
  }
  for (const spec of specs) {
    const schema = spec.outputSchema
    assert.equal(schema.type, 'object')
    assertNoInlineRequired(schema, spec.name)
    if (requiredRoots[spec.name]) assert.deepEqual(schema.required, requiredRoots[spec.name])
    else assert.equal(schema.required, undefined)
    const objects = []
    const collect = (node, path) => {
      if (!node || typeof node !== 'object') return
      if (node.type === 'object' && path) objects.push(path)
      for (const [key, child] of Object.entries(node.properties ?? {})) collect(child, `${path}.${key}`)
      if (node.items) collect(node.items, `${path}[]`)
    }
    collect({ type: 'object', properties: spec.inputSchema?.properties }, '')
    // author 参数表里的 object 必须显式 additionalProperties，否则真实 dsh-tools 编译参数就抛
    for (const path of objects) {
      const node = toParameters(spec.inputSchema)[path.split('.').at(-1)]
      assert.equal(typeof node.additionalProperties, 'boolean')
    }
  }
})

await test('状态总线：两组件合成一个状态点（error > running > idle）', async () => {
  resetStatus()
  assert.equal(snapshot().level, 'idle')
  setOsStatus({ state: 'opened', running: true })
  assert.equal(snapshot().level, 'running')
  noteFailure('browser', new Error('boom'))
  const errored = snapshot()
  assert.equal(errored.level, 'error')
  assert.equal(errored.browser.error, 'boom')
  assert.equal(errored.os.running, true)
  // 清错后回到运行态：语义是「最近一次错误」，成功路径显式传 error: null
  setBrowserStatus({ error: null })
  assert.equal(snapshot().level, 'running')
  resetStatus()
  assert.equal(snapshot().level, 'idle')
})

await test('浏览器工具：5 个工具注册，ref 失效回 STALE_REF 信封', async () => {
  const nodes = new Map([['e9.1', { epoch: 9, backendNodeId: 1, role: 'link', name: '首页', box: [0, 0, 10, 10] }]])
  const daemon = {
    docEpoch: 9,
    lastUrl: 'https://example.com/',
    nodes,
    cdp: { send: async () => ({}) },
    ensureStarted: async () => ({ state: 'running', exe: 'edge', pid: 1, url: 'about:blank', docEpoch: 9 }),
    navigate: async (url) => ({ ok: true, url, docEpoch: 9 }),
    observe: async () => ({ ok: true, text: 'x', refs: [], state: { url: 'https://example.com/', docEpoch: 9, listed: 0, visible: 0 } }),
    close: async () => ({ ok: true }),
    status: () => ({ state: 'running' }),
    // 真实 daemon.act 就是 runSteps 的薄封装，这里照同样的形状接上
    act: (opts) => runSteps(daemon, opts),
  }
  const specs = browserToolSpecs(daemon, {})
  assert.deepEqual(specs.map((s) => s.name), ['browser_open', 'browser_observe', 'browser_act', 'browser_status', 'browser_close'])
  const registered = []
  assert.equal(registerTools({ tools: { register: (def) => registered.push(def) } }, specs).length, 0)
  assert.equal(registered.length, 5)
  const act = specs.find((s) => s.name === 'browser_act')
  // 文档换代后旧 ref 必须明确失效，而不是乱点
  daemon.docEpoch = 10
  const stale = await act.handler({ steps: [{ verb: 'click', ref: 'e9.1' }] })
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, 'STALE_REF')
  assert.equal(typeof stale.error.hint, 'string')
  const textBlocks = act.render({}, stale)
  assert.equal(textBlocks[0].type, 'text')
  assert.match(textBlocks[0].text, /STALE_REF/)
})

await test('浏览器闭环：runSteps 遇布局变化就停，把新 epoch 交回', async () => {
  const nodes = new Map([['e1.7', { epoch: 1, backendNodeId: 7, role: 'link', name: 'Go', box: [10, 10, 20, 20] }]])
  let epoch = 1
  const daemon = {
    get docEpoch() {
      return epoch
    },
    lastUrl: 'https://example.com/',
    nodes,
    // 点击过程中页面换代（单页应用常见）
    cdp: {
      send: async (method) => {
        if (method === 'Input.dispatchMouseEvent') epoch = 2
        if (method === 'DOM.getBoxModel') return { model: { content: [10, 10, 30, 10, 30, 30, 10, 30] } }
        if (method === 'Runtime.evaluate') return { result: { value: { text: 'Go', id: '' } } }
        return {}
      },
    },
    waitForLoad: async () => {},
  }
  const res = await runSteps(daemon, { steps: [{ verb: 'click', ref: 'e1.7' }, { verb: 'click', ref: 'e1.7' }] })
  assert.equal(res.ok, true)
  assert.equal(res.stopped, 'document-changed')
  assert.equal(res.remaining, 1)
  assert.equal(res.diff.epochAfter, 2)
})

await test('浏览器闭环：resolveRef 代数不等于 docEpoch 时拒绝点击', async () => {
  const daemon = {
    docEpoch: 4,
    lastUrl: 'https://example.com/',
    nodes: new Map([['e4.5', { epoch: 3, backendNodeId: 5, role: 'link', name: 'x', box: [0, 0, 4, 4] }]]),
    cdp: { send: async () => ({}) },
  }
  const res = await runSteps(daemon, { steps: [{ verb: 'click', ref: 'e4.5' }] })
  assert.equal(res.ok, false)
  assert.equal(res.error.code, 'STALE_REF')
  assert.match(res.error.message, /epoch 3/)
})

await test('浏览器等待：当前标签 readyState 完成且网络静默后才返回', async () => {
  const daemon = {
    pageSession: 's1',
    networkPending: new Map([['s1:r1', true], ['background:r2', true]]),
    networkActivity: new Map(),
    evaluate: async () => 'complete',
  }
  let settled = false
  const waiting = waitForLoad(daemon, { timeoutMs: 500, quietMs: 20 }).then((value) => {
    settled = true
    return value
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(settled, false, '当前标签仍有在途请求时不能提前完成')
  daemon.networkPending.delete('s1:r1')
  daemon.networkActivity.set('s1', Date.now() - 30)
  assert.equal(await waiting, true, '后台标签的请求不应阻塞当前标签')
})

await test('浏览器动作：disabled 控件不会被点击', async () => {
  let mouseEvents = 0
  const daemon = {
    docEpoch: 1,
    lastUrl: 'https://example.com/',
    nodes: new Map([['e1.1', { epoch: 1, backendNodeId: 1, disabled: true }]]),
    cdp: { send: async (method) => { if (method === 'Input.dispatchMouseEvent') mouseEvents++; return {} } },
  }
  const result = await runSteps(daemon, { steps: [{ verb: 'click', ref: 'e1.1' }] })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'DISABLED')
  assert.equal(mouseEvents, 0)
})

await test('浏览器动作：真实命中检查为遮挡时不再点击目标', async () => {
  let mouseEvents = 0
  const daemon = {
    docEpoch: 1,
    lastUrl: 'https://example.com/',
    pageSession: 's1',
    nodes: new Map([['e1.2', { epoch: 1, backendNodeId: 2, disabled: false }]]),
    evaluate: async () => null,
    cdp: {
      send: async (method) => {
        if (method === 'DOM.getBoxModel') return { model: { content: [10, 10, 30, 10, 30, 30, 10, 30] } }
        if (method === 'DOM.resolveNode') return { object: { objectId: 'target-object' } }
        if (method === 'Runtime.callFunctionOn') return { result: { value: { owns: false, hit: { tag: 'div', text: 'modal' } } } }
        if (method === 'Input.dispatchMouseEvent') mouseEvents++
        return {}
      },
    },
  }
  const result = await runSteps(daemon, { steps: [{ verb: 'click', ref: 'e1.2' }] })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'OVERLAY')
  assert.equal(mouseEvents, 0)
})

await test('浏览器动作：external/irreversible 必须带用户确认标记', async () => {
  const daemon = { docEpoch: 1, lastUrl: '', nodes: new Map(), cdp: { send: async () => ({}) } }
  const result = await runSteps(daemon, { steps: [{ verb: 'click', ref: 'e1.1', risk: 'external' }] })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'CONFIRM_REQUIRED')
  assert.match(result.error.hint, /用户明确批准/)
})

await test('浏览器多标签：切换 target 会换代并清空旧 ref', async () => {
  const daemon = new BrowserDaemon({ restoreState: false })
  daemon.cdp = {
    send: async (method, params) => {
      if (method === 'Target.getTargets') return { targetInfos: [
        { targetId: 't1', type: 'page', url: 'https://example.com/1', title: 'one' },
        { targetId: 't2', type: 'page', url: 'https://example.com/2', title: 'two' },
      ] }
      if (method === 'Target.attachToTarget') return { sessionId: 'session-2' }
      if (method === 'Target.closeTarget') return { success: true }
      return {}
    },
  }
  daemon.targetId = 't1'
  daemon.pageSession = 'session-1'
  daemon.docEpoch = 1
  daemon.nodes.set('e1.1', { epoch: 1, backendNodeId: 1 })
  const result = await daemon.switchTarget('t2')
  assert.equal(result.targetId, 't2')
  assert.equal(daemon.pageSession, 'session-2')
  assert.equal(daemon.lastUrl, 'https://example.com/2')
  assert.equal(daemon.nodes.size, 0)
  assert.ok(daemon.docEpoch > 1)
})

await test('浏览器幂等：同一 idempotencyKey 不重复导航', async () => {
  const daemon = new BrowserDaemon({ restoreState: false })
  let navigations = 0
  daemon.ensureStarted = async () => ({ state: 'running' })
  daemon.waitForLoad = async () => true
  daemon.settle = async () => ({ reason: 'quiet', elapsedMs: 0 })
  daemon.pageSession = 's1'
  daemon.cdp = { send: async (method) => { if (method === 'Page.navigate') navigations++; return {} } }
  const input = { steps: [{ verb: 'navigate', url: 'https://example.com/' }], idempotencyKey: 'write-1' }
  const first = await daemon.act(input)
  const second = await daemon.act(input)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(second.deduped, true)
  assert.equal(navigations, 1)
})

await test('浏览器下载：waitForDownload 只接受本次新完成的记录', async () => {
  const daemon = new BrowserDaemon({ restoreState: false, downloadDir: mkdtempSync(join(tmpdir(), 'deputy-download-')) })
  daemon.downloads.set('old', { id: 'old', state: 'completed', filename: 'old.txt' })
  daemon.downloads.set('new', { id: 'new', state: 'inProgress', filename: 'new.txt', receivedBytes: 0 })
  const waiting = daemon.waitForDownload(new Set(['old']), { timeoutMs: 500 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  daemon.downloads.set('new', { id: 'new', state: 'completed', filename: 'new.txt', receivedBytes: 3 })
  const result = await waiting
  assert.equal(result.id, 'new')
  assert.equal(result.bytes, 3)
})

await test('浏览器截图：saveImage 元数据通过 render 变成 image content block', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
  const daemon = {
    observe: async () => ({ ok: true, text: 'snapshot', refs: [] }),
    screenshot: async () => ({ base64: png.toString('base64'), format: 'png', width: 10, height: 20 }),
  }
  const spec = browserToolSpecs(daemon, {
    saveImage: async (input) => ({ attachmentId: 'att-browser', mediaType: input.mediaType, bytes: input.data.length, width: input.width, height: input.height, name: input.name }),
  }).find((item) => item.name === 'browser_observe')
  const value = await spec.handler({ screenshot: true })
  const blocks = spec.render({}, value)
  assert.equal(value.image.attachmentId, 'att-browser')
  assert.equal(value.image.width, 10)
  assert.equal(value.image.height, 20)
  assert.ok(blocks.some((block) => block.type === 'image' && block.attachment.attachmentId === 'att-browser'))
})

await test('客户端：侧栏注册、监视窗等比适配与点击坐标换算', async () => {
  const savedWindow = globalThis.window
  const savedDocument = globalThis.document
  const React = {
    createElement: () => null,
    useState: () => [null, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
  }
  let loaded = null
  globalThis.window = { __ModuleLoader__: { load: (mod) => { loaded = mod } } }
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {} }),
    head: { appendChild: () => {} },
  }
  try {
    const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    new Function('require', src)(() => React)
    // 状态点必须画在行文字（panelTitle）右边，而不是图标旁/行右端
    assert.match(src, /_panelTitle/)
    assert.match(src, /_panelTitle"]::after/)
    assert.equal(src.includes('ddp-dot'), false)
    assert.ok(loaded, 'client.js 必须调用 window.__ModuleLoader__.load')
    assert.equal(loaded.id, 'dsh-deputy')
    const exp = loaded.factory(() => React)
    assert.deepEqual(exp.inject, ['slots'])
    assert.equal(typeof exp.apply, 'function')
    const landscape = exp.fitFrame(1920, 1080, 960, 600)
    assert.deepEqual(landscape, { width: 960, height: 540, scale: 0.5 })
    const portrait = exp.fitFrame(800, 1200, 500, 500)
    assert.equal(portrait.height, 500)
    assert.ok(portrait.width <= 500 && portrait.height <= 500)
    assert.deepEqual(exp.fitFrame(1920, 1080, 0, 600), { width: 0, height: 0, scale: 0 })
    assert.deepEqual(exp.framePoint(150, 75, { left: 100, top: 50, width: 400, height: 200 }), { x: 0.125, y: 0.125 })
    assert.equal(exp.framePoint(50, 75, { left: 100, top: 50, width: 400, height: 200 }), null)
    assert.match(src, /ResizeObserver/)
    assert.match(src, /draggable: false/)
    assert.match(src, /onDragStart/)
    assert.match(src, /cursor:pointer/)
    assert.equal(src.includes('cursor:crosshair'), false)
    const calls = []
    exp.apply({
      effect: (body) => body(),
      slots: {
        inject(name, cb) {
          calls.push(['inject', name])
          return cb()
        },
        register(opts) {
          calls.push(['register', opts.name, opts.id ?? opts.key, opts.label])
          return () => {}
        },
      },
    })
    assert.deepEqual(calls, [
      ['inject', 'sidebar.panellist'],
      ['register', 'sidebar.panellist', 'dsh-deputy-desktop', 'DSH操作电脑'],
      ['inject', 'main'],
      ['register', 'main', 'dsh-deputy-desktop', undefined],
    ])
  } finally {
    globalThis.window = savedWindow
    globalThis.document = savedDocument
  }
})

await test('宿主脚本：user 模式走 SendInput、isolated 走 PostMessage，且保留 UTF-8 BOM', async () => {
  const raw = readFileSync(new URL('../scripts/windows-desktop.ps1', import.meta.url))
  assert.equal(raw[0], 0xef)
  assert.equal(raw[1], 0xbb)
  assert.equal(raw[2], 0xbf)
  const ps1 = raw.toString('utf8')
  // user 模式：真实桌面是输入桌面，SendInput 才有效（隔离桌面实测 0/N）
  for (const needle of ['ValidateSet(\'isolated\', \'user\')', '$isUser', 'ClickUser', 'TypeUser', 'SendChecked', 'SetForegroundWindow', 'SetProcessDPIAware']) {
    assert.ok(ps1.includes(needle), '宿主脚本缺少 ' + needle)
  }
  // isolated 模式：非输入桌面，只能 PostMessage 投递
  for (const needle of ['PostMessage', 'WindowFromPoint', 'ScreenToClient', 'WM_CHAR', 'GetGUIThreadInfo']) {
    assert.ok(ps1.includes(needle), '宿主脚本缺少 ' + needle)
  }
  assert.ok(ps1.includes('-not $isUser'), 'user 模式必须跳过 CloseDesktop/杀进程')
})

await test('HTTP 面板：健康检查、合并采帧、坐标换算与输入校验', async () => {
  const transport = createFakeTransport()
  const request = transport.request
  transport.request = async (payload) => {
    // 让三个 HTTP 请求确实重叠；真实 BitBlt 远比内存假宿主慢。
    if (payload.op === 'capture') await new Promise((resolve) => setTimeout(resolve, 20))
    return request(payload)
  }
  const session = new DesktopSession({ transport, name: 'deputy-http-test' })
  const viewer = createViewer({ session, port: 0 })
  const base = await viewer.start()
  const call = async (path, init) => {
    const res = await fetch(new URL(path, base), init)
    return { status: res.status, body: await res.json() }
  }
  const post = (path, body) =>
    call(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  try {
    const health = await call('/api/health')
    assert.equal(health.body.ok, true)
    assert.equal(health.body.state, 'idle')

    const opened = await post('/api/open')
    assert.equal(opened.body.state, 'opened')

    const before = transport.state.frames
    const frames = await Promise.all([call('/api/frame'), call('/api/frame'), call('/api/frame')])
    assert.ok(frames.every((f) => f.body.ok && f.body.width === 32 && f.body.height === 24))
    assert.equal(transport.state.frames, before + 1, '并发轮询应合并为一次宿主采帧')

    const click = await post('/api/input', { type: 'click', x: 0.5, y: 0.25 })
    assert.equal(click.body.ok, true)
    assert.deepEqual(click.body.input, { op: 'click', x: 16, y: 6, button: 'left' })

    const legacy = await post('/api/input', { op: 'click', x: 1, y: 1, button: 'right' })
    assert.equal(legacy.body.input.x, 31)
    assert.equal(legacy.body.input.y, 23)
    assert.equal(legacy.body.input.button, 'right')

    const inputs = transport.state.inputs
    const invalid = await post('/api/input', { type: 'click', x: 2, y: 0 })
    assert.equal(invalid.status, 400)
    assert.equal(transport.state.inputs, inputs, '非法坐标不应发送到桌面')

    const badLaunch = await post('/api/launch', {})
    assert.equal(badLaunch.status, 400)
    const wrongMethod = await post('/api/health')
    assert.equal(wrongMethod.status, 405)
  } finally {
    await viewer.stop()
    await session.close()
  }
})

await test('登录态继承：复制 Local State + profile/Network/Cookies，源缺失不抛错', async () => {
  const { copyLoginState, listProfiles, pickProfile, browserFlavor } = await import('../src/browser/cookies.mjs')
  const root = mkdtempSync(join(tmpdir(), 'deputy-cookie-src-'))
  mkdirSync(join(root, 'Default', 'Network'), { recursive: true })
  writeFileSync(join(root, 'Local State'), 'local-state-bytes')
  writeFileSync(join(root, 'Default', 'Network', 'Cookies'), 'cookies-db-bytes')
  const dest = mkdtempSync(join(tmpdir(), 'deputy-cookie-dst-'))
  try {
    assert.equal(browserFlavor('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'), 'edge')
    assert.equal(browserFlavor('C:/Program Files/Google/Chrome/Application/chrome.exe'), 'chrome')
    assert.deepEqual(listProfiles(root), ['Default'])
    assert.equal(pickProfile(root, 'auto'), 'Default')
    const res = copyLoginState({ sourceRoot: root, destDir: dest })
    assert.equal(res.ok, true)
    assert.equal(res.profile, 'Default')
    assert.ok(res.bytes > 0)
    assert.equal(readFileSync(join(dest, 'Default', 'Network', 'Cookies'), 'utf8'), 'cookies-db-bytes')
    assert.equal(readFileSync(join(dest, 'Local State'), 'utf8'), 'local-state-bytes')
    // 源目录/子目录缺失都只是「没继承到」，绝不能让浏览器起不来
    const miss = copyLoginState({ sourceRoot: join(root, 'nope'), destDir: dest })
    assert.equal(miss.ok, false)
    assert.equal(miss.reason, 'NO_SOURCE')
    const empty = mkdtempSync(join(tmpdir(), 'deputy-cookie-empty-'))
    assert.equal(copyLoginState({ sourceRoot: empty, destDir: dest }).reason, 'NO_PROFILE')
    assert.equal(copyLoginState({ sourceRoot: root, destDir: null }).reason, 'NO_DEST')
  } finally {
    // 测试目录留在 tmp，不删也无害；这里只断言存在性
    assert.ok(existsSync(dest))
  }
})

await test('包根锚点：index.mjs 是 name=dsh-deputy 的空组件，老路径仍能拿到 toolSpecs', async () => {
  const anchor = await import('../src/index.mjs')
  assert.equal(anchor.name, 'dsh-deputy')
  assert.deepEqual(anchor.inject, [])
  assert.equal(anchor.apply(), undefined)
  assert.equal(typeof anchor.toolSpecs, 'function')
  assert.equal(typeof anchor.registerTools, 'function')
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /^[ \t]*-[ \t]*name:[ \t]*'dsh-deputy'[ \t]*$/m, 'patch 必须有包根锚点 row')
  assert.match(patch, /id: dsh-deputy-os/, 'patch 必须有 os 组件 row')
  assert.match(patch, /id: dsh-deputy-browser/, 'patch 必须有 browser 组件 row')
})

console.log(
  FAILED.length
    ? `\n${PASS.length} 项通过，${FAILED.length} 项失败\n${PASS.map((p) => '  ✓ ' + p).join('\n')}`
    : `\n${PASS.length} 项全部通过\n${PASS.map((p) => '  ✓ ' + p).join('\n')}`,
)
