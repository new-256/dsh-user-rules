/**
 * 视觉验收工装：把 client.js 的真实组件放进无头 Chrome 渲染并截图。
 *
 * 为什么需要它：DSH Web UI 需要 launch token 才可访问，browser 桥未连接，
 * 所以不能靠"打开页面看一眼"来验收。这里改用等价路线 ——
 *   1. 直接加载 client.js 里同一份组件代码（用 __ModuleLoader__ 桩件捕获）；
 *   2. 引入 DSH 应用真实的主题 CSS（--dsw-* 令牌的权威定义）；
 *   3. 用真实 React 18 + react-dom 渲染，Chrome 截图。
 * 这样得到的像素就是组件在真实令牌下的像素。
 *
 * 运行：node visual-check.mjs
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RENDER_ENV = join(tmpdir(), 'urx-render')
const OUT = join(HERE, 'visual')
mkdirSync(OUT, { recursive: true })

const REACT = join(RENDER_ENV, 'node_modules', 'react', 'umd', 'react.production.min.js')
const REACT_DOM = join(RENDER_ENV, 'node_modules', 'react-dom', 'umd', 'react-dom.production.min.js')
const THEME = join(
  process.env.APPDATA || '',
  'DSH Desktop',
  'backend',
  'dsh',
  'node_modules',
  '@deepseek-ai',
  'dsh-client-ui-theme',
  'lib',
  'client.js'
)

// 主题包把 CSS 内联在 JS 字符串里，且字符串里还混着大段 JS 源码。
// 正则抓"长字符串"会抓错（验证过：抓出来的是 JS 源码，令牌一个都没解析），
// 所以改用「从已知选择器开始做花括号配平」精确切出四个样式块：
//   浅色静态色 / 深色静态色 / 浅色别名 / 深色别名
// 静态色块不能省 —— --dsw-alias-* 大量是 var(--dsw-static-*)，缺了就没颜色。
const themeSrc = readFileSync(THEME, 'utf8')

/** 从 start 处的选择器开始，按花括号配平切出完整规则块。 */
function cssBlockAt(src, start) {
  let depth = 0
  for (let i = start; i < src.length; i += 1) {
    const ch = src[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  return null
}

const NEEDED = [
  'body{--dsw-static-',
  'body[data-ds-dark-theme]{--dsw-static-',
  'body{--dsw-alias-bg-base',
  'body[data-ds-dark-theme]{--dsw-alias-bg-base',
]
const themeCss = NEEDED.map((sel) => {
  const idx = themeSrc.indexOf(sel)
  if (idx < 0) throw new Error(`主题包中找不到样式块起点：${sel}`)
  const block = cssBlockAt(themeSrc, idx)
  if (!block) throw new Error(`样式块花括号不配平：${sel}`)
  return block
}).join('\n')

// 硬校验：四个块必须齐全，否则渲染出来的颜色是假的。
for (const probe of [
  'body{--dsw-alias-bg-base',
  'body[data-ds-dark-theme]{--dsw-alias-bg-base',
  '--dsw-static-neutral-bluish-00',
]) {
  if (!themeCss.includes(probe)) {
    throw new Error(`抽出的主题样式表缺少 ${probe}（长度 ${themeCss.length}）`)
  }
}
// 再校验一条真实令牌能解析出颜色：别名必须引用到静态色。
if (!/--dsw-alias-bg-base:var\(--dsw-static-/.test(themeCss)) {
  throw new Error('抽出的样式表中 --dsw-alias-bg-base 未指向静态色，令牌链断裂')
}
console.log(`主题样式表：${themeCss.length} 字符，4 个样式块齐全，令牌链完整`)

// ── 活动皮肤 ────────────────────────────────────────────────────────────
// 真实环境几乎不会跑在裸主题上：本例用户启用了 whale-song 皮肤，它覆盖了
// 176 条令牌（brand-primary 从中性近黑/近白改成 #4d8fd4 蓝、卡片改成半透明…）。
// 不加载皮肤，截图上的主按钮颜色、卡片通透度就和用户看到的完全不是一回事 ——
// 那种"视觉验收"等于自欺，所以这里把皮肤一并算进来。
const DSH_HOME = join(process.env.APPDATA || '', 'DSH Desktop', 'dsh-home')
let skinCss = ''
let skinMedia = null
let skinDir = ''
let skinName = ''
try {
  const active = JSON.parse(readFileSync(join(DSH_HOME, 'skin-center-active.json'), 'utf8'))
  skinName = active && active.active ? String(active.active) : ''
  if (skinName) {
    skinDir = join(DSH_HOME, 'skins', skinName)
    const manifest = JSON.parse(readFileSync(join(skinDir, 'skin.json'), 'utf8'))
    const contrib = manifest.contributes || {}
    const sheets = [contrib.stylesheet, contrib.patches].filter(Boolean)
    for (const rel of sheets) {
      let text = readFileSync(join(skinDir, rel), 'utf8')
      // 皮肤 CSS 里的相对 url(...) 在独立页面里解析不到，改写成绝对 file://
      text = text.replace(
        /url\(\s*(['"]?)(?!data:|https?:|file:|\/)([^'")]+)\1\s*\)/g,
        (_m, _q, u) => `url("file:///${join(skinDir, u).replace(/\\/g, '/')}")`
      )
      skinCss += `\n/* ${rel} */\n${text}`
    }
    skinMedia = contrib.backgroundMedia || null
    // 遮罩强度来自皮肤中心的背景设置（backgroundOpacity 45 → 0.45）
    const scrim = Number(active?.background?.backgroundOpacity)
    const scrimValue = Number.isFinite(scrim) ? scrim / 100 : 0.45
    skinCss = `:root{--dsw-skin-scrim:${scrimValue}}\n` + skinCss
    console.log(
      `皮肤：${skinName}（${sheets.length} 个样式表，遮罩=${scrimValue}，壁纸=${
        skinMedia && (skinMedia.dark || skinMedia.light) ? '有' : '无'
      }）`
    )
  }
} catch (e) {
  throw new Error(`皮肤加载失败，截图将与真实环境不符：${e.message}`)
}
if (!skinCss.includes('--dsw-skin-scrim:')) {
  throw new Error('皮肤样式里缺少 --dsw-skin-scrim，半透明令牌会算错')
}

const clientSrc = readFileSync(join(HERE, 'lib', 'client.js'), 'utf8')

// 让 __ModuleLoader__.load 把导出交给我们，而不是真的挂进页面。
const clientWrapped = `
window.__captured = null;
window.__ModuleLoader__ = {
  load(def) {
    const mod = def.factory((id) => {
      if (id === 'react') return window.React;
      throw new Error('unexpected require: ' + id);
    });
    window.__captured = mod;
  }
};
${clientSrc}
`

const HARNESS = (dark) => {
  const media = skinMedia ? (dark ? skinMedia.dark : skinMedia.light) || skinMedia.dark : null
  const art = media && media.src ? `url("file:///${join(skinDir, media.src).replace(/\\/g, '/')}")` : ''
  const layers = [media && media.scrim, art].filter(Boolean).join(', ')
  const fallback = dark ? '#081a40' : '#d0e8f8'
  return `<!doctype html>
<html lang="zh"><head><meta charset="utf-8">
<style>${themeCss}</style>
<style>${skinCss}</style>
<style>
  /* 复刻真实层级：壁纸 + 皮肤遮罩在最底层，body 透明，
     面板自己那层 --dsw-alias-bg-base 是半透明的（皮肤把卡片做成了 rgba），
     必须叠在壁纸上才能得到和真机一致的观感。 */
  html { margin: 0; padding: 0; min-height: 100%;
         background-color: ${fallback};
         ${layers ? `background-image: ${layers};` : ''}
         background-size: cover; background-position: center; background-attachment: fixed;
         background-repeat: no-repeat; }
  body { margin: 0; padding: 0; background: transparent; min-height: 100vh; }
  /* 宽度跟随视口：写死宽度会让窄栏验收变成假的（内容溢出被裁掉，
     看起来像插件崩了，其实是工装的锅）。 */
  #stage { width: 100%; min-height: 100vh; padding: 20px 22px; box-sizing: border-box;
           background: var(--dsw-alias-bg-base); font-family: system-ui, "Microsoft YaHei", sans-serif; }
  *, *::before, *::after { box-sizing: border-box; }
</style>
</head>
<body ${dark ? 'data-ds-dark-theme' : ''}>
<div id="stage"></div>
<script src="file:///${REACT.replace(/\\/g, '/')}"></script>
<script src="file:///${REACT_DOM.replace(/\\/g, '/')}"></script>
<script>${clientWrapped}</script>
<script>
(function () {
  // 桩掉 fetch：返回固定快照，让组件渲染出完整状态而非空列表。
  const SNAPSHOT = window.__SNAPSHOT__;
  window.fetch = function (url) {
    const isState = String(url).indexOf('/state') >= 0;
    return Promise.resolve({
      ok: true,
      status: 200,
      json: function () {
        return Promise.resolve(isState ? SNAPSHOT : { ok: true, state: SNAPSHOT });
      }
    });
  };
  const mod = window.__captured;
  const errors = [];
  const fakeCtx = {
    get: function () { return undefined; },
    effect: function () { return function () {}; },
    slots: { register: function () { return function () {}; }, inject: function () {} },
    locale: undefined
  };
  try {
    mod.apply(fakeCtx);
  } catch (e) { errors.push('apply: ' + e.message); }
  const Comp = mod.__component || window.__dshUserRulesComponent;
  if (!Comp) { errors.push('未捕获到组件'); }
  else {
    try {
      window.ReactDOM.createRoot(document.getElementById('stage'))
        .render(window.React.createElement(Comp, { __ctx: fakeCtx }));
    } catch (e) { errors.push('render: ' + e.message); }
  }
  setTimeout(function () {
    if (errors.length) { document.title = 'ERRORS: ' + errors.join(' | '); return; }
    // 量化验收：把关键布局尺寸报出来，避免"看起来还行"这种主观判断。
    // 溢出（scrollWidth > clientWidth）一律算失败。
    var stage = document.getElementById('stage');
    var root = document.querySelector('.urx-root');
    var card = document.querySelector('.urx-card');
    var text = document.querySelector('.urx-text');
    var btn = document.querySelector('.urx-btn');
    var foot = document.querySelector('.urx-code');
    var tags = Array.prototype.slice.call(document.querySelectorAll('.urx-tag'));
    // 标签必须真的显示出文字：曾经因为内层 span 被挤成零宽，
    // 标签只剩一个小横杠，截图看上去"没报错"但信息全丢了。
    var badTag = tags.filter(function (el) {
      return el.getBoundingClientRect().width < 24 || el.textContent.trim().length === 0;
    }).length;
    var parts = {
      stage: stage.clientWidth,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      rootW: root ? Math.round(root.getBoundingClientRect().width) : -1,
      cardW: card ? Math.round(card.getBoundingClientRect().width) : -1,
      textW: text ? Math.round(text.getBoundingClientRect().width) : -1,
      // 正文必须几乎占满卡片宽度。早先把操作按钮做成卡片右侧独立一列，
      // 正文被永久压缩、右边空出一整条（用户原话："详细规则显示时右侧短了一截"）。
      // 比值低于 0.85 说明右侧又出现了空白条，直接判失败。
      textRatio: card && text ? +(text.getBoundingClientRect().width / card.getBoundingClientRect().width).toFixed(3) : -1,
      btnH: btn ? Math.round(btn.getBoundingClientRect().height) : -1,
      tags: tags.length,
      badTag: badTag,
      footOverflow: foot ? (foot.scrollWidth > foot.clientWidth + 1) : null,
      fontPx: getComputedStyle(document.body).fontSize
    };
    var overflow = parts.scrollW > parts.clientW + 1;
    var narrowText = parts.textRatio > 0 && parts.textRatio < 0.85;
    var bad = overflow || parts.badTag > 0 || narrowText;
    document.title = (bad ? 'LAYOUT_BAD ' : 'LAYOUT_OK ') +
      Object.keys(parts).map(function (k) { return k + '=' + parts[k]; }).join(' ');
  }, 600);
})();
</script>
</body></html>`
}

const SNAPSHOT = {
  ok: true,
  enabled: true,
  pluginEnabled: true,
  masterEnabled: true,
  revision: 7,
  path: 'C:\\Users\\lcl\\AppData\\Roaming\\DSH Desktop\\dsh-home\\user-rules.json',
  sectionOrder: 10050,
  maxRuleChars: 4000,
  maxTotalChars: 20000,
  lastCwd: 'C:\\Users\\lcl\\Desktop\\DSH插件开发',
  stats: { loads: 1, saves: 6, injected: 2, lastInjectAt: '2026-10-12T00:44:56.607Z', lastInjectChars: 686 },
  lastError: null,
  // 用用户真实的那 4 条规则做快照 —— 这样截图可以和真机截图逐条对照。
  rules: [
    {
      id: '35fe2a34-b1d6-4806-aed5-ee69bc28b321',
      title: '🛠️ 研发策略与环境规范',
      text: '• 开发阶段严禁降级：在项目未完全开发完成前，严禁引入任何自动降级或容错兜底方案。必须让真实缺陷第一时间暴露，避免干扰对系统真实状态的判断。\n• 环境部署内置优先：所有项目依赖与运行环境必须优先采用内置或容器化封装方案。在架构设计时，需将“用户开箱即用、便捷部署”作为最高优先级考量。',
      enabled: true,
      scope: 'global',
      workspacePath: '',
      source: 'ui',
      createdAt: 1791765717756,
      updatedAt: 1791765824135,
      index: 1,
      chars: 142
    },
    {
      id: '1ddb7612-0afb-4436-ad33-1b099344144c',
      title: '💻 算力资源与模型选型规范',
      text: '• 硬件资源全程监控：项目测试与运行期间，必须时刻监控并记录电脑资源占用情况（CPU、GPU、内存、显存等）。\n• 显卡算力绝对优先：系统必须优先调度 GPU 资源。严禁在具备显卡硬件且有对应 GPU 加速方案的情况下，私自降级为 CPU 运行。\n• 模型选型算力平衡：引入本地模型时，必须严格考量目标设备的本地算力边界。选型前须在算力消耗与精度之间取得最佳平衡，非特殊业务必要，严禁选用 FP32 全精度模型。',
      enabled: true,
      scope: 'global',
      workspacePath: '',
      source: 'ui',
      createdAt: 1791765751049,
      updatedAt: 1791765751049,
      index: 2,
      chars: 206
    },
    {
      id: 'ef163280-92b0-43fa-bcfc-c97cde77c9d0',
      title: '🤝 团队协作与效能飞跃规范',
      text: '• 多智能体与子代理机制：在条件允许时，必须积极启用子代理（Sub-agent）架构或自动化流水线。通过任务拆解与多智能体协同，提升项目一次通过率。\n• 团队高效协作机制：建立清晰的团队协作、代码评审与信息同步机制，利用工具和标准流程消除沟通壁垒，最大化提升协同效率。',
      enabled: true,
      scope: 'global',
      workspacePath: '',
      source: 'ui',
      createdAt: 1791765765608,
      updatedAt: 1791765765608,
      index: 3,
      chars: 134
    },
    {
      id: '290f7cf7-7f6b-4ad8-b67f-e4d4ce004a92',
      title: '🔍 质量控制与异常处理',
      text: '• 异常问题零延迟修正：项目运行中出现的任何系统警告（Warning）和错误（Error），必须立刻定位并修正，严禁积压或拖沓。\n• 双重视觉审查交付：凡涉及视觉输出的系统，在交付前必须通过严格的视觉效果检查与量化评估。未完成视觉验收的产品一律不得交付。',
      enabled: true,
      scope: 'global',
      workspacePath: '',
      source: 'ui',
      createdAt: 1791765781530,
      updatedAt: 1791765781530,
      index: 4,
      chars: 127
    }
  ]
}

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => {
  try {
    readFileSync(p)
    return true
  } catch {
    return false
  }
})
if (!CHROME) throw new Error('未找到 Chrome')

const jobs = [
  { name: 'light', dark: false, width: 740 },
  { name: 'dark', dark: true, width: 740 },
  // 窄栏：设置面板常被压窄，这里专门验收换行与长文本处理。
  // 注意 Chrome 有最小内容宽度（实测 512px），写更小只会在截图里被裁掉，
  // 布局其实没变 —— 那时看到的"溢出"是工装假象，不是插件缺陷。
  { name: 'narrow', dark: false, width: 520 },
  // 空态：零规则时必须仍然是"有设计的样子"，不能是一块空白。
  { name: 'empty', dark: false, width: 740, snapshot: { ...SNAPSHOT, rules: [] } },
]

for (const job of jobs) {
  const html = HARNESS(job.dark).replace(
    '<script>' + clientWrapped + '</script>',
    '<script>window.__SNAPSHOT__=' + JSON.stringify(job.snapshot || SNAPSHOT) + ';</script>\n<script>' + clientWrapped + '</script>'
  )
  const page = join(OUT, `harness-${job.name}.html`)
  writeFileSync(page, html, 'utf8')
  const shot = join(OUT, `panel-${job.name}.png`)
  // 独立的 user-data-dir：否则第二次启动会挂到已在运行的 Chrome 实例上，
  // 截出来的图会是上一张（light/dark 出现相同字节）。
  // 放临时目录而不是产物目录 —— Chrome 配置目录体积大且是垃圾，不该混进交付物。
  const profile = join(tmpdir(), `urx-chrome-${job.name}`)
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--user-data-dir=' + profile,
    '--hide-scrollbars',
    '--force-device-scale-factor=2',
    '--window-size=' + (job.width || 740) + ',1500',
    '--virtual-time-budget=6000',
    '--screenshot=' + shot,
    'file:///' + page.replace(/\\/g, '/'),
  ]
  try {
    execFileSync(CHROME, args, { stdio: 'pipe', timeout: 60000 })
    console.log(`✅ ${job.name} 截图 → ${shot}`)
  } catch (e) {
    console.log(`❌ ${job.name}: ${e.message}`)
    continue
  }

  // 量化验收：读取页面自报的布局尺寸，溢出即失败。
  // 只看截图会漏掉"内容被裁掉但流程仍然成功"这类静默失败。
  const dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + join(tmpdir(), `urx-chrome-m-${job.name}`),
    '--window-size=' + (job.width || 740) + ',1500',
    '--virtual-time-budget=6000', '--dump-dom',
    'file:///' + page.replace(/\\/g, '/'),
  ], { encoding: 'utf8', timeout: 60000 })
  const title = (dom.match(/<title>([^<]*)<\/title>/) || [])[1] || '(no title)'
  if (title.startsWith('ERRORS')) {
    throw new Error(`${job.name} 渲染报错：${title}`)
  }
  if (!title.startsWith('LAYOUT_OK')) {
    throw new Error(`${job.name} 布局溢出：${title}`)
  }
  console.log(`   ${title}`)
}

// ── 预检：确认令牌真的解析成了颜色 ─────────────────────────────────────
// 这一步是为了防"空白截图"这类静默失败：只要 --dsw-alias-bg-base 解析不出
// 颜色，截图会是一张白图，但流程仍然报成功。这里把它变成硬失败。
{
  const probe = `<!doctype html><html><head><meta charset="utf-8"><style>${themeCss}</style><style>${skinCss}</style>
<style>#a{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
#b{background:var(--dsw-alias-button-primary-fill)}</style></head>
<body data-ds-dark-theme><div id="a">x</div><div id="b">y</div>
<script>
const g=(id,p)=>getComputedStyle(document.getElementById(id)).getPropertyValue(p);
const bg=g('a','background-color'), fg=g('a','color'), btn=g('b','background-color');
const ok = bg && bg!=='rgba(0, 0, 0, 0)' && fg && fg!=='rgba(0, 0, 0, 0)' && btn && btn!=='rgba(0, 0, 0, 0)';
document.title = (ok?'TOKENS_OK':'TOKENS_BROKEN')+' bg='+bg+' fg='+fg+' btn='+btn;
</script></body></html>`
  const p = join(OUT, 'token-probe.html')
  writeFileSync(p, probe, 'utf8')
  const dom = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run',
    '--user-data-dir=' + join(tmpdir(), 'urx-chrome-probe'),
    '--virtual-time-budget=3000', '--dump-dom',
    'file:///' + p.replace(/\\/g, '/'),
  ], { encoding: 'utf8', timeout: 60000 })
  const title = (dom.match(/<title>([^<]*)<\/title>/) || [])[1] || ''
  if (!title.startsWith('TOKENS_OK')) {
    throw new Error(`主题令牌未解析出颜色，截图不可信：${title}`)
  }
  console.log(`✅ 令牌预检通过（${title.replace('TOKENS_OK ', '')}）`)
}