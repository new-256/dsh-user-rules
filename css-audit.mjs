/**
 * 样式类一致性检查：
 *   · 定义了但从未使用的类 → 死 CSS，应删除
 *   · 使用了但没有定义的类 → 漏样式，页面会"看起来没设计"
 *
 * 这类问题肉眼在截图里很难发现（尤其只在某个状态下才出现的类），所以做成
 * 可重复执行的检查。
 *
 * 关键在于"用法"必须扫得准。早先的版本只匹配 `className: "..."` 这种字面量，
 * 于是下面这些**真实存在**的用法全被漏判成死 CSS：
 *   · className: a ? "x y" : "x"                 —— 跨行的三元
 *   · className: `urx-prop${c ? " urx-prop-off" : ""}`   —— 模板拼接
 *   · className: `urx-op urx-op-${op}`           —— 动态后缀
 * 所以这里改成手写一个极小的词法扫描，只在**字符串/模板字面量**里取材：
 * 注释与 CSS 选择器自然被排除，模板里的静态文本也能给出前缀族。
 *
 * 前缀族（形如 `urx-op-`）表示"该前缀下所有已定义的类都可能被用到"。它会被
 * 单独列出来，而不是悄悄算作已用 —— 否则一个真正没人用的变体会被永久掩盖。
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

// 用法扫描必须在**去掉 CSS 块之后**的源码上进行，否则 CSS 里的选择器会被
// 当成"用到了"，死 CSS 就永远查不出来。
const code = src.slice(0, cssStart) + src.slice(cssEnd + 2)

const defined = new Set([...css.matchAll(/\.(urx-[a-z0-9-]+)/g)].map((m) => m[1]))

/**
 * 在字符串/模板字面量里收集 urx-* 类名。
 * 只关心引号边界，不解析 JS 语法；模板的 ${...} 当作代码递归处理。
 */
function collectLiterals(text) {
  const names = new Set()
  const families = new Set()
  const add = (chunk) => {
    for (const raw of chunk.split(/[^A-Za-z0-9-]+/)) {
      if (!raw.startsWith('urx-') || raw === 'urx-') continue
      if (raw.endsWith('-')) families.add(raw)
      else names.add(raw)
    }
  }
  const scan = (s) => {
    let i = 0
    while (i < s.length) {
      const c = s[i]
      if (c === '/' && s[i + 1] === '/') {
        const nl = s.indexOf('\n', i)
        i = nl < 0 ? s.length : nl
        continue
      }
      if (c === '/' && s[i + 1] === '*') {
        const end = s.indexOf('*/', i + 2)
        i = end < 0 ? s.length : end + 2
        continue
      }
      if (c !== '"' && c !== "'" && c !== '`') {
        i += 1
        continue
      }
      const quote = c
      let buf = ''
      let j = i + 1
      while (j < s.length) {
        const d = s[j]
        if (d === '\\') {
          buf += s[j + 1] ?? ''
          j += 2
          continue
        }
        if (d === quote) break
        if (quote === '`' && d === '$' && s[j + 1] === '{') {
          add(buf)
          buf = ''
          let depth = 0
          let k = j + 1
          for (; k < s.length; k += 1) {
            if (s[k] === '{') depth += 1
            else if (s[k] === '}') {
              depth -= 1
              if (depth === 0) break
            }
          }
          scan(s.slice(j + 2, k))
          j = k + 1
          continue
        }
        buf += d
        j += 1
      }
      add(buf)
      i = j + 1
    }
  }
  scan(text)
  return { names, families }
}

const { names: used, families } = collectLiterals(
  // React 的 key 不是样式类。先把 `key: <字面量>` 的取值抹掉，否则
  // `{ key: "urx-style" }` 这种只为 diff 稳定而起的 key 会被算成
  // "用了但没定义的类"，把一个正确的检查逼成噪声。
  code.replace(/\bkey:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, 'key: \u0000')
)

// 前缀族覆盖到的已定义类：算作已用，但要列出来供人工确认。
const coveredByFamily = new Map()
for (const fam of families) {
  for (const cls of defined) {
    if (cls.startsWith(fam)) {
      used.add(cls)
      if (!coveredByFamily.has(fam)) coveredByFamily.set(fam, [])
      coveredByFamily.get(fam).push(cls)
    }
  }
}

const dead = [...defined].filter((c) => !used.has(c)).sort()
const missing = [...used].filter((c) => !defined.has(c)).sort()

console.log(`CSS 定义 ${defined.size} 个类，组件使用 ${used.size} 个类`)
if (families.size) {
  for (const [fam, list] of coveredByFamily) {
    console.log(`  动态前缀 ${fam}* → ${list.join(', ')}`)
  }
  const bare = [...families].filter((f) => !coveredByFamily.has(f))
  if (bare.length) console.log(`  动态前缀（无匹配类，可能是笔误）：${bare.join(', ')}`)
}
console.log(`死 CSS（定义了但没用到）：${dead.length ? dead.join(', ') : '无'}`)
console.log(`漏样式（用了但没定义）：${missing.length ? missing.join(', ') : '无'}`)

if (missing.length) {
  console.error('\n❌ 存在没有样式的类名，页面会出现未设计元素。')
  process.exit(1)
}
console.log('\n✅ 样式类一致（无漏样式）')