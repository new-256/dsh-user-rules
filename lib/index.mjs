// dsh-user-rules — host 半（bundle 层组合：package.json 的 main 即本文件）。
//
// 能力：
//   1. 规则持久化：$DSH_HOME/user-rules.json（原子写：tmp + rename），
//      内存态 + mtime 轮询，外部编辑也能被拾取。
//   2. 系统提示注入：ctx.systemPrompt.section()，order 默认 10150
//      （WEB_SURFACE 10100 之后、DEPLOYMENT_PERSONA_SUFFIX 10200 之前 ——
//      贴近提示尾部，模型对末尾指令的遵守度最高）。无生效规则时返回空串，
//      该 section 会被 renderPrompt 直接过滤掉，零 token 成本。
//      workspace 作用域的规则按当前 Agent 的 session header cwd 过滤。
//   3. 模型工具 user_rules：list/add/update/remove/toggle/move/setEnabled/clear。
//   4. 斜杠命令 /rules：人（而非模型）直接维护规则，不进模型上下文。
//   5. HTTP 路由（webServer）：
//        GET  /user-rules/state   —— 管理页读取
//        POST /user-rules/action  —— 管理页写入（需 X-DSH-User-Rules: 1 头）
//        GET  /user-rules/health  —— 诊断
//      写操作要求自定义请求头：跨站表单无法设置自定义头，浏览器预检也会被
//      同源策略挡下，构成一个不破坏局域网访问（dsh-mobile-companion）的
//      CSRF 栅栏。
//
// 依赖纪律（沿用 dsh-web-search / dsh-model-status 踩坑结论）：
//   本文件位于用户目录下，Node 向上找不到 harness 的包 —— 绝不 import 任何
//   @deepseek-ai/*；可选 schemastery 经 createRequire 从主进程脚本位置解析，
//   解析失败则退化（Config 不导出），插件照常工作。
//   可选服务一律 ctx.inject([...]) / ctx.get() 探测，不进 inject 数组。

import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, normalize, sep } from 'node:path'

// ── 可选 harness 依赖 ───────────────────────────────────────────────────────

function harnessRequire(id) {
  for (const base of [process.argv[1], process.argv[0]]) {
    if (typeof base !== 'string' || base.length === 0) continue
    try {
      return createRequire(base)(id)
    } catch {
      /* 试下一个候选 */
    }
  }
  return undefined
}

/** schemastery（Config schema 用）；失败则 Config 不导出，config 仍原样传入 apply。 */
const Schema = harnessRequire('@deepseek-ai/schemastery')

// ── 常量与默认值 ────────────────────────────────────────────────────────────

export const name = 'user-rules'

/**
 * 只声明真正必需的硬依赖：tools（工具）与 systemPrompt（注入）。
 * commands 与 webServer 走 ctx.inject 可选注入 —— 缺了也不影响插件激活。
 */
export const inject = ['tools', 'systemPrompt']

const SECTION_NAME = 'user-rules:rules'
const STATE_FILE_NAME = 'user-rules.json'
const STATE_VERSION = 1
const MAX_TITLE_CHARS = 120

// ── 「一键优化」常量 ────────────────────────────────────────────────────────
/** 需求输入上限（字符）。超限直接拒绝，不静默截断用户输入。 */
const OPTIMIZE_MAX_INPUT_CHARS = 8000
/** 一次优化允许产生的最大操作数，防止模型刷出上百条规则。 */
const OPTIMIZE_MAX_OPS = 40
/** 模型输出上限。注意它必须够大：JSON 被截断会直接解析失败（这是期望行为）。 */
const OPTIMIZE_MAX_TOKENS = 4096
/** 单次模型调用的硬超时。 */
const OPTIMIZE_TIMEOUT_MS = 180000

const DEFAULT_CONFIG = {
  enabled: true,
  sectionOrder: 10150,
  maxRuleChars: 4000,
  maxTotalChars: 20000,
  manageTools: true,
  manageCommand: true,
  httpRoutes: true,
  optimize: true,
  file: '',
}

/**
 * 注意：这里**不能**用 .volatile()。
 * 本仓库的 schemastery 版本里，.volatile() 会把 default 一并抹掉 ——
 * 未被组合行显式写入的键会解析成 {}（一个空的 meta 对象）而不是默认值，
 * 于是 maxRuleChars / maxTotalChars 变成对象，所有比较恒为 false，
 * 截断逻辑静默失效。实测确证，见 smoke-test 的「默认契约」一节。
 */
function buildConfigSchema() {
  if (!Schema) return undefined
  return Schema.object({
    enabled: Schema.boolean().default(true).description('总开关：关闭后任何规则都不注入系统提示（规则本身不删除）。'),
    sectionOrder: Schema.number().default(10150).description('系统提示中的注入位置（数值越大越靠后）。默认 10150：在 WEB_SURFACE(10100) 之后、DEPLOYMENT_PERSONA_SUFFIX(10200) 之前。'),
    maxRuleChars: Schema.number().default(4000).description('单条规则最大字符数。'),
    maxTotalChars: Schema.number().default(20000).description('全部生效规则合计最大字符数，超出按顺序截断并标注。'),
    manageTools: Schema.boolean().default(true).description('是否向模型注册 user_rules 工具（用户可让模型代记规则）。'),
    manageCommand: Schema.boolean().default(true).description('是否注册 /rules 斜杠命令。'),
    httpRoutes: Schema.boolean().default(true).description('是否注册 Web 管理页所需的 HTTP 路由。'),
    optimize: Schema.boolean().default(true).description('是否开放「一键优化」（调用你选的模型把需求编译成规则）；关闭后管理页不显示该面板。'),
    file: Schema.string().default('').description('规则存储文件绝对路径；留空 = $DSH_HOME/user-rules.json。'),
  })
}

export const Config = buildConfigSchema()

// ── 路径与状态读写 ──────────────────────────────────────────────────────────

function dshHomeDir() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  return join(homedir(), '.dsh')
}

function resolveStatePath(config) {
  const explicit = typeof config?.file === 'string' ? config.file.trim() : ''
  if (explicit.length > 0) return explicit
  return join(dshHomeDir(), STATE_FILE_NAME)
}

function emptyState() {
  return { version: STATE_VERSION, revision: 0, enabled: true, rules: [] }
}

/** 把任意来源的 JSON 收敛成合法状态；坏字段逐一剔除而不是整份丢弃。 */
function normalizeState(raw) {
  const base = emptyState()
  if (raw === null || typeof raw !== 'object') return base
  const out = { ...base }
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (Number.isFinite(raw.revision)) out.revision = Math.max(0, Math.trunc(raw.revision))
  const list = Array.isArray(raw.rules) ? raw.rules : []
  const seen = new Set()
  for (const item of list) {
    if (item === null || typeof item !== 'object') continue
    const text = typeof item.text === 'string' ? item.text : ''
    if (text.trim().length === 0) continue
    let id = typeof item.id === 'string' && item.id.trim().length > 0 ? item.id.trim() : randomUUID()
    while (seen.has(id)) id = randomUUID()
    seen.add(id)
    const scope = item.scope === 'workspace' ? 'workspace' : 'global'
    out.rules.push({
      id,
      title: typeof item.title === 'string' ? item.title.slice(0, MAX_TITLE_CHARS) : '',
      text,
      enabled: item.enabled === false ? false : true,
      scope,
      workspacePath: scope === 'workspace' && typeof item.workspacePath === 'string' ? item.workspacePath : '',
      source: typeof item.source === 'string' ? item.source : 'user',
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : Date.now(),
    })
  }
  return out
}

