// npm 发布脚本：把仓库的四段版本号映射成 npm 能接受的 semver
//
// 为什么要这个脚本：仓库版本是 `主.本.本次提交数.总提交数`（0.0.12.12），
// 而 npm 只认三段 semver，`0.0.12.12` 会被直接拒：Invalid version。
// 映射规则：npm 版 = 主.本.总提交数（总提交数单调递增，天然满足 npm 的"每次发布必须换版本"）。
// 原始四段版本保留在输出包的 deputyVersion 字段里，不丢信息。
//
// 用法：
//   node scripts/publish-npm.mjs              # 默认 dry-run，只看会发布什么
//   node scripts/publish-npm.mjs --publish    # 真发布（需要先 npm login）
//   node scripts/publish-npm.mjs --publish --tag next
import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REGISTRY = 'https://registry.npmjs.org'

const argv = process.argv.slice(2)
const realPublish = argv.includes('--publish')
const tagIdx = argv.indexOf('--tag')
const tag = tagIdx > -1 ? argv[tagIdx + 1] : 'latest'

function fail(msg) {
  console.error(`✗ ${msg}`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const parts = String(pkg.version).split('.')

// 1. 校验仓库版本是四段
if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) {
  fail(`仓库版本必须是四段纯数字（主.本.本次.总），现在是 "${pkg.version}"`)
}

// 2. 映射到 semver：patch 取总提交数，保证单调递增
const npmVersion = `${parts[0]}.${parts[1]}.${parts[3]}`
console.log(`仓库版本 ${pkg.version}  →  npm 版本 ${npmVersion}`)

// 3. 舞台目录：只放包内声明的文件，顺带避免把杂物推上去
const stage = mkdtempSync(path.join(tmpdir(), 'dsh-deputy-npm-'))
try {
  for (const entry of pkg.files ?? []) {
    const src = path.join(ROOT, entry.replace(/\/$/, ''))
    const dst = path.join(stage, entry.replace(/\/$/, ''))
    cpSync(src, dst, { recursive: true })
  }

  const outPkg = {
    ...pkg,
    version: npmVersion,
    // 原始四段版本留档，装包的人仍能看到提交计数
    deputyVersion: pkg.version,
    publishConfig: { access: 'public', registry: REGISTRY },
  }
  writeFileSync(path.join(stage, 'package.json'), JSON.stringify(outPkg, null, 2) + '\n')

  const args = ['publish', `--registry=${REGISTRY}`, `--tag=${tag}`, '--access=public']
  if (!realPublish) args.push('--dry-run')

  console.log(`\n${realPublish ? '发布' : 'dry-run'}: npm ${args.join(' ')}\n`)
  execFileSync('npm', args, { cwd: stage, stdio: 'inherit' })
} finally {
  rmSync(stage, { recursive: true, force: true })
}

if (!realPublish) {
  console.log('\n以上是 dry-run，没有真的发布。确认无误后加 --publish 再跑。')
}
