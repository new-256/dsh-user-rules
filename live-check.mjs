/**
 * 真机端到端验收：对着**正在运行的 DSH** 跑一遍一键优化的真实链路。
 *
 * 与 smoke-test.mjs 的分工：
 *   · smoke-test 用 LLM 桩验证宿主逻辑（路由、解析、原子性），不需要 DSH；
 *   · 本脚本验证桩件**证明不了**的两件事：
 *       1) 真实 llm 服务接线可用（listProviders / listModels / stream）；
 *       2) 真实模型是否真的按约定吐 JSON。
 *     这两条只能靠真实调用，且必须真实调用 —— 否则"功能可用"就是猜的。
 *
 * 安全性：本脚本**绝不修改你的规则**。
 *   · /user-rules/optimize 只出提案、不写盘；
 *   · 唯一一次写请求是**故意的非法批量应用**，它的正确行为就是被拒绝。
 *     脚本会校验 revision 前后不变 —— 若真被接受了，那是必须立刻修的缺陷。
 *
 * 用法：node live-check.mjs [需求文本]
 *      环境变量 DSH_BASE 覆盖基地址（默认 http://127.0.0.1:63228）。
 */
const BASE = process.env.DSH_BASE || 'http://127.0.0.1:63228'
const HEADERS = { 'Content-Type': 'application/json', 'X-DSH-User-Rules': '1' }
const REQUIREMENTS =
	process.argv[2] ||
	'回答用户时必须一律使用简体中文；每次改完代码都要跑一遍测试再结束；git 提交信息一律用英文。'

let failures = 0
const ok = (label, extra = '') => console.log(`  ✅ ${label}${extra ? ` —— ${extra}` : ''}`)
const bad = (label, extra = '') => {
	failures += 1
	console.log(`  ❌ ${label}${extra ? ` —— ${extra}` : ''}`)
}
const assert = (cond, label, extra = '') => (cond ? ok(label, extra) : bad(label, extra))

async function getJson(path, timeoutMs = 20000) {
	const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(timeoutMs) })
	const text = await res.text()
	let json = null
	try {
		json = JSON.parse(text)
	} catch {
		/* 保留原始文本用于报错 */
	}
	return { status: res.status, json, text }
}

async function postJson(path, body, timeoutMs = 200000) {
	const res = await fetch(`${BASE}${path}`, {
		method: 'POST',
		headers: HEADERS,
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	})
	const text = await res.text()
	let json = null
	try {
		json = JSON.parse(text)
	} catch {
		/* 保留原始文本用于报错 */
	}
	return { status: res.status, json, text }
}

console.log(`目标：${BASE}\n`)

// ── [1] 宿主在线且插件已启用 ────────────────────────────────────────────
console.log('[1] 宿主健康检查')
let health
try {
	health = await getJson('/user-rules/health')
} catch (e) {
	bad('无法连接宿主', String(e.message || e))
	console.log('\n宿主没起来或地址不对；先启动 DSH 再跑本脚本。')
	process.exit(1)
}
assert(health.status === 200 && health.json?.ok === true, 'health 返回 ok', `HTTP ${health.status}`)
assert(health.json?.enabled === true, '插件处于启用状态')
assert(health.json?.schemaLoaded === true, '存储结构已加载')
assert(!health.json?.lastError, '没有遗留错误', health.json?.lastError || 'lastError 为空')
if (health.json?.optimize === undefined) {
	bad('health 未包含 optimize 统计', '说明宿主仍加载着旧模块，需要重启 DSH 后重跑')
}

// ── [2] 基线快照（用于证明本脚本没改数据） ──────────────────────────────
console.log('\n[2] 读取基线快照')
const before = await getJson('/user-rules/state')
if (before.status !== 200 || before.json?.ok !== true) {
	bad('/user-rules/state 不可用', `HTTP ${before.status} ${before.text.slice(0, 200)}`)
	process.exit(1)
}
const revBefore = before.json.revision
const rulesBefore = before.json.rules || []
ok('拿到基线', `revision=${revBefore} 规则 ${rulesBefore.length} 条`)
assert(
	before.json.optimizeEnabled !== undefined,
	'快照含 optimizeEnabled 字段',
	`值=${before.json.optimizeEnabled}`
)

// ── [3] 模型清单 ───────────────────────────────────────────────────────
console.log('\n[3] 拉取可用模型（GET /user-rules/models）')
const models = await getJson('/user-rules/models')
if (models.status !== 200 || models.json?.ok !== true) {
	bad('/user-rules/models 不可用', `HTTP ${models.status} ${models.text.slice(0, 300)}`)
	console.log('\n若这里是 404，说明宿主还没重启（新路由未注册）。')
	process.exit(1)
}
const list = models.json.models || []
assert(list.length > 0, '模型清单非空', `${list.length} 个模型 / ${(models.json.providers || []).length} 个供应商`)
if (Array.isArray(models.json.failures) && models.json.failures.length > 0) {
	console.log(`     （${models.json.failures.length} 个供应商拉取失败，已如实上报，不拖垮整页）`)
	for (const f of models.json.failures) console.log(`       - ${f.provider}: ${f.error}`)
}

