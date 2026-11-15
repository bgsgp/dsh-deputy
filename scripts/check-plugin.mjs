// 插件自检：node scripts/check-plugin.mjs
// 作用：在发布/安装前确认 dsh.plugin.json 与实际代码对得上，
// 避免"注册了但挂不上"这种最难查的问题。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const ok = (m) => console.log(`  ✓ ${m}`)
const bad = (m) => {
  problems.push(m)
  console.log(`  ✗ ${m}`)
}

const VERSION_RE = /^\d+\.\d+\.\d+\.\d+/ // 主版本.本版本.本版本提交数.总提交数

function readJson(rel) {
  return JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'))
}

console.log('dsh-deputy plugin check')

const plugin = readJson('dsh.plugin.json')
const pkg = readJson('package.json')

// 1. 版本格式与三处一致
for (const [label, v] of [
  ['dsh.plugin.json', plugin.version],
  ['package.json', pkg.version],
]) {
  VERSION_RE.test(v) ? ok(`${label} 版本 ${v} 符合四段式`) : bad(`${label} 版本 ${v} 不符合 主.本.本次.总`)
}
plugin.version === pkg.version ? ok('两处版本一致') : bad('两处版本不一致')

// 2. 入口文件存在
const main = plugin.entry?.main
main && readFileSync(path.join(ROOT, main), 'utf8') ? ok(`entry.main = ${main}`) : bad('entry.main 缺失或文件不存在')

// 3. inject 声明
const inject = plugin.entry?.inject ?? []
inject.length ? ok(`inject: ${inject.join(', ')}`) : bad('entry.inject 为空')

// 4. provides.tools 与代码里实际导出的工具名对齐
const { toolSpecs } = await import(path.join(ROOT, main))
const dummySession = { state: 'idle', name: 'x', pid: null, lastError: null }
const dummyDeputy = { observe: () => ({}), step: () => ({}), flush: () => ({}) }
const declared = plugin.provides?.tools ?? []
const actual = toolSpecs(dummyDeputy, dummySession).map((t) => t.name)
const same = declared.length === actual.length && declared.every((n) => actual.includes(n))
same ? ok(`provide tools 对齐: ${actual.join(', ')}`) : bad(`声明 [${declared}] ≠ 实际 [${actual}]`)

// 5. 权限声明（虚拟桌面必需）
for (const p of ['admin', 'screen', 'input', 'process']) {
  plugin.permissions?.[p]?.required ? ok(`权限 ${p} 已声明`) : bad(`权限 ${p} 未声明`)
}

// 6. 平台限制
plugin.platforms?.includes('win32') ? ok('platforms 限定 win32') : bad('platforms 未限定 win32')

console.log(problems.length ? `\n${problems.length} 个问题` : '\n全部通过')
process.exit(problems.length ? 1 : 0)