// ── 运行期单例状态（模块级：同一进程内 HTTP / 工具 / 命令 / 提示共用一份）──

const runtime = {
  /** @type {ReturnType<typeof emptyState>} */
  state: emptyState(),
  path: '',
  revisionSeen: 0,
  mtimeMs: -1,
  loaded: false,
  lastError: null,
  lastCwd: '',
  stats: { loads: 0, saves: 0, injected: 0, lastInjectAt: null, lastInjectChars: 0 },
  /** apply(ctx) 时登记，供 HTTP 路由按需取用可选服务（如 llm）。 */
  ctx: null,
  /** 「一键优化」的可观测计数：模型调用次数 / 失败次数 / 最近一次耗时。 */
  optimize: { calls: 0, failures: 0, lastMs: null, lastError: null, lastExtractVia: null },
}

/**
 * 收敛 config。
 * 除了合并默认值，还要挡住「非预期形态」的取值：组合行没写某个键、或
 * schema 未生效（schemastery 解析失败时 Config 不导出）时，传进来的可能是
 * {} 之类的对象。数值键必须真是有限数，否则退回默认值 —— 否则
 * `used + line.length > maxTotalChars` 这种比较会恒为 false，截断静默失效。
 */
function setConfig(config) {
  const raw = config && typeof config === 'object' ? config : {}
  const pickBool = (key, fallback) => (typeof raw[key] === 'boolean' ? raw[key] : fallback)
  const pickNum = (key, fallback) => {
    const v = raw[key]
    return Number.isFinite(v) && v > 0 ? v : fallback
  }
  const order = raw.sectionOrder
  runtime.config = {
    enabled: pickBool('enabled', DEFAULT_CONFIG.enabled),
    sectionOrder: Number.isFinite(order) ? order : DEFAULT_CONFIG.sectionOrder,
    maxRuleChars: Math.trunc(pickNum('maxRuleChars', DEFAULT_CONFIG.maxRuleChars)),
    maxTotalChars: Math.trunc(pickNum('maxTotalChars', DEFAULT_CONFIG.maxTotalChars)),
    manageTools: pickBool('manageTools', DEFAULT_CONFIG.manageTools),
    manageCommand: pickBool('manageCommand', DEFAULT_CONFIG.manageCommand),
    httpRoutes: pickBool('httpRoutes', DEFAULT_CONFIG.httpRoutes),
    optimize: pickBool('optimize', DEFAULT_CONFIG.optimize),
    file: typeof raw.file === 'string' ? raw.file : DEFAULT_CONFIG.file,
  }
  runtime.path = resolveStatePath(runtime.config)
}

async function readStateFile() {
  const text = await readFile(runtime.path, 'utf8')
  return normalizeState(JSON.parse(text))
}

