// dsh-user-rules — client 半（浏览器花名册经 profile 的 node_modules 裸包名加载；
// 改本文件后刷新浏览器即生效，无需重启）。
//
// 在「设置 → 用户规则」槽位（settings.section，DSH 0.1.7+ 的 list 槽位）注册
// 规则管理页：总开关 / 列表（启用、排序、编辑、删除）/ 新增行 / 存储位置与状态。
// 数据面走同源 HTTP：
//   GET  /user-rules/state   —— 读取快照
//   POST /user-rules/action  —— 写入（X-DSH-User-Rules: 1 头）
// 写路径与 /rules 命令、user_rules 工具共用宿主侧的同一份 runAction 实现。
//
// 纪律（沿用 dsh-web-search / dsh-model-status 踩坑结论）：
//   1) inject 只写 ["slots"]——可选服务（locale 等）一律 ctx.get() 探测；
//   2) 不 import 任何 @deepseek-ai/* 客户端包，React 从模块表 require("react")；
//   3) 样式只引用 --dsw-alias-* 主题令牌，字面色仅用于图标；
//   4) 组件自包含，不依赖未声明的 props 契约；
//   5) 注册失败回退 slots.inject 等待 + 延迟重试，绝不抛错拖垮插件树。

window.__ModuleLoader__.load({
	id: "dsh-user-rules",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const diag = {
			module: "loaded",
			applied: false,
			registered: false,
			rendered: 0,
			lastError: null
		};
		if (typeof window !== "undefined") window.__dshUserRules = diag;

		try {
			const react = require("react");
			const h = react.createElement;
			const NS = "user-rules";

			// ── 字典（不依赖 locale 座位契约；有 ctx.locale 时优先用它）──────────
			const ZH = {
				title: "用户规则",
				subtitle: "规则会注入系统提示，本会话之后的每一次模型请求都遵守。",
				empty: "还没有任何规则。在下方输入一条规则，例如「回答一律用中文」「改代码前先跑测试」。",
				add: "添加规则",
				save: "保存",
				saved: "已保存",
				saveFailed: "保存失败",
				reload: "重新读取",
				loading: "读取中…",
				refresh: "刷新",
				delete: "删除",
				edit: "编辑",
				cancel: "取消",
				confirmDelete: "确认删除",
				clearAll: "清空全部",
				enabledAll: "总开关",
				enabledAllHint: "关闭后所有规则都不再注入。",
				scopeGlobal: "全局",
				scopeWorkspace: "仅当前工作区",
				placeholder: "写一条规则，越具体越容易遵守…",
				titlePlaceholder: "规则名（可选，便于识别）",
				count: "共 {n} 条规则（生效 {m} 条）",
				chars: "{n} 字",
				// 不要断言"当前会话没有工作区" —— 那可能是假的。
				// 真实原因往往是：本进程还没发生过模型请求，host 侧的 lastCwd 尚未被填充。
				noWorkspace: "尚未获取到会话工作区，暂只能添加全局规则（点「刷新」重试）。",
				filePath: "存储位置",
				injected: "正在注入系统提示",
				notInjected: "未注入",
				help: "规则按从上到下的顺序注入。全局规则对所有会话生效；工作区规则只在工作区路径匹配的会话生效。",
				emptyTitle: "暂无规则",
				addTitle: "新增规则",
				expand: "展开全文",
				collapse: "收起",
				up: "上移",
				down: "下移",
				on: "开",
				off: "关"
			};
			const EN = {
				title: "User Rules",
				subtitle: "Rules are injected into the system prompt; every later model request obeys them.",
				empty: "No rules yet. Add one below, for example \"Always answer in Chinese\".",
				add: "Add rule",
				save: "Save",
				saved: "Saved",
				saveFailed: "Save failed",
				reload: "Reload",
				loading: "Loading…",
				refresh: "Refresh",
				delete: "Delete",
				edit: "Edit",
				cancel: "Cancel",
				confirmDelete: "Confirm delete",
				clearAll: "Delete all",
				enabledAll: "Master switch",
				enabledAllHint: "When off, no rule is injected at all.",
				scopeGlobal: "Global",
				scopeWorkspace: "This workspace only",
				placeholder: "Write one rule — the more concrete, the better…",
				titlePlaceholder: "Rule name (optional)",
				count: "{n} rule(s), {m} in effect",
				chars: "{n} chars",
				// Never assert "this session has no workspace" — that may be false.
				// The usual real cause: no model request has happened in this process yet,
				// so the host-side lastCwd is still empty.
				noWorkspace: "Session workspace not known yet — only global rules for now (hit Refresh to retry).",
				filePath: "Stored at",
				injected: "Injected into the system prompt",
				notInjected: "Not injected",
				help: "Rules are injected top to bottom. Global rules apply everywhere; workspace rules only where the path matches.",
				emptyTitle: "No rules yet",
				addTitle: "Add a rule",
				expand: "Show full text",
				collapse: "Collapse",
				up: "Move up",
				down: "Move down",
				on: "on",
				off: "off"
			};

			function makeT(ctx) {
				let dict = ZH;
				try {
					const loc = ctx && typeof ctx.get === "function" ? ctx.get("locale") : undefined;
					if (loc && typeof loc.getLocale === "function") {
						const snap = loc.getLocale();
						const id = String((snap && (snap.id || snap.locale)) || "");
						if (/^en/i.test(id)) dict = EN;
					}
				} catch {
					/* 用中文兜底 */
				}
				const t = (key) => (dict[key] !== undefined ? dict[key] : ZH[key] !== undefined ? ZH[key] : key);
				t.fmt = (key, vars) =>
					String(t(key)).replace(/\{(\w+)\}/g, (_m, name) =>
						vars && vars[name] !== undefined ? String(vars[name]) : ""
					);
				return t;
			}

			// ── API ────────────────────────────────────────────────────────────
			async function apiState() {
				const res = await fetch("/user-rules/state", { headers: { Accept: "application/json" } });
				if (!res.ok) throw new Error(`HTTP ${res.status}`);
				return await res.json();
			}

			async function apiAction(action, payload) {
				const res = await fetch("/user-rules/action", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"X-DSH-User-Rules": "1"
					},
					body: JSON.stringify({ action, payload: payload || {} })
				});
				let data = null;
				try {
					data = await res.json();
				} catch {
					data = null;
				}
				if (!res.ok || (data && data.ok === false)) {
					throw new Error((data && data.error) || `HTTP ${res.status}`);
				}
				return data;
			}

			// ── 样式（只引用主题令牌）──────────────────────────────────────────
			//
			// 令牌取用纪律（视觉验收中踩过坑，务必遵守）：
			//   · 卡片/面板底色必须用 `settings-card-fill`，描边用 `settings-card-stroke`。
			//     直接写 bg-layer-1 是错的 —— 浅色下 bg-base / bg-layer-1 / layer-2 / layer-3
			//     四个令牌解析成同一个颜色（都是 #fff），卡片会彻底消失，只剩下
			//     4% 透明度的 border-l1，等于不可见。
			//   · 输入框底色用 `specific-input-major`（浅色 #fff / 深色 #2c2c2e），
			//     描边用 border-l3；用 bg-base 会导致深色下输入框与卡片同色。
			//   · 悬停一律用 `interactive-bg-hover`，不要自造透明色。
			//   · 主按钮用 button-primary-fill/hover + label-primary-inverted，
			//     brand-primary 在浅色下是近黑色，直接当填充会得到纯黑按钮。
			const CSS = `
.urx-root { display: flex; flex-direction: column; gap: 16px; padding: 2px 2px 24px; }

/* 头部 */
.urx-head h3 { margin: 0 0 6px; font-size: 15px; font-weight: 600; line-height: 1.4;
  color: var(--dsw-alias-label-primary); }
.urx-head p { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-secondary); }

/* 工具条 */
.urx-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.urx-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  padding: 5px 12px; border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l3); background: transparent;
  color: var(--dsw-alias-label-primary); font-size: 12.5px; line-height: 1.6;
  font-family: inherit; cursor: pointer;
  transition: background .12s ease, border-color .12s ease, color .12s ease, opacity .12s ease; }
.urx-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.urx-btn:active:not(:disabled) { background: var(--dsw-alias-interactive-bg-active); }
.urx-btn:focus-visible { outline: 2px solid var(--dsw-alias-state-business-primary); outline-offset: 1px; }
.urx-btn:disabled { opacity: .4; cursor: not-allowed; }
.urx-btn-primary { background: var(--dsw-alias-button-primary-fill);
  border-color: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-inverted); font-weight: 600; }
.urx-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover);
  border-color: var(--dsw-alias-button-primary-hover); }
.urx-btn-danger:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger);
  border-color: var(--dsw-alias-state-error-primary);
  color: var(--dsw-alias-state-error-primary); }
/* 二次确认待点击态：必须一眼看出"再点一次就删"，否则和普通按钮没区别 */
.urx-btn-armed { background: var(--dsw-alias-state-error-primary) !important;
  border-color: var(--dsw-alias-state-error-primary) !important;
  color: var(--dsw-alias-label-primary-inverted) !important; font-weight: 600; }
.urx-btn-icon { padding: 4px 8px; font-size: 12px; }

/* 计数靠右 */
.urx-count { margin-left: auto; font-size: 12px; color: var(--dsw-alias-label-secondary);
  font-variant-numeric: tabular-nums; }

/* 总开关 */
.urx-switch { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px;
  color: var(--dsw-alias-label-primary); cursor: pointer; user-select: none; }
.urx-switch input { width: 15px; height: 15px; margin: 0; cursor: pointer;
  accent-color: var(--dsw-alias-state-business-primary); }

/* 注入状态 */
.urx-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px;
  color: var(--dsw-alias-label-secondary); }
.urx-dot { width: 6px; height: 6px; border-radius: 50%; flex: 0 0 auto; }
.urx-dot-on { background: var(--dsw-alias-state-success-primary);
  box-shadow: 0 0 0 3px var(--dsw-alias-state-success-tertiary); }
.urx-dot-off { background: var(--dsw-alias-state-idle-primary); }

/* 规则列表 */
.urx-list { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.urx-card { display: flex; gap: 12px; padding: 12px 14px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-settings-card-fill);
  border: 1px solid var(--dsw-alias-settings-card-stroke);
  box-shadow: var(--dsw-elevation-stroke);
  transition: border-color .12s ease, opacity .12s ease; }
.urx-card:hover { border-color: var(--dsw-alias-border-l4); }
.urx-card-off { opacity: .5; }

/* 左侧：勾选 + 序号 */
.urx-gutter { display: flex; flex-direction: column; align-items: center; gap: 6px;
  flex: 0 0 auto; padding-top: 2px; }
.urx-gutter input { width: 15px; height: 15px; margin: 0; cursor: pointer;
  accent-color: var(--dsw-alias-state-business-primary); }
.urx-idx { font-size: 11px; line-height: 1; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary); min-width: 16px; text-align: center; }

/* 主体 —— 纵向两行：第一行「标题 + 标记 + 操作」，第二行「正文」。
   正文必须独占整行：早先把操作按钮放成同一横向 flex 的右侧列，
   按钮列会吃掉卡片右侧宽度，正文就在右边永久短一截、按钮下方空出一大块，
   看起来很难看（用户原话："详细规则显示时右侧短了一截"）。 */
.urx-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.urx-top { display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
.urx-rule-title { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  flex: 1 1 auto; min-width: 0; }
.urx-name { font-size: 13px; font-weight: 600; line-height: 1.5;
  color: var(--dsw-alias-label-primary); }
.urx-text { font-size: 12.5px; line-height: 1.7; color: var(--dsw-alias-label-secondary);
  white-space: pre-wrap; overflow-wrap: anywhere; }

/* 长文折叠：默认最多 4 行，点击展开 */
.urx-clamped { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical;
  overflow: hidden; }
.urx-more { align-self: flex-start; padding: 0; border: none; background: none;
  color: var(--dsw-alias-link); font-size: 11.5px; font-family: inherit;
  cursor: pointer; line-height: 1.6; }
.urx-more:hover { text-decoration: underline; }

/* 标记
   注意：不要在 .urx-tag 里再套一层 overflow:hidden 的 span。
   内层 span 作为 flex 子项，overflow:hidden 会把它的 min-width:auto 变成 0，
   于是被外层 flex 挤成零宽 —— 标签只剩一个小横杠，文字整个消失（已实测踩坑）。
   省略号直接做在 .urx-tag 自身上，用 inline-block + text-overflow。 */
.urx-tag { display: inline-block; vertical-align: middle; max-width: 260px;
  padding: 1px 7px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-interactive-bg-hover);
  font-size: 10.5px; line-height: 1.7; white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto;
  color: var(--dsw-alias-label-secondary); }
.urx-tag-ws { border-color: var(--dsw-alias-state-warn-tertiary);
  background: var(--dsw-alias-state-warn-tertiary);
  color: var(--dsw-alias-state-warn-label); }
.urx-tag-num { font-variant-numeric: tabular-nums; }
.urx-meta { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-tertiary); }

/* 操作按钮：并入标题行并靠右，不再单占一列宽度 */
.urx-actions { display: flex; gap: 4px; flex: 0 0 auto; align-items: center;
  margin-left: auto; }

/* 新增区 */
.urx-compose { display: flex; flex-direction: column; gap: 10px; padding: 14px;
  border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-settings-card-fill);
  border: 1px solid var(--dsw-alias-settings-card-stroke);
  box-shadow: var(--dsw-elevation-stroke); }
.urx-compose-label { font-size: 12px; font-weight: 600;
  color: var(--dsw-alias-label-primary); }

/* 输入 */
.urx-in { width: 100%; box-sizing: border-box; padding: 7px 10px;
  border-radius: var(--dsw-radius-sm);
  border: 1px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-specific-input-major);
  color: var(--dsw-alias-label-primary); font-size: 12.5px; line-height: 1.65;
  font-family: inherit; resize: vertical;
  transition: border-color .12s ease; }
.urx-in::placeholder { color: var(--dsw-alias-label-tertiary); }
.urx-in:hover { border-color: var(--dsw-alias-border-l4); }
.urx-in:focus { outline: none;
  border-color: var(--dsw-alias-state-business-primary); }
.urx-in:disabled { opacity: .5; cursor: not-allowed; }
.urx-in-line { resize: none; }
.urx-in-auto { width: auto; min-width: 120px; }
.urx-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.urx-row-note { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.urx-spacer { margin-left: auto; }

/* 空态 */
.urx-empty { display: flex; flex-direction: column; gap: 4px; padding: 24px 18px;
  border-radius: var(--dsw-radius-md);
  border: 1px dashed var(--dsw-alias-border-l3);
  text-align: center; }
.urx-empty-title { font-size: 12.5px; font-weight: 600;
  color: var(--dsw-alias-label-secondary); }
.urx-empty-hint { font-size: 11.5px; line-height: 1.7;
  color: var(--dsw-alias-label-tertiary); }

/* 提示条 */
.urx-note { display: flex; align-items: flex-start; gap: 8px;
  padding: 8px 11px; border-radius: var(--dsw-radius-sm);
  font-size: 12px; line-height: 1.65;
  border: 1px solid transparent; overflow-wrap: anywhere; }
.urx-note-ok { color: var(--dsw-alias-state-success-primary);
  background: var(--dsw-alias-state-success-tertiary);
  border-color: var(--dsw-alias-state-success-tertiary); }
.urx-note-err { color: var(--dsw-alias-state-error-primary);
  background: var(--dsw-alias-code-diff-deleted);
  border-color: var(--dsw-alias-code-diff-deleted); }

/* 页脚 */
.urx-foot { display: flex; flex-direction: column; gap: 8px;
  padding-top: 14px; border-top: 1px solid var(--dsw-alias-border-l3);
  font-size: 11.5px; line-height: 1.7;
  color: var(--dsw-alias-label-tertiary); }
.urx-foot-row { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.urx-foot-key { flex: 0 0 auto; color: var(--dsw-alias-label-tertiary); }
.urx-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px; overflow-wrap: anywhere;
  color: var(--dsw-alias-label-secondary); }
.urx-json { max-height: 260px; overflow: auto; margin: 0; padding: 10px 12px;
  border-radius: var(--dsw-radius-sm);
  background: var(--dsw-alias-markdown-inline-code);
  border: 1px solid var(--dsw-alias-border-l3); }
.urx-json::-webkit-scrollbar { width: 8px; height: 8px; }
.urx-json::-webkit-scrollbar-thumb { border-radius: 4px;
  background: var(--dsw-alias-scrollbar-bg-l1); }
.urx-json::-webkit-scrollbar-thumb:hover {
  background: var(--dsw-alias-scrollbar-hover-l1); }
`;

			function StyleTag() {
				return h("style", { key: "urx-style", dangerouslySetInnerHTML: { __html: CSS } });
			}

			// ── 组件 ──────────────────────────────────────────────────────────
			function UserRulesSection(props) {
				diag.rendered += 1;
				const t = react.useMemo(() => makeT(props && props.__ctx), []);
				const [state, setState] = react.useState(null);
				const [error, setError] = react.useState(null);
				const [note, setNote] = react.useState(null);
				const [busy, setBusy] = react.useState(false);
				const [draftText, setDraftText] = react.useState("");
				const [draftTitle, setDraftTitle] = react.useState("");
				const [draftScope, setDraftScope] = react.useState("global");
				const [editing, setEditing] = react.useState(null); // { id, text, title, scope }
				const [confirming, setConfirming] = react.useState(null); // rule id
				const [showRaw, setShowRaw] = react.useState(false);
				const [expanded, setExpanded] = react.useState({}); // { [ruleId]: true }
				// { [ruleId]: boolean } —— 该条规则在折叠态下是否真的溢出了。
				// undefined 表示"还没量过"，此时先按折叠渲染以便测量。
				const [clampable, setClampable] = react.useState({});

				// 量真实溢出：只有 scrollHeight 超过 clientHeight 的才显示"展开全文"。
				// 依赖项留空，每次渲染后都量；setState 里做了相等判断，不会死循环。
				react.useLayoutEffect(() => {
					const nodes = document.querySelectorAll("[data-urx-clamped]");
					if (nodes.length === 0) return;
					const measured = {};
					for (const el of nodes) {
						const id = el.getAttribute("data-urx-clamped");
						if (id) measured[id] = el.scrollHeight > el.clientHeight + 1;
					}
					setClampable((cur) => {
						let changed = false;
						const next = { ...cur };
						for (const id of Object.keys(measured)) {
							if (next[id] !== measured[id]) {
								next[id] = measured[id];
								changed = true;
							}
						}
						return changed ? next : cur;
					});
				});

				// 容器变宽/变窄会改变换行，重新测量（清空后同一次渲染会再次折叠测量）。
				react.useEffect(() => {
					const onResize = () => setClampable({});
					window.addEventListener("resize", onResize);
					return () => window.removeEventListener("resize", onResize);
				}, []);

				const load = react.useCallback(async (silent) => {
					if (!silent) setBusy(true);
					try {
						const data = await apiState();
						setState(data);
						setError(null);
					} catch (e) {
						setError(String((e && e.message) || e));
					} finally {
						if (!silent) setBusy(false);
					}
				}, []);

				react.useEffect(() => {
					let alive = true;
					load(false);
					const timer = setInterval(() => {
						if (alive) load(true);
					}, 4000);
					return () => {
						alive = false;
						clearInterval(timer);
					};
				}, [load]);

				const run = react.useCallback(
					async (action, payload, okText) => {
						setBusy(true);
						setNote(null);
						try {
							const res = await apiAction(action, payload);
							if (res && res.state) setState(res.state);
							else await load(true);
							setNote({ kind: "ok", text: okText || t("saved") });
							setTimeout(() => setNote(null), 2200);
							return true;
						} catch (e) {
							setNote({ kind: "err", text: `${t("saveFailed")}：${String((e && e.message) || e)}` });
							return false;
						} finally {
							setBusy(false);
						}
					},
					[load, t]
				);

				const rules = (state && state.rules) || [];
				const activeCount = rules.filter((r) => r.enabled).length;
				const masterOn = Boolean(state && state.masterEnabled);
				const injecting = Boolean(state && state.enabled);
				const lastCwd = (state && state.lastCwd) || "";

				const addRule = async () => {
					const text = draftText.trim();
					if (text.length === 0) return;
					const payload = { text, title: draftTitle.trim(), scope: draftScope };
					if (draftScope === "workspace" && lastCwd) payload.workspacePath = lastCwd;
					const ok = await run("add", payload, t("saved"));
					if (ok) {
						setDraftText("");
						setDraftTitle("");
					}
				};

				const saveEdit = async () => {
					if (!editing) return;
					const ok = await run(
						"update",
						{ id: editing.id, text: editing.text, title: editing.title, scope: editing.scope },
						t("saved")
					);
					if (ok) setEditing(null);
				};

				const card = (rule) => {
					const isEditing = editing && editing.id === rule.id;
					const isConfirming = confirming === rule.id;
					// 操作按钮并入标题行、靠右（.urx-actions 的 margin-left:auto）。
					// 关键点：正文必须是这一行之外的兄弟节点，才能独占整行宽度；
					// 早先把按钮放成卡片右侧独立一列，正文就被永久压缩、右边空一截。
					const actions = h(
						"div",
						{ className: "urx-actions" },
						h(
							"button",
							{
								className: "urx-btn urx-btn-icon",
								disabled: busy || rule.index === 1,
								title: t("up"),
								onClick: () => run("move", { id: rule.id, delta: "up" }, t("saved"))
							},
							"↑"
						),
						h(
							"button",
							{
								className: "urx-btn urx-btn-icon",
								disabled: busy || rule.index === rules.length,
								title: t("down"),
								onClick: () => run("move", { id: rule.id, delta: "down" }, t("saved"))
							},
							"↓"
						),
						h(
							"button",
							{
								className: "urx-btn urx-btn-icon",
								disabled: busy,
								onClick: () =>
									setEditing(
										isEditing
											? null
											: { id: rule.id, text: rule.text, title: rule.title, scope: rule.scope }
									)
							},
							t("edit")
						),
						h(
							"button",
							{
								className: isConfirming
									? "urx-btn urx-btn-icon urx-btn-danger urx-btn-armed"
									: "urx-btn urx-btn-icon urx-btn-danger",
								disabled: busy,
								onClick: async () => {
									if (!isConfirming) {
										setConfirming(rule.id);
										setTimeout(() => setConfirming((cur) => (cur === rule.id ? null : cur)), 3000);
										return;
									}
									setConfirming(null);
									await run("remove", { id: rule.id }, t("saved"));
								}
							},
							isConfirming ? t("confirmDelete") : t("delete")
						)
					);
					return h(
						"li",
						{ key: rule.id, className: rule.enabled ? "urx-card" : "urx-card urx-card-off" },
						h(
							"div",
							{ className: "urx-gutter" },
							h("input", {
								type: "checkbox",
								checked: rule.enabled,
								disabled: busy,
								title: t("enabledAll"),
								onChange: () => run("toggle", { id: rule.id, enabled: !rule.enabled }, t("saved"))
							}),
							h("span", { className: "urx-idx" }, String(rule.index))
						),
						h(
							"div",
							{ className: "urx-main" },
							// 第一行：标题 + 标记 + 操作按钮（按钮靠右，与标题同一行）
							h(
								"div",
								{ className: "urx-rule-title" },
								rule.title
									? h("span", { className: "urx-name" }, rule.title)
									: h("span", { className: "urx-meta" }, rule.id.slice(0, 8)),
								h(
									"span",
									{
											className: rule.scope === "workspace" ? "urx-tag urx-tag-ws" : "urx-tag",
											title:
												rule.scope === "workspace"
													? `${t("scopeWorkspace")}${rule.workspacePath ? ` · ${rule.workspacePath}` : ""}`
													: t("scopeGlobal")
										},
										rule.scope === "workspace"
											? `${t("scopeWorkspace")}${rule.workspacePath ? ` · ${rule.workspacePath}` : ""}`
											: t("scopeGlobal")
									),
									h("span", { className: "urx-tag urx-tag-num" }, t.fmt("chars", { n: rule.chars })),
									actions
								),
								isEditing
								? h(
										"div",
										{ className: "urx-row", style: { flexDirection: "column", alignItems: "stretch", gap: "8px" } },
										h("input", {
											className: "urx-in urx-in-line",
											value: editing.title,
											placeholder: t("titlePlaceholder"),
											onChange: (e) => setEditing({ ...editing, title: e.target.value })
										}),
										h("textarea", {
											className: "urx-in",
											rows: 3,
											value: editing.text,
											onChange: (e) => setEditing({ ...editing, text: e.target.value })
										}),
										h(
											"div",
											{ className: "urx-row" },
											h(
												"select",
												{
													className: "urx-in urx-in-auto",
													value: editing.scope,
													onChange: (e) => setEditing({ ...editing, scope: e.target.value })
												},
												h("option", { value: "global" }, t("scopeGlobal")),
												h(
													"option",
													{ value: "workspace", disabled: !lastCwd && !rule.workspacePath },
													t("scopeWorkspace")
												)
											),
											h(
												"button",
												{ className: "urx-btn urx-btn-primary", disabled: busy, onClick: saveEdit },
												t("save")
											),
											h("button", { className: "urx-btn", disabled: busy, onClick: () => setEditing(null) }, t("cancel"))
										)
								  )
								: (() => {
										// 折叠判定必须看「真实是否被截断」，不能按字符数猜。
										// 之前用 text.length > 160 猜：142 字的第 1 条渲染出 5 行却
										// 没有「展开全文」，206 字的第 2 条却被折叠 —— 同样长度
										// 表现不一致，看起来像 bug（用户就是这么发现的）。
										// 现在：先乐观地加折叠类，量出 scrollHeight > clientHeight
										// 才认定"可展开"，量出来没溢出就彻底去掉折叠类。
										const isOpen = !!expanded[rule.id];
										const known = Object.prototype.hasOwnProperty.call(clampable, rule.id);
										const overflows = clampable[rule.id] === true;
										// 未测量时先按折叠渲染，否则永远量不出溢出。
										const useClamp = !isOpen && (!known || overflows);
										return [
											h(
												"div",
												{
													key: "text",
													className: useClamp ? "urx-text urx-clamped" : "urx-text",
													// 只给"当前处于折叠态"的节点打标记，供测量选择器使用；
													// 展开态不打标记，避免把它的"没溢出"写回去导致收起按钮消失。
													"data-urx-clamped": useClamp ? rule.id : undefined
												},
												rule.text
											),
											known && overflows
												? h(
														"button",
														{
															key: "more",
															className: "urx-more",
															onClick: () =>
																setExpanded((cur) => ({ ...cur, [rule.id]: !cur[rule.id] }))
														},
														isOpen ? t("collapse") : t("expand")
												  )
												: null
										];
									})()
						)
					);
				};

				return h(
					"div",
					{ className: "urx-root" },
					h(StyleTag),
					h(
						"div",
						{ className: "urx-head" },
						h("h3", null, t("title")),
						h("p", null, t("subtitle"))
					),

					// 工具条：总开关 + 计数 + 刷新
					h(
						"div",
						{ className: "urx-bar" },
						h(
							"label",
							{ className: "urx-switch", title: t("enabledAllHint") },
							h("input", {
								type: "checkbox",
								checked: masterOn,
								disabled: busy || !state,
								onChange: (e) => run("setEnabled", { enabled: e.target.checked }, t("saved"))
							}),
							`${t("enabledAll")} ${masterOn ? t("on") : t("off")}`
						),
						h(
							"span",
							{ className: "urx-status", title: injecting ? t("injected") : t("notInjected") },
							h("span", {
								className: injecting ? "urx-dot urx-dot-on" : "urx-dot urx-dot-off"
							}),
							injecting ? t("injected") : t("notInjected")
						),
						h("button", { className: "urx-btn", disabled: busy, onClick: () => load(false) }, t("refresh")),
						h(
							"span",
							{ className: "urx-count" },
							state ? t.fmt("count", { n: rules.length, m: activeCount }) : t("loading")
						)
					),

					note
						? h(
								"div",
								{ className: note.kind === "ok" ? "urx-note urx-note-ok" : "urx-note urx-note-err" },
								note.text
						  )
						: null,

					error
						? h("div", { className: "urx-note urx-note-err" }, error)
						: null,

					// 新增行
					h(
						"div",
						{ className: "urx-compose" },
						h("div", { className: "urx-compose-label" }, t("addTitle")),
						h("input", {
							className: "urx-in urx-in-line",
							value: draftTitle,
							placeholder: t("titlePlaceholder"),
							maxLength: 120,
							onChange: (e) => setDraftTitle(e.target.value)
						}),
						h("textarea", {
							className: "urx-in",
							rows: 3,
							value: draftText,
							placeholder: t("placeholder"),
							onChange: (e) => setDraftText(e.target.value)
						}),
						h(
							"div",
							{ className: "urx-row" },
							h(
								"select",
								{
									className: "urx-in urx-in-auto",
									value: draftScope,
									onChange: (e) => setDraftScope(e.target.value)
								},
								h("option", { value: "global" }, t("scopeGlobal")),
								h("option", { value: "workspace", disabled: !lastCwd }, t("scopeWorkspace"))
							),
							!lastCwd ? h("span", { className: "urx-row-note" }, t("noWorkspace")) : null,
							h(
								"button",
								{
									className: "urx-btn urx-btn-primary",
									disabled: busy || draftText.trim().length === 0,
									onClick: addRule
								},
								t("add")
							)
						)
					),

					// 列表
					rules.length === 0
						? h(
								"div",
								{ className: "urx-empty" },
								h("div", { className: "urx-empty-title" }, t("emptyTitle")),
								h("div", { className: "urx-empty-hint" }, t("empty"))
						  )
						: h("ul", { className: "urx-list" }, rules.map(card)),

					// 页脚：帮助 / 路径 / 原始 JSON
					h(
						"div",
						{ className: "urx-foot" },
						h("div", { className: "urx-foot-row" }, h("span", null, t("help"))),
						h(
							"div",
							{ className: "urx-foot-row" },
							h("span", { className: "urx-foot-key" }, `${t("filePath")}:`),
							h("span", { className: "urx-code" }, (state && state.path) || "…")
						),
						h(
							"div",
							{ className: "urx-foot-row" },
							h(
								"button",
								{ className: "urx-btn urx-btn-icon", onClick: () => setShowRaw(!showRaw) },
								showRaw ? t("cancel") : "JSON"
							),
							// 清空是不可逆动作：语义写清楚（不是"确认删除"而是"清空全部"），
							// 放到页脚远离主操作路径，并且仍保留一次 window.confirm 二次确认。
							rules.length > 0
								? h(
										"button",
										{
											className: "urx-btn urx-btn-icon urx-btn-danger urx-spacer",
											disabled: busy,
											onClick: async () => {
												if (!window.confirm(`${t("clearAll")}：${t.fmt("count", { n: rules.length, m: activeCount })}`)) return;
												await run("clear", {}, t("saved"));
											}
										},
										t("clearAll")
								  )
								: null
						),
						showRaw && state
							? h("pre", { className: "urx-code urx-json" },
									JSON.stringify({ enabled: state.masterEnabled, rules: rules.map((r) => ({ id: r.id, title: r.title, text: r.text, enabled: r.enabled, scope: r.scope, workspacePath: r.workspacePath })) }, null, 2))
							: null
					)
				);
			}

			// ── 注册 ──────────────────────────────────────────────────────────
			function apply(ctx) {
				diag.applied = true;
				let disposeEntry = null;

				const tryRegister = (via) => {
					if (disposeEntry !== null) return true;
					try {
						const dispose = ctx.slots.register(
							{
								name: "settings.section",
								id: NS,
								order: 42,
								label: () => makeT(ctx)("title"),
								locale: NS,
								// 渲染器把 inject 当函数调用（runInject → inject(...args)），
								// 因此这里必须是工厂函数而不是对象字面量。
								inject: () => ({ __ctx: ctx })
							},
							UserRulesSection
						);
						disposeEntry = typeof dispose === "function" ? dispose : () => {};
						diag.registered = true;
						diag.registeredVia = `settings.section(${via})`;
						return true;
					} catch (e) {
						diag.lastError = `register(${via}): ${String((e && e.message) || e)}`;
						return false;
					}
				};

				if (tryRegister("direct")) {
					ctx.effect(() => () => {
						try {
							disposeEntry();
						} catch {
							/* 静默 */
						}
					}, "dsh-user-rules: section entry");
					return;
				}

				try {
					ctx.slots.inject("settings.section", () => {
						tryRegister("inject");
						return () => {
							try {
								if (disposeEntry) disposeEntry();
							} catch {
								/* 静默 */
							}
							disposeEntry = null;
						};
					});
				} catch (e) {
					diag.lastError = `inject: ${String((e && e.message) || e)}`;
				}
				setTimeout(() => tryRegister("retry-1.5s"), 1500);
				setTimeout(() => tryRegister("retry-6s"), 6000);
			}

			exports.apply = apply;
			exports.inject = ["slots"];
			// 诊断面：与 web-search 面板的 window.__webSearchPanel 同风格。
			// 组件也一并挂出，供离线渲染工装（visual-check.mjs）做像素级验收 ——
			// DSH Web UI 需要 launch token，无法靠"打开页面看一眼"来验收。
			diag.Component = UserRulesSection;
			exports.__diag = diag;
			exports.__component = UserRulesSection;
			if (typeof window !== "undefined") window.__dshUserRulesComponent = UserRulesSection;
		} catch (e) {
			diag.lastError = `factory: ${String((e && e.message) || e)}`;
			throw e;
		}
		return module.exports;
	}
});