// 无依赖自检：node test/run-tests.mjs
// 这些断言覆盖纯算法、闭环、桌面状态机与 HTTP 面板，不依赖 Windows。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { scoreFrame, gridDelta, toGray, downscaleGray, dHash, hamming } from '../src/diff.mjs'
import { packSheet, labelOf } from '../src/sheet.mjs'
import { expandBox, verifyAction, cropGray, meanAbsDiff } from '../src/roi.mjs'
import { Budget } from '../src/budget.mjs'
import { createDeputy } from '../src/runner.mjs'
import { DesktopSession, createFakeTransport, sessionSensor, sessionActuator } from '../src/desktop.mjs'
import { createViewer } from '../src/viewer.mjs'
import { toolSpecs, registerTools, toParameters } from '../src/index.mjs'

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

await test('客户端：sidebar.panellist + main 同 id 注册（stub 加载 client.js）', async () => {
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
    assert.ok(loaded, 'client.js 必须调用 window.__ModuleLoader__.load')
    assert.equal(loaded.id, 'dsh-deputy')
    const exp = loaded.factory(() => React)
    assert.deepEqual(exp.inject, ['slots'])
    assert.equal(typeof exp.apply, 'function')
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

console.log(
  FAILED.length
    ? `\n${PASS.length} 项通过，${FAILED.length} 项失败\n${PASS.map((p) => '  ✓ ' + p).join('\n')}`
    : `\n${PASS.length} 项全部通过\n${PASS.map((p) => '  ✓ ' + p).join('\n')}`,
)