async function persist(next) {
  const dir = dirname(runtime.path)
  await mkdir(dir, { recursive: true })
  const payload = JSON.stringify(next, null, 2) + '\n'
  const tmp = `${runtime.path}.${process.pid}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, runtime.path)
  try {
    const st = await stat(runtime.path)
    runtime.mtimeMs = st.mtimeMs
  } catch {
    runtime.mtimeMs = -1
  }
  runtime.stats.saves += 1
}

/** 首次加载：文件不存在则落盘一份空状态。 */
async function loadState() {
  try {
    runtime.state = await readStateFile()
    try {
      const st = await stat(runtime.path)
      runtime.mtimeMs = st.mtimeMs
    } catch {
      runtime.mtimeMs = -1
    }
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      runtime.state = emptyState()
      try {
        await persist(runtime.state)
      } catch (err) {
        runtime.lastError = `初始化写盘失败：${String((err && err.message) || err)}`
      }
    } else {
      runtime.lastError = `读取规则失败：${String((e && e.message) || e)}`
      runtime.state = emptyState()
    }
  }
  runtime.revisionSeen = runtime.state.revision
  runtime.loaded = true
  runtime.stats.loads += 1
}

/** 轮询：文件被外部（手改 / 另一进程）改动时重新读入。 */
async function refreshIfChanged() {
  try {
    const st = await stat(runtime.path)
    if (st.mtimeMs === runtime.mtimeMs) return
    const next = await readStateFile()
    runtime.state = next
    runtime.revisionSeen = next.revision
    runtime.mtimeMs = st.mtimeMs
    runtime.stats.loads += 1
    runtime.lastError = null
  } catch (e) {
    if (e && e.code === 'ENOENT') return
    runtime.lastError = `轮询规则失败：${String((e && e.message) || e)}`
  }
}

/** 变更入口：改内存 → 落盘 → 更新缓存 mtime。 */
async function commit(mutator) {
  const draft = normalizeState(JSON.parse(JSON.stringify(runtime.state)))
  const next = mutator(draft) || draft
  next.revision = (runtime.state.revision || 0) + 1
  runtime.state = next
  runtime.revisionSeen = next.revision
  await persist(next)
  return runtime.state
}

// ── 作用域匹配与文本生成（同步：系统提示装配要求同步返回）──────────────────

function normalizePath(p) {
  if (typeof p !== 'string' || p.length === 0) return ''
  let out = normalize(p)
  if (out.endsWith(sep)) out = out.slice(0, -1)
  return process.platform === 'win32' ? out.toLowerCase() : out
}

/** workspace 作用域：cwd 等于该路径，或位于该路径之下。留空视为不匹配。 */
function scopeMatches(rule, cwd) {
  if (rule.scope !== 'workspace') return true
  const base = normalizePath(rule.workspacePath)
  if (base.length === 0) return false
  const cur = normalizePath(cwd)
  if (cur.length === 0) return false
  return cur === base || cur.startsWith(base + sep)
}

function effectiveRules(cwd) {
  return runtime.state.rules.filter((r) => r.enabled && r.text.trim().length > 0 && scopeMatches(r, cwd))
}

const SECTION_HEADER = [
  'User rules — standing instructions the user injected through the DSH "user-rules" plugin.',
  'They are binding for this session: follow them, and prefer them over your own defaults wherever they conflict.',
  'Unless a rule says otherwise, do not restate them and do not mention that they were injected.',
].join('\n')

/**
 * 生成注入文本。同步函数（装配阶段不会 await provider）。
 * 无生效规则时返回 '' —— renderPrompt 会把它整段丢掉。
 */
function buildSectionText(context) {
  const agent = context && context.agent
  let cwd = ''
  try {
    cwd = agent?.session?.header?.cwd || ''
  } catch {
    cwd = ''
  }
  // 记录最近一次装配看到的会话工作区 —— 管理页把它作为「仅工作区」的默认路径。
  if (typeof cwd === 'string' && cwd.length > 0) runtime.lastCwd = cwd
  if (!runtime.config.enabled || !runtime.state.enabled) return ''
  const rules = effectiveRules(cwd)
  if (rules.length === 0) return ''

  const perRule = runtime.config.maxRuleChars
  const total = runtime.config.maxTotalChars
  const lines = []
  let used = 0
  let truncated = 0
  for (const rule of rules) {
    let text = rule.text.trim()
    if (text.length > perRule) text = text.slice(0, perRule) + ' …（已按 maxRuleChars 截断）'
    const head = rule.title.trim().length > 0 ? `[${rule.title.trim()}] ` : ''
    const scopeTag = rule.scope === 'workspace' ? '（仅本工作区）' : ''
    const line = `${lines.length + 1}. ${head}${text}${scopeTag}`
    if (used + line.length > total) {
      truncated += 1
      continue
    }
    used += line.length
    lines.push(line)
  }
  if (lines.length === 0) return ''
  if (truncated > 0) lines.push(`（另有 ${truncated} 条规则因超出 maxTotalChars 未注入）`)

  runtime.stats.injected += 1
  runtime.stats.lastInjectAt = new Date().toISOString()
  runtime.stats.lastInjectChars = used
  return `${SECTION_HEADER}\n\n${lines.join('\n')}`
}

// ── 业务操作（HTTP / 工具 / 命令三处共用，只有一份实现）────────────────────

function findRule(idOrIndex) {
  const rules = runtime.state.rules
  const raw = String(idOrIndex || '').trim()
  if (raw.length === 0) return undefined
  const byId = rules.find((r) => r.id === raw)
  if (byId) return byId
  // 允许 "#2" / "2" 这种 1 基序号（管理页与 /rules 里对人友好）
  const n = Number(raw.replace(/^#/, ''))
  if (Number.isInteger(n) && n >= 1 && n <= rules.length) return rules[n - 1]
  return undefined
}

function makeRule(input, source, cwd) {
  const text = typeof input?.text === 'string' ? input.text.trim() : ''
  if (text.length === 0) throw new Error('规则内容不能为空')
  if (text.length > runtime.config.maxRuleChars) {
    throw new Error(`规则过长：${text.length} > maxRuleChars(${runtime.config.maxRuleChars})`)
  }
  const wantsWorkspace = input?.scope === 'workspace'
  const workspacePath = wantsWorkspace
    ? String(input?.workspacePath || cwd || '').trim()
    : ''
  if (wantsWorkspace && workspacePath.length === 0) {
    throw new Error('工作区作用域的规则需要一个工作区路径')
  }
  const now = Date.now()
  return {
    id: randomUUID(),
    title: typeof input?.title === 'string' ? input.title.trim().slice(0, MAX_TITLE_CHARS) : '',
    text,
    enabled: input?.enabled === false ? false : true,
    scope: wantsWorkspace ? 'workspace' : 'global',
    workspacePath,
    source,
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * 唯一操作实现。HTTP 路由、模型工具、/rules 命令都调用它。
 * @returns {Promise<object>} 结果对象（含 snapshot，便于调用方回读）
 */
async function runAction(action, payload, context) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const cwd = typeof context?.cwd === 'string' ? context.cwd : ''
  const source = typeof context?.source === 'string' ? context.source : 'user'

  switch (action) {
    case 'list':
      return { ok: true }

    case 'add': {
      const rule = makeRule(p, source, cwd)
      await commit((draft) => {
        draft.rules.push(rule)
      })
      return { ok: true, id: rule.id, added: true }
    }

    case 'update': {
      const target = findRule(p.id)
      if (!target) throw new Error(`未找到规则：${p.id}`)
      await commit((draft) => {
        const r = draft.rules.find((x) => x.id === target.id)
        if (!r) return
        if (typeof p.text === 'string' && p.text.trim().length > 0) r.text = p.text.trim()
        if (typeof p.title === 'string') r.title = p.title.trim().slice(0, MAX_TITLE_CHARS)
        if (p.enabled === true || p.enabled === false) r.enabled = p.enabled
        if (p.scope === 'global') {
          r.scope = 'global'
          r.workspacePath = ''
        } else if (p.scope === 'workspace') {
          const path = String(p.workspacePath || r.workspacePath || cwd || '').trim()
          if (path.length === 0) throw new Error('工作区作用域的规则需要一个工作区路径')
          r.scope = 'workspace'
          r.workspacePath = path
        }
        r.updatedAt = Date.now()
      })
      return { ok: true, id: target.id, updated: true }
    }

    case 'remove': {
      const target = findRule(p.id)
      if (!target) throw new Error(`未找到规则：${p.id}`)
      await commit((draft) => {
        draft.rules = draft.rules.filter((x) => x.id !== target.id)
      })
      return { ok: true, id: target.id, removed: true }
    }

    case 'toggle': {
      const target = findRule(p.id)
      if (!target) throw new Error(`未找到规则：${p.id}`)
      const next = p.enabled === true || p.enabled === false ? p.enabled : !target.enabled
      await commit((draft) => {
        const r = draft.rules.find((x) => x.id === target.id)
        if (r) {
          r.enabled = next
          r.updatedAt = Date.now()
        }
      })
      return { ok: true, id: target.id, enabled: next }
    }

    case 'move': {
      const target = findRule(p.id)
      if (!target) throw new Error(`未找到规则：${p.id}`)
      const delta = p.delta === 'up' || p.direction === 'up' ? -1 : 1
      await commit((draft) => {
        const i = draft.rules.findIndex((x) => x.id === target.id)
        const j = i + delta
        if (i < 0 || j < 0 || j >= draft.rules.length) return
        const [item] = draft.rules.splice(i, 1)
        draft.rules.splice(j, 0, item)
      })
      return { ok: true, id: target.id, moved: delta < 0 ? 'up' : 'down' }
    }

    case 'setEnabled': {
      const next = p.enabled !== false
      await commit((draft) => {
        draft.enabled = next
      })
      return { ok: true, enabled: next }
    }

    case 'clear':
      await commit((draft) => {
        draft.rules = []
      })
      return { ok: true, cleared: true }

    case 'replace': {
      const incoming = normalizeState(p.state)
      await commit((draft) => {
        draft.enabled = incoming.enabled
        draft.rules = incoming.rules
      })
      return { ok: true, replaced: true }
    }

    /**
     * 批量应用（一键优化的确认端）。一次 commit 落地全部增/改/删：
     * 校验不过就整批拒绝，绝不出现"一半成功"。
     */
    case 'applyBatch': {
      const ops = Array.isArray(p.ops) ? p.ops : []
      if (ops.length === 0) throw new Error('没有要应用的变更')
      if (ops.length > OPTIMIZE_MAX_OPS) {
        throw new Error(`变更项过多：${ops.length} > ${OPTIMIZE_MAX_OPS}`)
      }
      const plan = buildBatchPlan(ops, cwd)
      if (plan.adds.length + plan.updates.length + plan.removes.length === 0) {
        throw new Error('没有要应用的变更')
      }
      await commit((draft) => {
        applyBatchPlan(draft, plan, source)
      })
      return { ok: true, applied: plan.counts }
    }

    default:
      throw new Error(`未知操作：${action}`)
  }
}

/** 操作后回读快照（HTTP 与工具都用它作为返回值）。 */
function snapshot() {
  return {
    ok: true,
    enabled: runtime.config.enabled && runtime.state.enabled,
    pluginEnabled: runtime.config.enabled,
    masterEnabled: runtime.state.enabled,
    revision: runtime.state.revision,
    path: runtime.path,
    sectionOrder: runtime.config.sectionOrder,
    maxRuleChars: runtime.config.maxRuleChars,
    maxTotalChars: runtime.config.maxTotalChars,
    rules: runtime.state.rules.map((r, i) => ({ ...r, index: i + 1, chars: r.text.length })),
    lastCwd: runtime.lastCwd,
    stats: { ...runtime.stats },
    lastError: runtime.lastError,
    /** 管理页据此决定是否渲染「一键优化」面板。 */
    optimizeEnabled: runtime.config.optimize !== false,
    optimize: {
      calls: runtime.optimize.calls,
      failures: runtime.optimize.failures,
      lastMs: runtime.optimize.lastMs,
      lastExtractVia: runtime.optimize.lastExtractVia,
    },
  }
}

function renderListText() {
  const snap = snapshot()
  if (snap.rules.length === 0) return `当前没有用户规则。\n存储位置：${snap.path}`
  const head = `用户规则（${snap.rules.filter((r) => r.enabled).length}/${snap.rules.length} 条生效；总开关 ${snap.masterEnabled ? '开' : '关'}）\n存储位置：${snap.path}\n`
  const body = snap.rules
    .map((r) => `${r.index}. ${r.enabled ? '✅' : '⬜'} ${r.title ? `[${r.title}] ` : ''}${r.scope === 'workspace' ? `（仅 ${r.workspacePath}）` : '（全局）'} ${r.text.replace(/\s+/g, ' ').slice(0, 160)}`)
    .join('\n')
  return `${head}\n${body}`
}

// ── HTTP 助手 ───────────────────────────────────────────────────────────────

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体过大'))
        try {
          req.destroy()
        } catch {
          /* 忽略 */
        }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim().length === 0) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (e) {
        reject(new Error(`请求体不是合法 JSON：${String((e && e.message) || e)}`))
      }
    })
    req.on('error', (e) => reject(e))
  })
}

// ── 批量应用（一键优化的落盘端）─────────────────────────────────────────────

/**
 * 把一批操作收敛成一个「计划」。
 *
 * 纪律：**全部合法才返回计划，任一项不合法就抛错、且一个字都不写盘**。
 * 批量操作最怕的是「一半成功」——用户点一次按钮却得到半新半旧、自己都说不清
 * 的状态。所以这里先做纯内存校验，落盘在 applyBatchPlan 里一次性完成。
 */
function buildBatchPlan(ops, cwd) {
  const problems = []
  const adds = []
  const updates = []
  const removes = []
  /** id -> 已出现过的操作名，用来挡住 remove+update 同一 id 这类自相矛盾。 */
  const touched = new Map()

  ops.forEach((raw, i) => {
    const at = `第 ${i + 1} 项`
    const op = String(raw?.op || '').trim().toLowerCase()

    if (op === 'add') {
      const text = typeof raw?.text === 'string' ? raw.text.trim() : ''
      if (text.length === 0) {
        problems.push(`${at}（add）：text 为空`)
        return
      }
      if (text.length > runtime.config.maxRuleChars) {
        problems.push(`${at}（add）：text 过长 ${text.length} > ${runtime.config.maxRuleChars}`)
        return
      }
      const scope = raw?.scope === 'workspace' ? 'workspace' : 'global'
      const workspacePath = scope === 'workspace' ? String(raw?.workspacePath || cwd || '').trim() : ''
      if (scope === 'workspace' && workspacePath.length === 0) {
        problems.push(`${at}（add）：workspace 作用域需要工作区路径`)
        return
      }
      adds.push({
        title: typeof raw?.title === 'string' ? raw.title : '',
        text,
        scope,
        workspacePath,
      })
      return
    }

    if (op === 'update' || op === 'remove') {
      const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
      const target = runtime.state.rules.find((r) => r.id === id)
      if (!target) {
        problems.push(`${at}（${op}）：找不到 id=${id || '(空)'} 的规则`)
        return
      }
      const prev = touched.get(id)
      if (prev) {
        problems.push(`${at}（${op}）：同一条规则 id=${id.slice(0, 8)} 已被「${prev}」操作过，不能重复处理`)
        return
      }

      if (op === 'remove') {
        touched.set(id, 'remove')
        removes.push(id)
        return
      }

      const patch = { id }
      if (typeof raw?.text === 'string' && raw.text.trim().length > 0) {
        const text = raw.text.trim()
        if (text.length > runtime.config.maxRuleChars) {
          problems.push(`${at}（update）：text 过长 ${text.length} > ${runtime.config.maxRuleChars}`)
          return
        }
        patch.text = text
      }
      if (typeof raw?.title === 'string') patch.title = raw.title.trim().slice(0, MAX_TITLE_CHARS)
      if (raw?.scope === 'global') {
        patch.scope = 'global'
        patch.workspacePath = ''
      } else if (raw?.scope === 'workspace') {
        const path = String(raw?.workspacePath || target.workspacePath || cwd || '').trim()
        if (path.length === 0) {
          problems.push(`${at}（update）：workspace 作用域需要工作区路径`)
          return
        }
        patch.scope = 'workspace'
        patch.workspacePath = path
      }
      touched.set(id, 'update')
      updates.push(patch)
      return
    }

    problems.push(`${at}：未知操作「${raw?.op}」`)
  })

  if (problems.length > 0) {
    throw new Error(`批量应用被拒绝，未做任何改动：\n- ${problems.join('\n- ')}`)
  }
  return {
    adds,
    updates,
    removes,
    counts: { added: adds.length, updated: updates.length, removed: removes.length },
  }
}

/** 把计划写进草稿状态（只做内存变更，落盘由 commit 负责）。 */
function applyBatchPlan(draft, plan, source) {
  if (plan.removes.length > 0) {
    const gone = new Set(plan.removes)
    draft.rules = draft.rules.filter((r) => !gone.has(r.id))
  }
  for (const patch of plan.updates) {
    const r = draft.rules.find((x) => x.id === patch.id)
    if (!r) continue
    if (patch.text !== undefined) r.text = patch.text
    if (patch.title !== undefined) r.title = patch.title
    if (patch.scope !== undefined) {
      r.scope = patch.scope
      r.workspacePath = patch.workspacePath
    }
    r.updatedAt = Date.now()
  }
  for (const add of plan.adds) {
    draft.rules.push(makeRule(add, source, ''))
  }
}

// ── 「一键优化」：自然语言需求 → 机器可读规则 ──────────────────────────────

/**
 * 编译器提示词。
 *
 * 这里不只是「让模型写得整齐」，而是把**机器可读**拆成六条可判定的验收标准，
 * 并明确要求「需求已被覆盖就不要动」——否则模型倾向于每次都重写一遍全部规则，
 * 用户点一次优化就把自己的规则库洗掉。
 */
function optimizeSystemPrompt(maxRuleChars) {
  return [
    '你是一个「长期规则编译器」。你的职责：把用户的自然语言需求，编译成模型能直接照做、可长期复用的机器可读规则。',
    '',
    '## 什么算机器可读的规则',
    '一条合格的规则必须同时满足这六条：',
    '1. 祈使句，直接对模型下指令（「必须 / 一律 / 禁止 / 先…再…」这类硬性措辞）。禁止写「建议」「尽量」「适当」「注意」。',
    '2. 单一职责：一条规则只约束一件事。需求里含多个约束就拆成多条，不要塞进一条长句。',
    '3. 可验证：能判断有没有被遵守。禁止「保证代码质量」这类无法判定的表述。',
    '4. 自足：脱离本次对话也能读懂，不出现「上面说的」「这个项目」这类指代。',
    '5. 有触发条件：写清在什么情况下适用（例如「修改任何 TypeScript 文件时」「用户要求提交代码时」）。',
    '6. 不冗余：不与已有规则重复；已有规则只是措辞不全时，改写它，而不是再加一条。',
    '',
    '## 你的任务',
    '读「已有规则」与「用户需求」，输出一组操作，把规则库调整到能覆盖这些需求的最佳状态：',
    '- add：需求里有已有规则未覆盖的约束。',
    '- update：已有规则覆盖了该约束，但措辞不够机器可读、不完整或有歧义。',
    '- remove：已有规则与需求冲突、已被其它规则完全覆盖，或明显过时。',
    '',
    '重要：如果需求已经被现有规则完整覆盖，就输出空的 ops 数组。不要为了凑数而改动规则——无谓的改动只会污染规则库。',
    '',
    '## 输出格式',
    '只输出一个 JSON 对象。不要 markdown 代码块，不要在 JSON 前后写任何解释文字。结构：',
    '{"summary":"一句话说明本次调整","ops":[...]}',
    '',
    'ops 的每个元素只能是下面三种之一：',
    '{"op":"add","title":"短名，不超过16字","text":"规则正文","scope":"global","reason":"为什么加"}',
    '{"op":"update","id":"已有规则的 id","title":"短名","text":"改写后的正文","scope":"global","reason":"为什么要改"}',
    '{"op":"remove","id":"已有规则的 id","reason":"为什么删"}',
    '',
    '字段纪律：',
    '- id 必须原样抄「已有规则」里给出的 id，禁止自己编造 id。',
    '- scope 只能是 "global" 或 "workspace"，省略即视为 "global"。',
    `- 每条 text 不超过 ${maxRuleChars} 字。`,
    `- ops 最多 ${OPTIMIZE_MAX_OPS} 条。`,
    '- 规则正文的语言与用户需求保持一致（用户用中文就写中文）。',
  ].join('\n')
}

/** 拼用户侧输入：已有规则（含 id）+ 工作区 + 需求。 */
function buildOptimizePrompt(requirements, rules, cwd) {
  const existing =
    rules.length === 0
      ? '（当前规则库为空）'
      : rules
          .map((r, i) => {
            const scope = r.scope === 'workspace' ? `workspace(${r.workspacePath})` : 'global'
            return [
              `${i + 1}. id=${r.id}`,
              `   标题=${r.title || '(无)'}`,
              `   范围=${scope}`,
              `   启用=${r.enabled ? '是' : '否'}`,
              `   正文=${r.text}`,
            ].join('\n')
          })
          .join('\n')
  return [
    '## 已有规则',
    existing,
    '',
    '## 会话工作区',
    cwd && cwd.length > 0 ? cwd : '（未知）',
    '',
    '## 用户需求',
    requirements,
  ].join('\n')
}

/** 取 llm 服务。取不到就明确报错，绝不静默跳过。 */
function resolveLlm() {
  const ctx = runtime.ctx
  if (!ctx || typeof ctx.get !== 'function') throw new Error('插件上下文不可用，无法调用模型')
  const llm = ctx.get('llm')
  if (!llm || typeof llm.stream !== 'function') {
    throw new Error('llm 服务不可用：当前 profile 没有注册任何模型适配器')
  }
  return llm
}

/**
 * 跑一次模型调用并把文本增量拼起来。
 *
 * 只认 text-delta；reasoning-delta 不进结果（它是思考过程，不是产物）。
 * finish 的 error / aborted 一律抛出——这两种收尾下拼出来的文本都不完整，
 * 拿去解析只会得到一个更难懂的语法错误。
 */
async function collectModelText(llm, options) {
  const stream = llm.stream({
    provider: options.provider,
    model: options.model,
    ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
    system: options.system,
    messages: [{ role: 'user', content: [{ type: 'text', text: options.prompt }] }],
    temperature: 0,
    maxTokens: OPTIMIZE_MAX_TOKENS,
    signal: options.signal,
  })
  let text = ''
  let usage = null
  let finishKind = 'unknown'
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'usage') usage = chunk.usage
    else if (chunk.type === 'finish') {
      finishKind = chunk.reason?.kind || 'unknown'
      if (finishKind === 'error' || finishKind === 'aborted') {
        const failure = chunk.reason?.failure
        const why = failure?.message || failure?.code || '未提供原因'
        throw new Error(`模型调用${finishKind === 'aborted' ? '被中断' : '失败'}：${why}`)
      }
    }
  }
  if (text.trim().length === 0) {
    throw new Error(`模型没有返回任何文本（finish=${finishKind}）`)
  }
  return { text, usage, finishKind }
}

function tryParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

/**
 * 从模型输出里取出 JSON。
 *
 * 三级、且**每一级都如实上报**（返回值里的 via 会一路带到管理页）：
 *   raw    —— 干净解析，最理想；
 *   fence  —— 被包在 ``` 代码块里；
 *   braces —— JSON 前后混了解释文字，取最外层花括号区间。
 * 三级都不成才抛错，并把原始输出带回前端——让缺陷暴露，而不是悄悄吞掉。
 */
function extractJson(text) {
  const trimmed = String(text ?? '').trim()
  const direct = tryParseJson(trimmed)
  if (direct.ok) return { value: direct.value, via: 'raw' }

  const fence = trimmed.match(/^```(?:json|JSON)?\s*\r?\n([\s\S]*?)\r?\n?```$/)
  if (fence) {
    const inner = tryParseJson(fence[1].trim())
    if (inner.ok) return { value: inner.value, via: 'fence' }
  }

  const first = trimmed.indexOf('{')
  const last = trimmed.lastIndexOf('}')
  if (first >= 0 && last > first) {
    const sliced = tryParseJson(trimmed.slice(first, last + 1))
    if (sliced.ok) return { value: sliced.value, via: 'braces' }
  }

  return { value: null, via: null, error: direct.error }
}

/**
 * 把一条模型输出收敛成前端可核对的「提案」。
 *
 * 刻意**不丢坏项**：不合法的提案照样返回，带上 valid=false 与 problems，
 * 由管理页标红展示。悄悄丢掉一条操作，用户会以为模型只生成了这些，
 * 从而漏掉本来该看到的错误。
 */
function normalizeProposal(rawOp, index, rules, cwd) {
  const problems = []
  const rawKind = String(rawOp?.op || '').trim().toLowerCase()
  const op = rawKind === 'add' || rawKind === 'update' || rawKind === 'remove' ? rawKind : 'invalid'
  if (op === 'invalid') problems.push(`op 非法：${JSON.stringify(rawOp?.op ?? null)}`)

  const reason = typeof rawOp?.reason === 'string' ? rawOp.reason.trim() : ''
  const title = typeof rawOp?.title === 'string' ? rawOp.title.trim().slice(0, MAX_TITLE_CHARS) : ''
  const text = typeof rawOp?.text === 'string' ? rawOp.text.trim() : ''
  const id = typeof rawOp?.id === 'string' ? rawOp.id.trim() : ''

  let target = null
  if (op === 'update' || op === 'remove') {
    target = rules.find((r) => r.id === id) || null
    if (!target) problems.push(`找不到 id=${id || '(空)'} 的规则`)
  }
  if (op === 'add' || op === 'update') {
    if (text.length === 0) problems.push('text 为空')
    else if (text.length > runtime.config.maxRuleChars) {
      problems.push(`text 过长：${text.length} > ${runtime.config.maxRuleChars}`)
    }
  }

  const scope = rawOp?.scope === 'workspace' ? 'workspace' : 'global'
  let workspacePath = ''
  if (scope === 'workspace') {
    workspacePath = String(rawOp?.workspacePath || target?.workspacePath || cwd || '').trim()
    if (workspacePath.length === 0) problems.push('workspace 作用域缺少工作区路径')
  }

  return {
    index,
    op,
    id: op === 'add' ? '' : id,
    title,
    text,
    scope,
    workspacePath,
    reason,
    target: target
      ? {
          id: target.id,
          title: target.title,
          text: target.text,
          scope: target.scope,
          workspacePath: target.workspacePath,
          enabled: target.enabled,
        }
      : null,
    valid: problems.length === 0,
    problems,
  }
}

/**
 * 一键优化主流程：校验入参 → 调模型 → 取 JSON → 收敛提案。
 * **不写盘**：结果只是提案，落盘要等用户在管理页确认后走 applyBatch。
 */
async function runOptimize(payload, context) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const requirements = typeof p.requirements === 'string' ? p.requirements.trim() : ''
  if (requirements.length === 0) throw new Error('请先填写需求')
  if (requirements.length > OPTIMIZE_MAX_INPUT_CHARS) {
    throw new Error(`需求过长：${requirements.length} > ${OPTIMIZE_MAX_INPUT_CHARS} 字`)
  }
  const provider = String(p.provider || '').trim()
  const model = String(p.model || '').trim()
  if (provider.length === 0 || model.length === 0) throw new Error('请先选择要用于优化的模型')

  const cwd = typeof context?.cwd === 'string' ? context.cwd : ''
  const rules = runtime.state.rules

  const llm = resolveLlm()
  // 先证明这个 provider/model 真的存在，再花钱调它。
  const models = await llm.listModels(provider)
  if (!Array.isArray(models) || !models.some((m) => m.id === model)) {
    throw new Error(`provider「${provider}」下没有模型「${model}」`)
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), OPTIMIZE_TIMEOUT_MS)
  const startedAt = Date.now()
  runtime.optimize.calls += 1
  try {
    const { text, usage, finishKind } = await collectModelText(llm, {
      provider,
      model,
      reasoningEffort: typeof p.reasoningEffort === 'string' && p.reasoningEffort ? p.reasoningEffort : undefined,
      system: optimizeSystemPrompt(runtime.config.maxRuleChars),
      prompt: buildOptimizePrompt(requirements, rules, cwd),
      signal: controller.signal,
    })

    const extracted = extractJson(text)
    if (extracted.value === null) {
      const raw = text.length > 4000 ? `${text.slice(0, 4000)}\n…（已截断，共 ${text.length} 字）` : text
      throw new Error(`模型输出不是合法 JSON（${extracted.error}）。finish=${finishKind}。原始输出：\n${raw}`)
    }
    const parsed = extracted.value
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('模型输出的 JSON 顶层必须是对象（形如 {"summary":...,"ops":[...]}）')
    }
    if (!Array.isArray(parsed.ops)) {
      throw new Error('模型输出的 JSON 缺少 ops 数组')
    }
    if (parsed.ops.length > OPTIMIZE_MAX_OPS) {
      throw new Error(`模型产出了 ${parsed.ops.length} 条操作，超过上限 ${OPTIMIZE_MAX_OPS}`)
    }

    const proposals = parsed.ops.map((rawOp, i) => normalizeProposal(rawOp, i, rules, cwd))
    const elapsedMs = Date.now() - startedAt
    runtime.optimize.lastMs = elapsedMs
    runtime.optimize.lastExtractVia = extracted.via
    runtime.optimize.lastError = null

    return {
      ok: true,
      summary: typeof parsed.summary === 'string' ? parsed.summary.trim() : '',
      proposals,
      totals: {
        add: proposals.filter((x) => x.op === 'add').length,
        update: proposals.filter((x) => x.op === 'update').length,
        remove: proposals.filter((x) => x.op === 'remove').length,
        invalid: proposals.filter((x) => !x.valid).length,
      },
      model: { provider, model },
      finish: finishKind,
      usage,
      elapsedMs,
      /** 取出 JSON 的方式：raw / fence / braces（前端据此提示"格式不规范"）。 */
      extractVia: extracted.via,
    }
  } catch (e) {
    runtime.optimize.failures += 1
    runtime.optimize.lastError = String((e && e.message) || e)
    runtime.optimize.lastMs = Date.now() - startedAt
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 可选模型清单（管理页的模型选择器用）。 */
async function listOptimizeModels() {
  const llm = resolveLlm()
  const providers = llm.listProviders()
  const models = []
  const failures = []
  for (const provider of providers) {
    try {
      const list = await llm.listModels(provider.id)
      for (const m of list) {
        models.push({
          provider: provider.id,
          providerName: provider.name || provider.id,
          id: m.id,
          name: m.name || m.id,
          description: m.description || '',
        })
      }
    } catch (e) {
      // 单个 provider 拉不到模型不该让整页瘫痪，但要如实上报（前端会显示）。
      failures.push({ provider: provider.id, error: String((e && e.message) || e) })
    }
  }
  let preset = null
  try {
    const svc = runtime.ctx && typeof runtime.ctx.get === 'function' ? runtime.ctx.get('agentDefaultModel') : null
    if (svc && typeof svc.currentSelection === 'function') {
      const sel = svc.currentSelection()
      if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string') preset = sel
    }
  } catch {
    // 取不到默认选择不影响选择器可用（前端会退到第一个模型）。
  }
  return { ok: true, providers, models, preset, failures }
}

// ── 插件入口 ────────────────────────────────────────────────────────────────

export function apply(ctx, config) {
  setConfig(config)
  runtime.ctx = ctx
  const disposers = []
  const keep = (d) => {
    if (typeof d === 'function') disposers.push(d)
    return d
  }

  // 0. 首次加载 + 外部改动轮询（资源登记在插件自己的 effect 上，卸载即清理）。
  void loadState()

  keep(
    ctx.effect(() => {
      const tick = () => {
        void refreshIfChanged()
      }
      const timer = setInterval(tick, 3000)
      if (typeof timer.unref === 'function') timer.unref()
      return () => clearInterval(timer)
    }, 'user-rules: state watcher')
  )

  // 1. 系统提示注入（全局 section；workspace 作用域按 agent cwd 过滤）。
  keep(
    ctx.effect(
      () =>
        ctx.systemPrompt.section({
          name: SECTION_NAME,
          order: Number.isFinite(runtime.config.sectionOrder) ? runtime.config.sectionOrder : DEFAULT_CONFIG.sectionOrder,
          text: (context) => buildSectionText(context),
        }),
      'user-rules: system prompt section'
    )
  )

  // 2. 模型工具 user_rules（可按 config.manageTools 关闭）。
  if (runtime.config.manageTools !== false) {
    keep(
      ctx.effect(
        () =>
          ctx.tools.register({
            name: 'user_rules',
            description:
              '读取/维护用户的长期规则（"用户规则"）。这些规则会注入系统提示，对所有后续模型请求生效。' +
              '何时使用：用户明确要求你"记住"某条长期约定（例如「以后都用中文回答」「改代码前先跑测试」「不要动 main 分支」），' +
              '或用户要求查看/修改/删除已有规则时。不要用它记录一次性的任务上下文、临时偏好或本会话内的短期决定。' +
              'action 取值：list（默认，列出全部规则）；add（新增，需 text；可选 title、scope=global|workspace；' +
              'scope=workspace 时未给 workspacePath 则取当前会话工作区）；update（改 text/title/scope，需 id）；' +
              'remove（删除，需 id）；toggle（启用/停用，需 id，可选 enabled）；move（排序，需 id 与 delta=up|down）；' +
              'setEnabled（总开关，需 enabled）；clear（清空全部规则，属破坏性操作，必须先获得用户明确同意）。' +
              'id 既可传规则 id，也可传列表里的 1 基序号（"2" 或 "#2"）。' +
              '新增规则前先用 action=list 检查是否已存在等价规则，避免重复。',
            parameters: {
              type: 'object',
              additionalProperties: false,
              required: ['action'],
              properties: {
                action: {
                  type: 'string',
                  enum: ['list', 'add', 'update', 'remove', 'toggle', 'move', 'setEnabled', 'clear'],
                  description: '要执行的操作。',
                },
                id: { type: 'string', description: '规则 id 或列表序号（remove/update/toggle/move 必填）。' },
                text: { type: 'string', description: '规则正文（add 必填；update 可选）。写成模型能直接照做的祈使句。' },
                title: { type: 'string', description: '规则短名，便于识别（可选）。' },
                scope: {
                  type: 'string',
                  enum: ['global', 'workspace'],
                  description: '生效范围：global 对所有会话生效；workspace 只在工作区路径匹配的会话生效（默认 global）。',
                },
                workspacePath: { type: 'string', description: 'workspace 作用域的工作区路径；省略则用当前会话的工作目录。' },
                enabled: { type: 'boolean', description: 'toggle/setEnabled 的目标状态。' },
                delta: { type: 'string', enum: ['up', 'down'], description: 'move 的方向。' },
              },
            },
            output: {
              schema: { type: 'object', additionalProperties: true },
              render: (_args, value) => [
                {
                  type: 'text',
                  text:
                    typeof value?.text === 'string'
                      ? value.text
                      : `用户规则操作完成：${JSON.stringify(value?.result || value)}`,
                },
              ],
            },
            timeoutMs: 15000,
            isConcurrencySafe: () => false,
            async execute(args, exec) {
              const action = String(args?.action || 'list').trim() || 'list'
              const cwd = (() => {
                try {
                  return exec?.agent?.session?.header?.cwd || ''
                } catch {
                  return ''
                }
              })()
              if (action === 'list') return { result: snapshot(), text: renderListText() }
              try {
                const result = await runAction(action, args, { cwd, source: 'agent' })
                return {
                  result,
                  state: snapshot(),
                  text: `${resultText(action, args)}\n\n${renderListText()}`,
                }
              } catch (e) {
                return { error: String((e && e.message) || e), state: snapshot() }
              }
            },
          }),
        'user-rules: user_rules tool'
      )
    )
  }

  // 3. /rules 斜杠命令（可选服务 commands）。
  if (runtime.config.manageCommand !== false) {
    ctx.inject(['commands'], (cmdCtx) => {
      const commands = cmdCtx.get('commands')
      if (!commands || typeof commands.register !== 'function') return
      cmdCtx.effect(
        () =>
          commands.register({
            name: 'rules',
            description: '查看/维护用户规则：/rules、/rules add 文本、/rules ws 文本、/rules on|off、/rules remove #n、/rules clear',
            input: { hint: '[list | add 文本 | ws 文本 | on | off | remove #n | clear]' },
            recordInput: false,
            async handler(invocation) {
              try {
                const cwd = (() => {
                  try {
                    return invocation?.agent?.session?.header?.cwd || ''
                  } catch {
                    return ''
                  }
                })()
                const raw = String(invocation?.rawInput || '').trim()
                if (raw.length === 0 || raw === 'list' || raw === 'ls') {
                  return { kind: 'success', text: renderListText() }
                }
                const [verb, ...rest] = raw.split(/\s+/)
                const arg = rest.join(' ').trim()
                switch (verb.toLowerCase()) {
                  case 'on':
                    await runAction('setEnabled', { enabled: true }, { source: 'user' })
                    return { kind: 'success', text: `用户规则已开启。\n\n${renderListText()}` }
                  case 'off':
                    await runAction('setEnabled', { enabled: false }, { source: 'user' })
                    return { kind: 'success', text: '用户规则已关闭（规则保留，只是不再注入）。' }
                  case 'add':
                    if (arg.length === 0) return { kind: 'error', text: '用法：/rules add 规则正文' }
                    await runAction('add', { text: arg, scope: 'global' }, { source: 'user' })
                    return { kind: 'success', text: `已新增全局规则。\n\n${renderListText()}` }
                  case 'ws':
                  case 'workspace':
                    if (arg.length === 0) return { kind: 'error', text: '用法：/rules ws 规则正文' }
                    if (cwd.length === 0) return { kind: 'error', text: '当前会话没有工作目录，无法添加工作区规则。' }
                    await runAction('add', { text: arg, scope: 'workspace', workspacePath: cwd }, { source: 'user' })
                    return { kind: 'success', text: `已新增工作区规则（仅 ${cwd}）。\n\n${renderListText()}` }
                  case 'remove':
                  case 'rm':
                  case 'delete':
                    if (arg.length === 0) return { kind: 'error', text: '用法：/rules remove #序号 或 /rules remove <id>' }
                    await runAction('remove', { id: arg }, { source: 'user' })
                    return { kind: 'success', text: `已删除。\n\n${renderListText()}` }
                  case 'clear':
                    await runAction('clear', {}, { source: 'user' })
                    return { kind: 'success', text: '已清空全部用户规则。' }
                  default: {
                    // 兜底：整串当作一条新规则正文（"/rules 回答一律用中文"）
                    await runAction('add', { text: raw, scope: 'global' }, { source: 'user' })
                    return { kind: 'success', text: `已新增全局规则。\n\n${renderListText()}` }
                  }
                }
              } catch (e) {
                return { kind: 'error', text: String((e && e.message) || e) }
              }
            },
          }),
        'user-rules: /rules command'
      )
    })
  }

  // 4. Web 管理页 HTTP 路由（可选服务 webServer）。
  if (runtime.config.httpRoutes !== false) {
    ctx.inject(['webServer'], (webCtx) => {
      const ws = webCtx.get('webServer')
      if (!ws || typeof ws.register !== 'function') return

      webCtx.effect(
        () =>
          ws.register({
            kind: 'exact',
            path: '/user-rules/state',
            handler: (_req, res) => {
              try {
                sendJson(res, 200, snapshot())
              } catch (e) {
                sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
              }
            },
          }),
        'user-rules: state route'
      )

      webCtx.effect(
        () =>
          ws.register({
            kind: 'exact',
            path: '/user-rules/health',
            handler: (_req, res) => {
              sendJson(res, 200, {
                ok: true,
                path: runtime.path,
                fileExists: runtime.loaded,
                ruleCount: runtime.state.rules.length,
                enabled: runtime.config.enabled && runtime.state.enabled,
                sectionOrder: runtime.config.sectionOrder,
                schemaLoaded: Boolean(Schema),
                lastError: runtime.lastError,
                stats: runtime.stats,
                optimize: {
                  enabled: runtime.config.optimize !== false,
                  calls: runtime.optimize.calls,
                  failures: runtime.optimize.failures,
                  lastMs: runtime.optimize.lastMs,
                  lastError: runtime.optimize.lastError,
                  lastExtractVia: runtime.optimize.lastExtractVia,
                },
              })
            },
          }),
        'user-rules: health route'
      )

      webCtx.effect(
        () =>
          ws.register({
            kind: 'exact',
            path: '/user-rules/models',
            handler: async (_req, res) => {
              if (runtime.config.optimize === false) {
                return sendJson(res, 403, { ok: false, error: '一键优化已在配置中关闭（optimize: false）' })
              }
              try {
                return sendJson(res, 200, await listOptimizeModels())
              } catch (e) {
                return sendJson(res, 503, { ok: false, error: String((e && e.message) || e) })
              }
            },
          }),
        'user-rules: models route'
      )

      webCtx.effect(
        () =>
          ws.register({
            kind: 'exact',
            path: '/user-rules/optimize',
            handler: async (req, res) => {
              if (String(req.method || 'GET').toUpperCase() !== 'POST') {
                return sendJson(res, 405, { ok: false, error: '仅支持 POST' })
              }
              if (String(req.headers?.['x-dsh-user-rules'] || '') !== '1') {
                return sendJson(res, 403, { ok: false, error: '缺少 X-DSH-User-Rules: 1 请求头' })
              }
              if (runtime.config.optimize === false) {
                return sendJson(res, 403, { ok: false, error: '一键优化已在配置中关闭（optimize: false）' })
              }
              try {
                const body = await readBody(req)
                if (!runtime.loaded) await loadState()
                const result = await runOptimize(body?.payload ?? body, { cwd: runtime.lastCwd })
                return sendJson(res, 200, result)
              } catch (e) {
                return sendJson(res, 400, { ok: false, error: String((e && e.message) || e) })
              }
            },
          }),
        'user-rules: optimize route'
      )

      webCtx.effect(
        () =>
          ws.register({
            kind: 'exact',
            path: '/user-rules/action',
            handler: async (req, res) => {
              // CSRF 栅栏：http 方法 + 自定义头（跨站表单无法伪造自定义头）。
              if (String(req.method || 'GET').toUpperCase() !== 'POST') {
                return sendJson(res, 405, { ok: false, error: '仅支持 POST' })
              }
              if (String(req.headers?.['x-dsh-user-rules'] || '') !== '1') {
                return sendJson(res, 403, { ok: false, error: '缺少 X-DSH-User-Rules: 1 请求头' })
              }
              try {
                const body = await readBody(req)
                const action = String(body?.action || '').trim()
                if (action.length === 0) return sendJson(res, 400, { ok: false, error: '缺少 action' })
                if (!runtime.loaded) await loadState()
                const result = await runAction(action, body?.payload ?? body, { source: 'ui' })
                return sendJson(res, 200, { ...result, state: snapshot() })
              } catch (e) {
                return sendJson(res, 400, { ok: false, error: String((e && e.message) || e), state: snapshot() })
              }
            },
          }),
        'user-rules: action route'
      )
    })
  }

  return function cleanup() {
    for (const d of disposers) {
      try {
        d()
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 工具结果的人类可读摘要。 */
function resultText(action, payload) {
  switch (action) {
    case 'add':
      return '已新增用户规则，立即对后续模型请求生效。'
    case 'update':
      return '已更新用户规则。'
    case 'remove':
      return '已删除用户规则。'
    case 'toggle':
      return `已${payload?.enabled === false ? '停用' : payload?.enabled === true ? '启用' : '切换'}规则。`
    case 'move':
      return '已调整规则顺序。'
    case 'setEnabled':
      return `用户规则总开关已${payload?.enabled === false ? '关闭' : '开启'}。`
    case 'clear':
      return '已清空全部用户规则。'
    case 'applyBatch': {
      const c = payload?.applied || {}
      return `已批量应用：新增 ${c.added ?? 0} 条、修改 ${c.updated ?? 0} 条、删除 ${c.removed ?? 0} 条。`
    }
    default:
      return '操作完成。'
  }
}