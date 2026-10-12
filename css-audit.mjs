/**
 * 样式类一致性检查：
 *   · 定义了但从未使用的类 → 死 CSS，应删除
 *   · 使用了但没有定义的类 → 漏样式，页面会"看起来没设计"
 * 这类问题肉眼在截图里很难发现（尤其是只在某个状态下才出现的类），
 * 所以做成可重复执行的检查。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(HERE, 'lib', 'client.js'), 'utf8')

const cssStart = src.indexOf('const CSS = `')
const cssEnd = src.indexOf('`;', cssStart)
if (cssStart < 0 || cssEnd < 0) throw new Error('定位不到 client.js 中的 CSS 常量')
const css = src.slice(cssStart, cssEnd)
// 模板字符串里的 ${...} 插值会干扰解析，这里断言没有。
if (/\$\{/.test(css)) throw new Error('CSS 模板里出现插值，检查脚本需要更新')

const defined = new Set([...css.matchAll(/\.(urx-[a-z0-9-]+)/g)].map((m) => m[1]))

// 从 className 出现的位置收集使用到的类名（含三元表达式里的两个分支）。
const used = new Set()
for (const m of src.matchAll(/className:\s*([^,\n]+)/g)) {
  for (const c of m[1].matchAll(/"(urx-[a-z0-9-]+(?:\s+urx-[a-z0-9-]+)*)"/g)) {
    for (const one of c[1].split(/\s+/)) used.add(one)
  }
}
for (const m of src.matchAll(/className:\s*"([^"]+)"/g)) {
  for (const one of m[1].split(/\s+/)) if (one.startsWith('urx-')) used.add(one)
}

const dead = [...defined].filter((c) => !used.has(c))
const missing = [...used].filter((c) => !defined.has(c))

console.log(`CSS 定义 ${defined.size} 个类，组件使用 ${used.size} 个类`)
console.log(`死 CSS（定义了但没用到）：${dead.length ? dead.join(', ') : '无'}`)
console.log(`漏样式（用了但没定义）：${missing.length ? missing.join(', ') : '无'}`)

if (missing.length) {
  console.error('\n❌ 存在没有样式的类名，页面会出现未设计元素。')
  process.exit(1)
}
console.log('\n✅ 样式类一致（无漏样式）')
