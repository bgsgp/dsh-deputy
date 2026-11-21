// 端到端演练：走真实工具层（deputy_see + deputy_act 的 uia 分支）操作 WinForms 夹具。
// 用法：先起 scripts/uia-fixture.ps1，再 node scripts/see-e2e.mjs
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { toolSpecs, state } from '../src/os.mjs'
import { flattenTree } from '../src/see.mjs'

const specs = Object.fromEntries(toolSpecs({}, {}).map((s) => [s.name, s]))
const see = specs.deputy_see
const act = specs.deputy_act

const windows = await see.handler({ op: 'windows' })
console.log('--- windows ---')
console.log(windows.text.split('\n').slice(0, 6).join('\n'))

// 夹具可能被跑过多次（多个同名窗口），钉住前台那一个 hwnd，别让两次调用落到不同窗口
const line = windows.text.split('\n').find((l) => l.includes('deputy-uia-fixture') && l.includes('[前台]'))
if (!line) throw new Error('夹具不在前台：先起 scripts/uia-fixture.ps1')
const hwnd = Number(line.match(/^#(\d+)/)[1])
const tree = await see.handler({ op: 'tree', hwnd, depth: 4 })
console.log('--- tree ---')
console.log(tree.text)

const raw = await state.bridge.see({ hwnd, depth: 4 })
const flat = flattenTree(raw.node)
// WinForms 不给 UIA provider：子控件都只是 Pane 壳，按名字/顺序认人
const edit = flat.nodes[1]
const button = flat.nodes.find((n) => String(n.node.name ?? '') === '确定')
if (!edit || !button) throw new Error('夹具里没找到输入框/确定按钮：' + flat.nodes.map((n) => n.node.name + ':' + n.node.type).join(' | '))
console.log('--- act setValue @', edit.path, '---')
const wrote = await act.handler({ kind: 'uia', payload: { hwnd, ref: { path: edit.path }, action: 'setValue', text: 'deputy tool ok 7' } })
console.log(JSON.stringify(wrote))
console.log('--- act invoke 确定 ---')
const clicked = await act.handler({ kind: 'uia', payload: { hwnd, ref: { path: button.path }, action: 'invoke' } })
console.log(JSON.stringify(clicked))
await new Promise((r) => setTimeout(r, 400))
const out = join(process.env.TEMP ?? tmpdir(), 'deputy-uia-fixture.txt')
const body = readFileSync(out, 'utf8')
console.log('--- 文件回读 ---')
console.log(JSON.stringify(body))
if (!body.includes('deputy tool ok 7')) throw new Error('文件内容对不上：' + body)
console.log('E2E OK')
