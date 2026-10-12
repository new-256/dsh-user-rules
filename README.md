# dsh-user-rules · 用户规则注入器

把**你自己的长期规则**持久化到本地，并注入每一次模型请求的系统提示。
配好一次，之后所有会话都遵守 —— 不用每次开新会话重新交代一遍。

> 典型用法：「回答一律用中文」「改代码前先跑测试」「不要动 main 分支」
> 「提交信息用英文」「不确定就问我，不要猜」。

![管理面板](visual/panel-dark.png)

---

## 三个维护入口（同一份实现，同一份数据）

| 入口 | 位置 | 适合 |
|---|---|---|
| **图形管理页** | `设置 → 用户规则` | 日常增删改、排序、按工作区限定 |
| **斜杠命令** | 输入框打 `/rules` | 手快的时候；不进模型上下文，零 token |
| **模型工具** | `user_rules` | 直接对模型说「记住：以后都用中文回答」 |

三者调用宿主侧**同一个 `runAction`**，不存在两套逻辑。

管理页里还有一个**一键优化**面板：写需求 → 选模型 → 产出机器可读规则 → 你确认后批量应用
（含对现有规则的增 / 改 / 删比对）。详见[一键优化](#一键优化110)。

---

## 规则模型

每条规则：

| 字段 | 说明 |
|---|---|
| `text` | 规则正文（必填）。写成模型能直接照做的祈使句 |
| `title` | 短名，便于在列表里识别（可选） |
| `enabled` | 单条停用；停用后不注入、但保留 |
| `scope` | `global` 对所有会话生效；`workspace` 只在工作区路径匹配的会话生效 |
| `workspacePath` | `workspace` 作用域的基准路径（cwd 等于它或在其下即命中） |

另有**总开关**：关闭后所有规则都不注入（规则本身保留）。
插件配置里的 `enabled` 是更高一层开关，关掉等于整个插件静默。

**注入顺序 = 列表顺序。** 排在前面的先注入，越靠后可读性越好（也越"近"）。
所有规则注入在系统提示的**尾部区域**（默认 order `10150`，在 `WEB_SURFACE` 之后、
`DEPLOYMENT_PERSONA_SUFFIX` 之前）—— 模型对接近末尾的指令遵守度最高。

**零规则 = 零成本。** 没有生效规则时该 section 返回空串，会被提示装配整段丢弃，
不占用任何 token。

---

## 存储

默认写到 `$DSH_HOME/user-rules.json`（原子写：临时文件 + rename）。
可在插件行 config 里用 `file` 指定其他绝对路径。

```json
{
  "version": 1,
  "revision": 7,
  "enabled": true,
  "rules": [
    {
      "id": "0f2c…",
      "title": "语言",
      "text": "所有回答一律使用简体中文。",
      "enabled": true,
      "scope": "global",
      "workspacePath": "",
      "source": "ui",
      "createdAt": 1730000000000,
      "updatedAt": 1730000000000
    }
  ]
}
```

插件每 3 秒轮询文件 mtime：**手工编辑这个文件也会被自动拾取**，无需重启。

---

## `/rules` 命令

```
/rules                 列出全部规则
/rules add 文本        新增全局规则
/rules ws 文本         新增工作区规则（绑定当前会话的 cwd）
/rules on | off        总开关
/rules remove #2       按序号删除（也支持传规则 id）
/rules clear           清空全部规则
/rules 任意文本        兜底：整串当作一条新的全局规则
```

## `user_rules` 工具

`action` ∈ `list | add | update | remove | toggle | move | setEnabled | clear`。
`id` 既可传规则 id，也可传列表里的 1 基序号（`"2"` 或 `"#2"`）。
`clear` 是破坏性操作，提示词已明确要求先取得用户同意。

---

## Web 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/user-rules/state` | 读取完整快照（管理页数据源） |
| POST | `/user-rules/action` | 写入；**必须带 `X-DSH-User-Rules: 1` 头** |
| GET | `/user-rules/health` | 诊断：路径、规则数、注入统计、最近错误 |
| GET | `/user-rules/models` | 可选模型清单（供应商分组 + 当前默认模型），供一键优化的选择器用 |
| POST | `/user-rules/optimize` | 一键优化；**必须带 `X-DSH-User-Rules: 1` 头**，只返回提案、不写盘 |

写路径要求一个自定义请求头：跨站表单无法设置自定义头，浏览器预检也会被同源策略
挡下 —— 这是一个不破坏局域网访问（手机伴侣、远程 UI）的 CSRF 栅栏。

```bash
curl -X POST http://127.0.0.1:63309/user-rules/action \
  -H "Content-Type: application/json" -H "X-DSH-User-Rules: 1" \
  -d '{"action":"add","payload":{"text":"提交信息一律用英文。"}}'
```

---

## 一键优化（1.1.0）

自然语言的"想法"和模型能照做的"规则"之间差一层编译。这个面板干的就是这层编译：
你写需求 → 选一个模型 → 它产出规则 → **你确认 → 才写盘**。

流程分三段，**提案与应用之间是硬边界**：

| 阶段 | 做什么 | 是否落盘 |
|---|---|---|
| 读取 | `GET /user-rules/models` 拉可用模型，默认选中你当前的默认模型 | 否 |
| 优化 | `POST /user-rules/optimize`：现有规则（带 id）+ 你的需求 → 模型 → 提案 | **否** |
| 应用 | `POST /user-rules/action` `{action:"applyBatch", payload:{ops:[...]}}` | 是，一次 commit |

### 它按什么标准"编译"

提示词里把"机器可读"拆成六条**可判定**的标准，而不是笼统要求"写得整齐"：

1. 祈使句（"必须 / 一律 / 禁止 / 先…再…"），禁掉"建议 / 尽量 / 适当 / 注意"；
2. 单一职责：一条只约束一件事，含多个约束就拆条；
3. 可验证：能判断有没有被遵守，禁掉"保证代码质量"这类无法判定的表述；
4. 自足：脱离本次对话也能读懂，不出现"上面说的 / 这个项目"；
5. 有触发条件：写清在什么情况下适用；
6. 不冗余：需求已被覆盖就不要动 —— 否则模型每点一次就把规则库重写一遍。

模型对每条产出给出 `add` / `update` / `remove` 三种操作，并**必须原样抄写已有规则的 id**。
`update` / `remove` 会连带把原规则回传给前端，所以界面能直接做"改写前 → 改写后"的比对。

### 为什么提案可以逐条勾选、还能改

优化是**建议**，不是命令。所以：

- 每条提案独立勾选，默认勾选合法项；不合法项默认不勾且不可勾；
- `add` / `update` 的标题与正文在界面上**可编辑**，改完再应用；
- 每条都带模型给的理由（`reason`），便于判断该不该采纳；
- `update` / `remove` 显示原规则（划线置灰）与改写结果，一眼看出动了什么。

### 失败一律暴露，不做静默兜底

模型输出不可控，所以解析与校验都按"先暴露、再修复"设计：

- **JSON 取值三级且如实上报**：`raw`（干净）→ `fence`（被包在代码块里）→ `braces`（前后混了解释文字）。
  走了后两级时，界面明确提示"模型没完全遵守格式"。三级都不成才报错，
  **并把模型原始输出整段带回来**（可滚动、不截断），而不是丢一句"解析失败"。
- **`finish` 为 `error` / `aborted` 一律抛错**：这两种收尾下拼出来的文本必然不完整，
  拿去解析只会得到一个更难懂的语法错误。
- **被 `max-tokens` 截断明确报错**：绝不"尽量拼一条半成品规则"。
- **非法提案不丢弃**：照样返回、标红，并逐条列出具体原因（例如"找不到 id=xxx 的规则"）。
  悄悄删掉一条，用户会以为模型只生成了这些，从而漏看本该发现的错误。
- **批量应用全有或全无**：任一项不合法就整批拒绝，且**一个字都不写盘**。
  批量最怕"一半成功"——点一次按钮却得到半新半旧、自己也说不清的状态。
  同一个 id 上同时 `update` 与 `remove` 这类自相矛盾也会被拒。

### 直接调接口

```bash
# 看可用模型
curl http://127.0.0.1:63309/user-rules/models

# 优化（只出提案，不写盘）
curl -X POST http://127.0.0.1:63309/user-rules/optimize \
  -H "Content-Type: application/json" -H "X-DSH-User-Rules: 1" \
  -d '{"requirements":"回答一律用中文；改完代码必须跑测试","provider":"deepseek","model":"deepseek-chat"}'

# 确认后批量应用
curl -X POST http://127.0.0.1:63309/user-rules/action \
  -H "Content-Type: application/json" -H "X-DSH-User-Rules: 1" \
  -d '{"action":"applyBatch","payload":{"ops":[{"op":"add","title":"回答语言","text":"回答用户时必须一律使用简体中文。","scope":"global"}]}}'
```

---

## 配置（`cordis.patch.yml`）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 插件级总开关 |
| `sectionOrder` | `10150` | 注入位置，数值越大越靠后 |
| `maxRuleChars` | `4000` | 单条规则字符上限 |
| `maxTotalChars` | `20000` | 全部生效规则合计上限，超出按顺序截断并标注 |
| `manageTools` | `true` | 是否注册 `user_rules` 工具 |
| `manageCommand` | `true` | 是否注册 `/rules` 命令 |
| `httpRoutes` | `true` | 是否注册管理页所需的 HTTP 路由 |
| `optimize` | `true` | 是否开放「一键优化」（关闭后管理页不显示该面板） |
| `file` | `""` | 存储文件绝对路径；留空 = `$DSH_HOME/user-rules.json` |

---

## 安装

**方式一：插件页安装（推荐）**

`设置 → 插件` → 安装 bundle → 填包名 `dsh-user-rules`。
插件页会完成「装包 + 把本 bundle 挂进 profile」两件事。

**方式二：命令行**

```bash
dsh plugin --profile web add dsh-user-rules
```

该命令走 pnpm 装包；装完需确认本 bundle 已在 profile 的 `dsh.profile.bundles` 里启用
（插件页的安装动作会自动做这一步）。

**方式三：本地源码目录**（开发时用）

用插件页的「安装 bundle」直接指向本地目录，例如
`C:\Users\lcl\Desktop\DSH插件开发\dsh-user-rules`。

装完**刷新浏览器**，`设置 → 用户规则` 即出现。

> 本插件零运行时依赖。宿主半不 import 任何 `@deepseek-ai/*`，客户端半只从浏览器模块表取 React。

---

## 依赖纪律

- 宿主半**不 import 任何 `@deepseek-ai/*`**（插件装在用户目录下，Node 解析不到 harness 的包）。
  可选 `schemastery` 经 `createRequire` 从主进程脚本位置解析，失败则 `Config` 不导出，插件照常工作。
- `tools` / `systemPrompt` 是硬依赖（写进 `inject`）；`commands` / `webServer` 走 `ctx.inject` 可选注入，
  缺了不影响插件激活，只是少了对应的入口。
- 客户端半只 `inject: ["slots"]`，不 import 任何 Harness 客户端包，React 从浏览器模块表
  `require("react")`；样式只用 `--dsw-alias-*` 主题令牌，亮/暗主题自动跟随。

## 界面样式纪律（踩过的坑，改样式前先读）

DSH 的 Web UI 需要 launch token 才能打开，无法靠"打开页面看一眼"来验收，因此本仓库自带
两套可重复执行的可视化验收工装（见下节）。写样式时必须遵守：

| 用途 | 用这个令牌 | 不要用 | 原因 |
| --- | --- | --- | --- |
| 卡片 / 面板底色 | `--dsw-alias-settings-card-fill` | `--dsw-alias-bg-layer-1/2/3` | 浅色下 `bg-base`、`bg-layer-1/2/3` **解析成同一个颜色**，卡片会彻底消失，只剩 4% 透明度的描边 |
| 卡片描边 | `--dsw-alias-settings-card-stroke` | `--dsw-alias-border-l1` | `border-l1` 只有 4% 透明度，浅色下几乎不可见 |
| 输入框底色 | `--dsw-specific-input-major` | `--dsw-alias-bg-base` | 深色下 `bg-base` 与卡片同色，输入框会"消失" |
| 悬停底色 | `--dsw-alias-interactive-bg-hover` | 自造 `rgba()` | 自造色不跟随主题 |
| 主按钮 | `--dsw-alias-button-primary-fill` + `--dsw-alias-label-primary-inverted` | `--dsw-alias-brand-primary` | `brand-primary` 浅色下是近黑色，当填充会得到纯黑按钮 |
| 圆角 | `--dsw-radius-sm/md` | 写死 `7px` / `9px` | 与 Harness 自身控件不齐 |

另有一条布局陷阱：**不要在 `.urx-tag` 里再套一层 `overflow:hidden` 的 `span`。**
内层 `span` 作为 flex 子项，`overflow:hidden` 会把它的 `min-width:auto` 变成 `0`，
于是被外层 flex 挤成零宽 —— 标签只剩一个小横杠、文字整个消失。省略号直接做在标签自身上。

还有一条：**折叠判定必须量真实溢出，不能按字符数猜。**
早先的规则是 `text.length > 160`，结果 142 字那条渲染出 6 行却完整铺开、206 字那条
却被截成 4 行 —— 同等长度的规则表现不一致，一眼就能看出来。现在改成：先乐观地加折叠类，
量 `scrollHeight > clientHeight` 才认定"可展开"，量出没溢出就彻底去掉折叠类
（见组件里的 `clampable` 状态与 `useLayoutEffect`，另监听 resize 重新测量）。

第三条，也是最显眼的一条：**操作按钮不要做成卡片右侧的独立一列。**
早先卡片是 `[勾选框][正文区][按钮列]` 三列横排，按钮列会永久吃掉卡片右侧的宽度，
于是正文右边永远空出一整条、按钮下方一大块留白 —— 用户原话就是
"详细规则显示时右侧短了一截"。现在按钮并入标题行、靠右（`.urx-actions` 用
`margin-left:auto`），正文作为同一列的兄弟节点**独占整行**。

验收里为此加了量化红线：`textRatio = 正文宽度 / 卡片宽度` **不得低于 0.85**。
修复前实测 0.75（会直接判失败），修复后 0.916（窄栏 0.879）。这类"看着还行"的
问题肉眼容易放过，用比值卡死才拦得住。

第四条：**多行文本域要按内容自动增高，不要只给 `min-height`。**
一键优化的提案编辑框最初写死 `min-height: 56px`，一条两行的规则只露出两行半，
剩下半行被切在中间 —— 截图上一眼就像渲染坏了。现在带 `data-urx-autogrow` 的文本域
在 `useLayoutEffect` 里量 `scrollHeight` 后显式设高（并按 `border-box` 补回
`offsetHeight - clientHeight` 的边框，否则永远差 2px 出滚动条）。
验收红线是 `propClip = 内部有滚动的提案文本域个数` 必须为 0。

## 验收必须覆盖"活动皮肤"

**这是最容易自欺的一点**：真实环境几乎不会跑在裸主题上。本机启用了 `whale-song` 皮肤，
它覆盖了 **176 条令牌** —— `--dsw-alias-brand-primary` 从中性近黑/近白变成 **#4d8fd4 蓝**，
卡片改成半透明 `rgba()`，主按钮填充跟着变蓝。

只加载基础主题的话，截图上的主按钮会是近白色、卡片不透明，**和用户看到的完全不是一回事**。
所以 `visual-check.mjs` 会读取 `skin-center-active.json` → `skins/<name>/skin.json`，
把皮肤的 `stylesheet` + `patches` 一并注入，并复刻真实层级：

1. 底层：皮肤壁纸（`backgroundMedia.src`）+ 该主题的 `scrim` 渐变；
2. `--dsw-skin-scrim` 取自皮肤中心的 `backgroundOpacity`（本例 45 → 0.45）；
3. `body` 透明，面板自己那层 `--dsw-alias-bg-base` 是半透明的，叠在壁纸上才是真机观感。

皮肤 CSS 里的相对 `url(...)` 会被改写成绝对 `file://`，否则素材加载不到。
令牌预检因此成了一条真实回归防线（当前基线 `btn=rgb(47, 111, 184)`）。

## 视觉与一致性验收

```bash
npm run verify          # 一次性跑完下面三套
node smoke-test.mjs     # 宿主侧回归：49 项基础 + 26 项一键优化
node visual-check.mjs   # 真实 React + 应用真实主题令牌 + 无头 Chrome 截图
node css-audit.mjs      # 类名一致性：死 CSS / 漏样式
```

`visual-check.mjs` 不依赖浏览器桥，也不依赖 DSH Web 的登录态：它直接加载 `lib/client.js`
里**同一份组件代码**，注入从 `dsh-client-ui-theme` 内嵌字符串**全量还原的真实主题 CSS**
（8 个样式表：base / design-platform / focus / scrollbar / gradient…，浅色 + 深色全套令牌）
**叠加当前活动皮肤**，用真实 React 18 渲染后由 Chrome 出图，
产出 `visual/panel-{light,dark,narrow,empty,optimize,optimize-dark}.png` 六张验收图。
快照内置了用户真实的 4 条规则，截图可与真机截图逐条对照。
（早期只抽 4 条令牌块，导致 `settings-card-fill` 等别名在工装里解析失败 → 底色透明、
对比度断言失真 —— 全量还原后这条坑被连根拔掉，还原器遇到未知转义会直接抛错。）

`optimize` / `optimize-dark` 两个任务会**真的驱动一次优化**：往需求框里写入文本
（走原生 setter + `input` 事件，否则 React 受控组件不会触发 `onChange`）、点「一键优化」、
**再把模型下拉点开**，等提案和展开的菜单都渲染出来才截图 —— 只截静态空面板看不出
徽标配色、无效项标红、编辑框裁切这些问题；只截收起态也看不出菜单项可读性。

工装自带四条防"假绿"的硬校验，任何一条不通过就直接失败：

1. **令牌预检**：`--dsw-alias-bg-base` 必须能解析出真实颜色。抽错 CSS 时截图会是一张白图，
   但流程仍然"成功"—— 这个陷阱实测踩过（正则抓 JS 长字符串抓到的是源码，令牌一个没解析）。
2. **布局断言**：读取页面自报的 `scrollWidth/clientWidth`、卡片宽度、标签宽度；
   溢出（`scrollWidth > clientWidth`）、有标签被挤到零宽、或 `textRatio < 0.85`
   （正文右边空出一条）都算失败。
3. **类名一致性**：`css-audit.mjs` 保证没有"用了但没定义"的类。
4. **优化面板断言**（仅 `optimize*` 任务）：模型选择器至少 2 项、提案卡片至少 3 张、
   三种操作徽标（`urx-op-add/update/remove`）**都出现且背景/前景都解析成非透明色**
   （只查 DOM 存在性会漏掉"节点在、样式没生效"）、无提案卡片横向溢出、
   `propClip === 0`、无效项必须给出具体原因文字。
5. **菜单可读性断言**（仅 `optimize*` 任务，菜单已由驱动点开）：选项文字色与
   「菜单填充（含 `background-image` 分层）→ 面板底色 → 页面底色」逐层 alpha 合成后的
   实际底色做 WCAG 对比度计算，**必须 ≥ 4.5**。当年原生 `<select>` 弹出层就是死在这里
   （近白字弹在白底上 ≈1.6:1，真机截图验证过）；自绘菜单后亮/暗主题实测 18.9 / 10.44。
   收起态还必须带「供应商 · 模型名」前缀（`optLabelOk`）—— 同一模型 id 常在不同供应商
   重复，看不出"哪家的"就会选错。
6. **内联脚本语法校验**：harness 的 `<script>` 是模板字符串拼出来的，`node --check`
   查不到它们 —— 一条坏正则（模板里 `\d` 会丢反斜杠变 `d`）就能让整个脚本块静默失效，
   页面连 title 都不设。构建期对每个脚本块跑一次 `new Function()` 解析，当场炸出来。

### `css-audit.mjs` 为什么要手写词法扫描

最初的实现只匹配 `className: "..."` 这种单行字面量，于是下面这些**真实存在**的用法
全被误判成死 CSS，一条本来正确的红线被自己噪掉：

```js
className: isConfirming ? "urx-btn urx-btn-armed" : "urx-btn"   // 跨行三元
className: `urx-prop${p.valid ? "" : " urx-prop-bad"}`           // 模板拼接
className: `urx-op urx-op-${p.op}`                              // 动态后缀
```

现在改成手写一个极小的词法扫描：只在**字符串 / 模板字面量**里取材（注释与各选择器自然
被排除，且必须先剔除 CSS 块本身，否则选择器会被当成"用到了"，死 CSS 永远查不出来）；
模板的 `${...}` 当代码递归进入，静态部分留下的**前缀族**（形如 `urx-op-`）单独列出来，
而不是悄悄算作已用 —— 否则一个真正没人用的变体会被永久掩盖。
另外要显式跳过 `key: "..."`：React 的 key 不是样式类，`{ key: "urx-style" }` 会被当成
"漏样式"，把一个正确的检查逼成噪声。

验收还发现过一个工装自身的假象：Chrome 无头模式有最小内容宽度（实测 512px），
`--window-size=400` 只会把图裁窄、布局其实仍是 512px 宽 —— 那时看到的"溢出"是裁剪，
不是插件缺陷。所以窄栏用 520px。

## 已知边界

- 规则注入**不追溯**：本会话里已经发生过的对话不会因为新规则而重新解释，
  新规则从**下一次模型请求**开始生效。
- `workspace` 作用域以会话的 `cwd` 判断，不是「文件属于哪个 git 仓库」，
  所以同一个仓库的不同子目录会各自命中不同规则。
- 规则是明文存在磁盘上的：**不要往里写密钥**。