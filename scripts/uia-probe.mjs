#!/usr/bin/env node
// 观察层的手工探针：直接跑 scripts/windows-uia.ps1，再用 src/see.mjs 排版。
// 用途是"模型拿着 deputy_see 之前先自己看一眼后端输出"，以及出问题时定位是
// PS 后端坏了还是 see.mjs 排版坏了。
//
//   node scripts/uia-probe.mjs '{"op":"windows"}'
//   node scripts/uia-probe.mjs '{"op":"tree","process":"notepad","depth":5}'
//   node scripts/uia-probe.mjs '{"op":"tree","hwnd":1234}' --raw   # 打原始 JSON
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { describe } from '../src/see.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const script = join(here, 'windows-uia.ps1')

const payload = process.argv[2]
if (!payload) {
  console.error(`用法: node scripts/uia-probe.mjs '<json>' [--raw]`)
  process.exit(2)
}

let raw
try {
  raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    input: payload,
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
  })
} catch (error) {
  // 后端用 exit 1 表示"我失败了但 JSON 还是要看的"
  raw = String(error.stdout ?? '')
  if (!raw) {
    console.error(String(error.stderr ?? error.message))
    process.exit(1)
  }
}

let result
try {
  result = JSON.parse(raw)
} catch {
  console.error('后端没吐合法 JSON：')
  console.error(raw.slice(0, 2000))
  process.exit(1)
}

if (process.argv.includes('--raw')) {
  console.log(JSON.stringify(result, null, 2))
  process.exit(result.ok ? 0 : 1)
}

if (!result.ok) {
  console.error('后端报错：' + String(result.error))
  process.exit(1)
}

const seen = describe(result)
console.log(`${seen.kind} · ${seen.count} 项${seen.truncated ? ' · 已截断' : ''}`)
if (seen.window) console.log(`窗口: ${seen.window} (#${seen.hwnd})`)
if (seen.foreground) console.log(`前台: ${seen.foreground}`)
console.log(seen.text)
if (result.error) console.error(`后端提示: ${result.error}`)
