// npm 发布脚本：舞台目录打包后直接 npm publish。
//
// 版本号是标准三段 semver（主版本.本版本.总提交数），与 package.json 一致，
// 不再需要四段 → 三段的映射：pnpm/npm 在本地 link 安装时也会校验版本，
// 四段（1.2.0.31）会直接报 ERR_PNPM_BAD_PACKAGE_JSON / Invalid version。
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

// 1. 校验标准 semver
if (!/^\d+\.\d+\.\d+$/.test(String(pkg.version))) {
  fail(`版本必须是三段 semver（主.本.总），现在是 "${pkg.version}"`)
}
console.log(`发布版本 ${pkg.version}`)

// 2. 舞台目录：只放包内声明的文件，顺带避免把杂物推上去
const stage = mkdtempSync(path.join(tmpdir(), 'dsh-deputy-npm-'))
try {
  for (const entry of pkg.files ?? []) {
    const src = path.join(ROOT, entry.replace(/\/$/, ''))
    const dst = path.join(stage, entry.replace(/\/$/, ''))
    cpSync(src, dst, { recursive: true })
  }

  const outPkg = {
    ...pkg,
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