const preset = models.json.preset
const picked = preset && list.some((m) => m.provider === preset.provider && m.id === preset.model)
	? preset
	: list[0]
ok('选定用于优化的模型', `${picked.provider} / ${picked.model}${preset ? '（来自当前默认）' : '（清单首项）'}`)

// ── [4] 真实优化（只出提案，不写盘） ────────────────────────────────────
console.log('\n[4] 用真实模型跑一次优化（POST /user-rules/optimize）')
console.log(`     需求：${REQUIREMENTS}`)
const t0 = Date.now()
const opt = await postJson('/user-rules/optimize', {
	requirements: REQUIREMENTS,
	provider: picked.provider,
	model: picked.model,
})
const elapsed = ((Date.now() - t0) / 1000).toFixed(1)

if (opt.status !== 200 || opt.json?.ok !== true) {
	bad('优化请求失败', `HTTP ${opt.status}`)
	console.log('\n--- 宿主返回（完整，便于定位）---')
	console.log(opt.text.slice(0, 4000))
	console.log('--- 结束 ---')
} else {
	const r = opt.json
	ok('优化返回 ok', `耗时 ${elapsed}s（宿主自报 ${(r.elapsedMs / 1000).toFixed(1)}s）`)
	assert(typeof r.summary === 'string' && r.summary.length > 0, '模型给出了 summary', r.summary)
	assert(Array.isArray(r.proposals), '返回 proposals 数组', `${(r.proposals || []).length} 条`)
	assert(
		['raw', 'fence', 'braces'].includes(r.extractVia),
		'如实上报 JSON 取值方式',
		r.extractVia === 'raw' ? 'raw（模型严格遵守了格式）' : `${r.extractVia}（模型未严格遵守，已如实提示）`
	)
	assert(r.finish === 'stop', 'finish 为 stop', String(r.finish))
	if (r.usage) ok('带回 token 用量', `in=${r.usage.inputTokens} out=${r.usage.outputTokens}`)

	const props = r.proposals || []
	const withReason = props.filter((p) => typeof p.reason === 'string' && p.reason.length > 0)
	assert(props.length === 0 || withReason.length === props.length, '每条提案都带理由', `${withReason.length}/${props.length}`)
	const valid = props.filter((p) => p.valid)
	const invalid = props.filter((p) => !p.valid)
	ok('提案合法性统计', `合法 ${valid.length} / 非法 ${invalid.length}（非法项不会被静默丢弃）`)
	for (const p of invalid) {
		console.log(`       ⚠ ${p.op}「${p.title || p.id}」：${(p.problems || []).join('；')}`)
	}
	const byOp = { add: 0, update: 0, remove: 0 }
	for (const p of props) if (byOp[p.op] !== undefined) byOp[p.op] += 1
	ok('操作分布', `add=${byOp.add} update=${byOp.update} remove=${byOp.remove}`)

	// 关键：update/remove 必须带上"改写前"的原规则，界面才能做比对。
	const needsTarget = props.filter((p) => p.op === 'update' || p.op === 'remove')
	const withTarget = needsTarget.filter((p) => p.target && p.target.text)
	assert(
		needsTarget.length === 0 || withTarget.length === needsTarget.length,
		'update/remove 都带回了原规则（可做前后比对）',
		`${withTarget.length}/${needsTarget.length}`
	)

	// 交叉验证：模型声称的 update/remove id 必须真的存在于当前规则里。
	const knownIds = new Set(rulesBefore.map((x) => x.id))
	const bogus = needsTarget.filter((p) => p.target && !knownIds.has(p.target.id))
	assert(bogus.length === 0, '提案引用的 id 都能对上现有规则', bogus.length ? bogus.map((p) => p.id).join(', ') : '全部匹配')
}

// ── [5] 原子性：非法批量应用必须被整批拒绝且不写盘 ──────────────────────
console.log('\n[5] 原子性验证（故意提交一条非法操作，期望被拒绝且不改数据）')
const rejected = await postJson('/user-rules/action', {
	action: 'applyBatch',
	payload: { ops: [{ op: 'bogus-op', title: '不该被写入', text: '这条操作不合法。' }] },
})
assert(rejected.status === 400, '非法批量应用被拒绝', `HTTP ${rejected.status}`)
assert(
	typeof rejected.json?.error === 'string' && rejected.json.error.includes('批量应用被拒绝'),
	'拒绝信息说明了"整批未改动"',
	(rejected.json?.error || '').split('\n')[0]
)

const after = await getJson('/user-rules/state')
assert(after.json?.revision === revBefore, 'revision 未变化（一个字都没写盘）', `${revBefore} → ${after.json?.revision}`)
assert(
	(after.json?.rules || []).length === rulesBefore.length,
	'规则条数未变化',
	`${rulesBefore.length} → ${(after.json?.rules || []).length}`
)

// ── 结论 ───────────────────────────────────────────────────────────────
console.log('')
if (failures === 0) {
	console.log('✅ 真机端到端验收通过：真实模型产出了可解析、可校验的规则提案，且未改动任何现有规则。')
	process.exit(0)
}
console.log(`❌ 真机端到端验收失败：${failures} 项未通过。`)
process.exit(1)