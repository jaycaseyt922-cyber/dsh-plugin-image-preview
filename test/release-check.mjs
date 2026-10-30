// 发版前的一条命令：版本/CHANGELOG 一致性、语法、宿主测试、打包产物内容、零运行时依赖。
// 不引第三方依赖，Windows 与 POSIX 都能跑（npm 走 shell，避免 .cmd 的 execFile 限制）。
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const line = (label) => console.log('  ok   ' + label)
const fail = (reason) => {
  failures.push(reason)
  console.log('  FAIL ' + reason)
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

// 1. 版本 ↔ CHANGELOG：最新一节必须是当前版本
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
const latest = changelog.match(/^## \[([^\]]+)\]/m)
if (latest === null) fail('CHANGELOG.md 里没有 `## [x.y.z]` 标题')
else if (latest[1] !== pkg.version) fail(`CHANGELOG 最新一节是 ${latest[1]}，package.json 是 ${pkg.version}`)
else line(`版本与 CHANGELOG 一致：${pkg.version}`)

// 2. 运行时依赖必须为零（客户端半借用宿主 React，不算依赖）
const deps = Object.keys(pkg.dependencies ?? {})
if (deps.length > 0) fail('运行时依赖必须为空：' + deps.join(', '))
else line('运行时依赖 0')

// 3. 语法：所有会被加载的 JS
for (const file of ['index.js', 'client.js', 'tools/cdp.mjs', 'test/host-smoke.mjs', 'test/probe-assertions.js']) {
  try {
    execFileSync(process.execPath, ['--check', join(root, file)], { stdio: 'pipe' })
    line(`语法 ${file}`)
  } catch (error) {
    fail(`${file} 语法错误：${String(error.stderr ?? error.message).trim().split('\n')[0]}`)
  }
}

// 4. 宿主半测试（退出码即结论；CI 也会单独跑一次）
try {
  execFileSync(process.execPath, [join(root, 'test/host-smoke.mjs')], { stdio: 'pipe' })
  line('host-smoke 通过')
} catch (error) {
  fail('host-smoke 失败：' + String(error.stdout ?? error.message).trim().split('\n').slice(-3).join(' | '))
}

// 5. 打包内容：该带的带、不该带的不带
try {
  // `--loglevel=silent` + 截到第一个 `[` 之前的内容一起丢掉：不同 npm 版本/终端会往
  // stdout 或 stderr 混 notices，CI 与本地不该因为这个差出结果。
  const raw = execSync('npm pack --json --dry-run --loglevel=silent', {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const jsonAt = raw.indexOf('[')
  if (jsonAt < 0) throw new Error('npm pack 没有输出 JSON：' + raw.trim().slice(0, 120))
  const packed = JSON.parse(raw.slice(jsonAt))[0]
  const files = packed.files.map((entry) => entry.path)
  const required = ['index.js', 'client.js', 'cordis.patch.yml', 'README.md', 'CHANGELOG.md', 'LICENSE', 'test/host-smoke.mjs']
  const missing = required.filter((entry) => !files.includes(entry))
  const shippedTools = files.filter((entry) => entry.startsWith('tools/'))
  if (missing.length > 0) fail('发布包缺少：' + missing.join(', '))
  if (shippedTools.length > 0) fail('发布包不该带 tools/：' + shippedTools.join(', '))
  if (missing.length === 0 && shippedTools.length === 0) {
    const kb = (packed.size / 1024).toFixed(1)
    line(`打包 ${files.length} 个文件 / ${kb} kB`)
  }
} catch (error) {
  fail('npm pack 检查失败：' + String(error.message).split('\n')[0])
}

if (failures.length > 0) {
  // 机器可读的一行，方便 CI 把它捞出来做成 annotation（日志本身要鉴权才能下载）。
  console.error('RELEASE-CHECK-FAILED: ' + JSON.stringify(failures))
  console.error(`release check 失败（${failures.length} 项）`)
  process.exit(1)
}
console.log('release check 通过')
