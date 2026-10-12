/**
 * dsh-user-rules — 宿主半离线冒烟测试（不启动 DSH）。
 *
 * 用一个最小 ctx 桩件驱动 apply()，覆盖：
 *   1. 首次落盘 / 增删改查 / 排序 / 总开关；
 *   2. 系统提示注入文本（全局 + 工作区作用域过滤 + 关停时为空）；
 *   3. user_rules 工具与 /rules 命令；
 *   4. HTTP 路由的 CSRF 栅栏与写路径。
 *
 * 运行：node smoke-test.mjs
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sandbox = await mkdtemp(join(tmpdir(), 'user-rules-smoke-'))
process.env.DSH_HOME = sandbox

// harnessRequire 从 process.argv[1] 所在的树向上找 node_modules。
// 指向真实的 harness 安装位置，才能让 Config 的 schemastery 解析成功 ——
// 这正是线上发生的事（也才能复现 .volatile() 抹掉 default 那个坑）。
const HARNESS_BASE =
  process.env.USERPROFILE &&
  join(
    process.env.USERPROFILE,
    'AppData',
    'Roaming',
    'DSH Desktop',
    'backend',
    'dsh',
    'node_modules',
    '@deepseek-ai',
    'dsh-base',
    'lib',
    'index.js'
  )
const harnessAvailable = Boolean(HARNESS_BASE) && existsSync(HARNESS_BASE)
if (harnessAvailable) process.argv[1] = HARNESS_BASE

const mod = await import(pathToFileURL(join(import.meta.dirname, 'lib', 'index.mjs')).href)

let failures = 0
function check(label, cond, extra) {
  if (cond) {
    console.log(`  ✅ ${label}`)
  } else {
    failures += 1
    console.log(`  ❌ ${label}${extra === undefined ? '' : ` → ${JSON.stringify(extra)}`}`)
  }
}

// ── ctx 桩件 ────────────────────────────────────────────────────────────────

const effects = []
const sections = []
const tools = new Map()
const commands = new Map()
const routes = new Map()
const injects = []

function makeCtx() {
  return {
    effect(fn, label) {
      const d = fn()
      effects.push({ label, d })
      return d
    },
    inject(names, cb) {
      injects.push(names.join(','))
      const ctx = makeCtx()
      cb(ctx)
      return () => {}
    },
    get(service) {
      if (service === 'commands') {
        return {
          register(def) {
            commands.set(def.name, def)
            return () => commands.delete(def.name)
          },
        }
      }
      if (service === 'webServer') {
        return {
          register(route) {
            routes.set(route.path, route)
            return () => routes.delete(route.path)
          },
        }
      }
      return undefined
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {
          const i = sections.indexOf(section)
          if (i >= 0) sections.splice(i, 1)
        }
      },
    },
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => tools.delete(def.name)
      },
    },
  }
}

function renderSection(ctx, cwd) {
  const section = sections.find((s) => s.name === 'user-rules:rules')
  if (!section) return null
  const text = typeof section.text === 'function' ? section.text({ agent: { session: { header: { cwd } } } }) : section.text
  return text
}

function httpRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      this.body = body
    },
  }
}

function httpReq(method, url, body, headers = {}) {
  const handlers = {}
  const req = {
    method,
    url,
    headers,
    on(event, fn) {
      handlers[event] = fn
      return req
    },
    destroy() {},
  }
  setTimeout(() => {
    if (body !== undefined && handlers.data) handlers.data(Buffer.from(JSON.stringify(body)))
    if (handlers.end) handlers.end()
  }, 0)
  return req
}

// ── 驱动 ────────────────────────────────────────────────────────────────────

// 先跑「默认契约」一节：模拟组合行只写了几个键（甚至一个都没写）时
// schema 解析出来的形态。这正是线上暴露 sectionOrder:{} 的那条路径。
console.log('\n[0] 配置默认契约（回归：.volatile() 会抹掉 default）')
check('Config schema 已导出（schemastery 解析成功）', Boolean(mod.Config), String(mod.Config))
if (mod.Config) {
  const parsedEmpty = mod.Config({})
  check(
    'parse({}) 保留数值默认值',
    typeof parsedEmpty.sectionOrder === 'number' && typeof parsedEmpty.maxRuleChars === 'number',
    parsedEmpty
  )
  check('parse({}) sectionOrder = 10150', parsedEmpty.sectionOrder === 10150, parsedEmpty.sectionOrder)
  check(
    '任何键都不是空对象（volatile 回归探针）',
    Object.values(parsedEmpty).every((v) => typeof v !== 'object' || v === null || Array.isArray(v)),
    parsedEmpty
  )
}

const config = {
  enabled: true,
  sectionOrder: 10150,
  maxRuleChars: 4000,
  maxTotalChars: 20000,
  manageTools: true,
  manageCommand: true,
  httpRoutes: true,
}
const ctx = makeCtx()
const cleanup = mod.apply(ctx, config)
await new Promise((r) => setTimeout(r, 120))

console.log('\n[1] 注册面')
check('systemPrompt section 已注册', sections.some((s) => s.name === 'user-rules:rules'))
check('section order = 10150', sections.find((s) => s.name === 'user-rules:rules')?.order === 10150, sections.map((s) => s.order))
check('user_rules 工具已注册', tools.has('user_rules'))
check('/rules 命令已注册', commands.has('rules'))
check('三条 HTTP 路由已注册', routes.size === 3, [...routes.keys()])
check('可选服务走 ctx.inject', injects.includes('commands') && injects.includes('webServer'), injects)

const statePath = join(sandbox, 'user-rules.json')
const fileCreated = await readFile(statePath, 'utf8').then(
  () => true,
  () => false
)
check('状态文件已初始化', fileCreated, statePath)

console.log('\n[2] 无规则时零注入')
check('无规则 → 注入文本为空串', renderSection(ctx, 'C:\\work\\a') === '')

console.log('\n[3] 工具写路径')
const tool = tools.get('user_rules')
const exec = (cwd) => ({ agent: { session: { header: { cwd } } } })
let r1 = await tool.execute({ action: 'add', text: '回答一律使用中文。', title: '语言' }, exec('C:\\work\\a'))
check('add 成功', r1 && !r1.error, r1)
r1 = await tool.execute({ action: 'add', text: '改代码前先跑测试。' }, exec('C:\\work\\a'))
check('add 第二条成功', r1 && !r1.error, r1)
const list = await tool.execute({ action: 'list' }, exec('C:\\work\\a'))
check('list 返回 2 条', list.result.rules.length === 2, list.result.rules.length)
const firstId = list.result.rules[0].id

console.log('\n[4] 注入文本')
const injected = renderSection(ctx, 'C:\\work\\a')
check('注入非空', typeof injected === 'string' && injected.length > 0)
check('含规则正文', injected.includes('回答一律使用中文') && injected.includes('改代码前先跑测试'))
check('含约束性抬头', injected.includes('binding for this session'))
check('编号从 1 开始', injected.includes('1. ') && injected.includes('2. '))

console.log('\n[5] 排序 / 停用 / 修改 / 删除')
await tool.execute({ action: 'move', id: firstId, delta: 'down' }, exec('C:\\work\\a'))
const moved = (await tool.execute({ action: 'list' }, exec('C:\\work\\a'))).result.rules
check('move down 生效', moved[0].text.includes('改代码前'), moved.map((r) => r.text))

await tool.execute({ action: 'toggle', id: moved[0].id, enabled: false }, exec('C:\\work\\a'))
const afterToggle = renderSection(ctx, 'C:\\work\\a')
check('停用后不再注入该条', !afterToggle.includes('改代码前'), afterToggle)

await tool.execute({ action: 'update', id: moved[1].id, text: '所有回答一律使用简体中文。' }, exec('C:\\work\\a'))
check('update 生效', renderSection(ctx, 'C:\\work\\a').includes('简体中文'))

await tool.execute({ action: 'remove', id: moved[0].id }, exec('C:\\work\\a'))
const afterRemove = (await tool.execute({ action: 'list' }, exec('C:\\work\\a'))).result
check('remove 后剩 1 条', afterRemove.rules.length === 1, afterRemove.rules.length)

console.log('\n[6] 工作区作用域')
await tool.execute({ action: 'add', text: '这个仓库只改 src 目录。', scope: 'workspace' }, exec('C:\\work\\a'))
const inA = renderSection(ctx, 'C:\\work\\a')
const nested = renderSection(ctx, 'C:\\work\\a\\sub')
const inB = renderSection(ctx, 'C:\\work\\b')
check('同工作区命中', inA.includes('只改 src'))
check('子目录命中', nested.includes('只改 src'))
check('其他工作区不命中', !inB.includes('只改 src'), inB)
check('无 cwd 时全局规则仍在', renderSection(ctx, '').includes('简体中文'))

console.log('\n[7] 总开关')
await tool.execute({ action: 'setEnabled', enabled: false }, exec('C:\\work\\a'))
check('关闭后注入为空', renderSection(ctx, 'C:\\work\\a') === '')
await tool.execute({ action: 'setEnabled', enabled: true }, exec('C:\\work\\a'))
check('重新开启后恢复', renderSection(ctx, 'C:\\work\\a').includes('简体中文'))

console.log('\n[8] /rules 命令')
const cmd = commands.get('rules')
let c = await cmd.handler({ agent: { session: { header: { cwd: 'C:\\work\\a' } } }, rawInput: '' })
check('/rules 列出规则', c.kind === 'success' && c.text.includes('用户规则'), c)
c = await cmd.handler({ agent: { session: { header: { cwd: 'C:\\work\\a' } } }, rawInput: 'add 不要动 main 分支' })
check('/rules add 成功', c.kind === 'success' && c.text.includes('main 分支'), c)
c = await cmd.handler({ agent: { session: { header: { cwd: 'C:\\work\\a' } } }, rawInput: 'ws 只在本机跑测试' })
check('/rules ws 成功', c.kind === 'success' && c.text.includes('工作区规则'), c)
c = await cmd.handler({ agent: { session: { header: { cwd: 'C:\\work\\a' } } }, rawInput: 'off' })
check('/rules off 成功', c.kind === 'success' && c.text.includes('已关闭'), c)
c = await cmd.handler({ agent: { session: { header: { cwd: 'C:\\work\\a' } } }, rawInput: 'on' })
check('/rules on 成功', c.kind === 'success', c)
c = await cmd.handler({ agent: { session: { header: { cwd: 'C:\\work\\a' } } }, rawInput: 'remove #1' })
check('/rules remove 按序号成功', c.kind === 'success' && c.text.includes('已删除'), c)
c = await cmd.handler({ agent: { session: { header: { cwd: 'C:\\work\\a' } } }, rawInput: 'remove 999' })
check('/rules remove 不存在的序号报错', c.kind === 'error', c)

console.log('\n[9] HTTP 路由')
const stateRoute = routes.get('/user-rules/state')
let res = httpRes()
stateRoute.handler(httpReq('GET', '/user-rules/state'), res)
let payload = JSON.parse(res.body)
check('GET /state 返回快照', res.status === 200 && Array.isArray(payload.rules) && payload.path === statePath, payload.path)
check('快照含 lastCwd（装配期记录）', typeof payload.lastCwd === 'string', payload.lastCwd)

const actionRoute = routes.get('/user-rules/action')
res = httpRes()
actionRoute.handler(httpReq('GET', '/user-rules/action'), res)
check('GET action → 405', res.status === 405, res.status)

res = httpRes()
actionRoute.handler(httpReq('POST', '/user-rules/action', { action: 'list' }, {}), res)
check('POST 缺头 → 403', res.status === 403, res.status)

res = httpRes()
await actionRoute.handler(
  httpReq('POST', '/user-rules/action', { action: 'add', payload: { text: '来自管理页的规则。' } }, { 'x-dsh-user-rules': '1' }),
  res
)
await new Promise((r) => setTimeout(r, 80))
payload = JSON.parse(res.body)
check('POST 带头 → 200', res.status === 200, res.status)
check('管理页写入落盘', payload.state.rules.some((x) => x.text.includes('来自管理页')), payload.state.rules.map((x) => x.text))

res = httpRes()
await actionRoute.handler(
  httpReq('POST', '/user-rules/action', { action: 'nope' }, { 'x-dsh-user-rules': '1' }),
  res
)
await new Promise((r) => setTimeout(r, 80))
check('未知 action → 400', res.status === 400, JSON.parse(res.body))

console.log('\n[10] 持久化格式与外部改动拾取')
const disk = JSON.parse(await readFile(statePath, 'utf8'))
check('磁盘上 version=1', disk.version === 1, disk.version)
check('磁盘上 revision 递增', disk.revision > 0, disk.revision)
disk.rules.push({
  id: 'external-1',
  title: '外部',
  text: '手工写入的规则。',
  enabled: true,
  scope: 'global',
  workspacePath: '',
  source: 'user',
  createdAt: Date.now(),
  updatedAt: Date.now(),
})
await writeFile(statePath, JSON.stringify(disk, null, 2) + '\n', 'utf8')
await new Promise((r) => setTimeout(r, 3600))
check('外部改动被轮询拾取', renderSection(ctx, 'C:\\work\\a').includes('手工写入的规则'))

console.log('\n[11] 配置收敛（坏形态 config 不得让截断静默失效）')
// 线上那种坏形态：组合行没写键 → schemastery 给出 {}。
{
  const sandbox2 = await mkdtemp(join(tmpdir(), 'user-rules-smoke2-'))
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = sandbox2
  const ctx2 = makeCtx()
  mod.apply(ctx2, {
    enabled: {},
    sectionOrder: {},
    maxRuleChars: {},
    maxTotalChars: {},
    manageTools: true,
    manageCommand: true,
    httpRoutes: true,
    file: {},
  })
  await new Promise((r) => setTimeout(r, 120))

  const s2 = sections.find((s) => s.name === 'user-rules:rules')
  check('坏形态 config 下 order 退回默认 10150', s2 && s2.order === 10150, s2 && s2.order)

  const res2 = httpRes()
  routes.get('/user-rules/state').handler(httpReq('GET', '/user-rules/state'), res2)
  const snap2 = JSON.parse(res2.body)
  check('maxRuleChars 收敛为数字 4000', snap2.maxRuleChars === 4000, snap2.maxRuleChars)
  check('maxTotalChars 收敛为数字 20000', snap2.maxTotalChars === 20000, snap2.maxTotalChars)
  check('file={} 时退回 DSH_HOME 默认路径', snap2.path.endsWith('user-rules.json'), snap2.path)

  // 超长规则必须被拦下 —— 证明 maxRuleChars 真的在参与数值比较。
  const tool2 = tools.get('user_rules')
  const ex2 = { agent: { session: { header: { cwd: 'C:\\w' } } } }
  const r2 = await tool2.execute({ action: 'add', text: '甲'.repeat(5000) }, ex2)
  check('超长规则被 maxRuleChars 拒绝', Boolean(r2 && r2.error), r2 && r2.error && r2.error.slice(0, 80))

  process.env.DSH_HOME = savedHome
  await rm(sandbox2, { recursive: true, force: true })
}

console.log('\n[12] maxTotalChars 截断与标注')
{
  const sandbox3 = await mkdtemp(join(tmpdir(), 'user-rules-smoke3-'))
  const savedHome = process.env.DSH_HOME
  process.env.DSH_HOME = sandbox3
  const ctx3 = makeCtx()
  // 故意把总量上限压小，验证「放不下的按顺序跳过 + 明确标注」
  mod.apply(ctx3, { maxRuleChars: 4000, maxTotalChars: 200 })
  await new Promise((r) => setTimeout(r, 120))
  const s3 = sections.find((s) => s.name === 'user-rules:rules')
  const tool3 = tools.get('user_rules')
  const ex3 = { agent: { session: { header: { cwd: 'C:\\w' } } } }
  await tool3.execute({ action: 'add', text: '乙'.repeat(100) }, ex3)
  await tool3.execute({ action: 'add', text: '丙'.repeat(100) }, ex3)
  const txt3 = s3.text({ agent: { session: { header: { cwd: 'C:\\w' } } } })
  check('maxTotalChars 只放下第一条', txt3.includes('乙') && !txt3.includes('丙'), txt3.slice(0, 60))
  check('截断有明确标注', txt3.includes('maxTotalChars'), txt3.slice(-70))
  process.env.DSH_HOME = savedHome
  await rm(sandbox3, { recursive: true, force: true })
}

console.log('\n[13] 卸载清理')
for (const { d } of effects) {
  try {
    if (typeof d === 'function') d()
  } catch (e) {
    failures += 1
    console.log(`  ❌ effect 清理抛错：${e && e.message}`)
  }
}
if (typeof cleanup === 'function') cleanup()
check('section 已移除', !sections.some((s) => s.name === 'user-rules:rules'), sections.map((s) => s.name))

await rm(sandbox, { recursive: true, force: true })

console.log(`\n${failures === 0 ? '全部通过 ✅' : `${failures} 项失败 ❌`}`)
process.exit(failures === 0 ? 0 : 1)