/**
 * Dev-only preview: load the browser bundle with a stub React that serialises
 * to HTML, lay the note on a dark DSH-like header grid, and write preview.html.
 * Not shipped, not part of the plugin's runtime.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'lib', 'client.js')
const outPath = path.join(here, `preview-${process.env.PREVIEW_MODE ?? 'open'}.html`)

let captured = null
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { captured = definition } },
  localStorage: {
    getItem: () => (process.env.PREVIEW_MODE === 'closed' ? '0' : '1'),
    setItem: () => {},
  },
}

const source = fs.readFileSync(bundlePath, 'utf8')
new Function('window', source)(globalThis.window)

const UNITLESS = new Set([
  'opacity', 'flex', 'flexGrow', 'flexShrink', 'order', 'zIndex', 'fontWeight',
  'lineHeight', 'gridColumn', 'gridRow', 'lineClamp', 'aspectRatio',
])

const kebab = (name) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

function styleToCss(style) {
  return Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      const cssKey = key.startsWith('--') ? key : kebab(key)
      const cssValue = typeof value === 'number' && !UNITLESS.has(key) ? `${value}px` : value
      return `${cssKey}:${cssValue}`
    })
    .join(';')
}

const VOID = new Set(['img', 'br', 'input', 'hr', 'meta', 'link', 'circle', 'rect', 'path', 'line'])

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function serialize(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return escapeHtml(node)
  if (Array.isArray(node)) return node.map(serialize).join('')

  const { type, props = {}, children = [] } = node
  if (typeof type === 'function') {
    return serialize(type(props))
  }

  const attrs = []
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'key' || value === undefined || value === null || value === false) continue
    if (key === 'style') {
      attrs.push(`style="${styleToCss(value)}"`)
    } else if (key === 'className') {
      attrs.push(`class="${escapeHtml(value)}"`)
    } else if (typeof value === 'boolean') {
      if (value) attrs.push(key)
    } else {
      // viewBox is the one SVG attribute that must keep its camelCase name.
      attrs.push(`${key === 'viewBox' ? 'viewBox' : kebab(key)}="${escapeHtml(value)}"`)
    }
  }

  const open = `<${type}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  if (VOID.has(type)) return open
  return `${open}${serialize(children)}</${type}>`
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
  Component: class {
    constructor(props) {
      this.props = props
      this.state = {}
    }

    setState(next) {
      this.state = { ...this.state, ...next }
    }
  },
}

const mod = captured.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})

const view = process.env.VIEW_JSON
  ? JSON.parse(fs.readFileSync(process.env.VIEW_JSON, 'utf8'))
  : {

  turn: 12,
  main: {
    id: 'g3',
    label: '目标日志：便签本样式，挪到会话顶部',
    progress: '重做了便签的纸面样式，位置从输入框上方挪到会话标题下面那一栏，收起态只留一条纸条',
    firstTurn: 6,
    turns: 4,
    lastTurn: 12,
  },
  first: { label: '做一个能看的主线 + 偏离提醒', firstTurn: 1 },
  tasks: [
    {
      id: 'g1',
      label: '做一个能看的主线 + 偏离提醒',
      progress: '先把主线、偏离计数跑通',
      relation: 'root',
      parentId: null,
      firstTurn: 1,
      turns: 3,
      lastTurn: 3,
      active: false,
      children: [
        {
          id: 'g2',
          label: '关系判定改成锚点重叠',
          progress: '锚点层写完，显式切换词优先',
          relation: 'refine',
          parentId: 'g1',
          firstTurn: 4,
          turns: 2,
          lastTurn: 5,
          active: false,
          children: [
            {
              id: 'g3',
              label: '目标日志：便签本样式，挪到会话顶部',
              progress: '重做了便签的纸面样式，位置挪到标题下面',
              relation: 'refine',
              parentId: 'g2',
              firstTurn: 6,
              turns: 4,
              lastTurn: 12,
              active: true,
              children: [],
            },
          ],
        },
        {
          id: 'g4',
          label: '飞书那套还要不要做',
          progress: '飞书是第二个事件源，不影响现有用法',
          relation: 'aside',
          parentId: 'g1',
          firstTurn: 10,
          turns: 1,
          lastTurn: 10,
          active: false,
          children: [],
        },
      ],
    },
    {
      id: 'g5',
      label: '把结论整理成一份可交付的方案',
      progress: '',
      relation: 'root',
      parentId: null,
      firstTurn: 11,
      turns: 1,
      lastTurn: 11,
      active: false,
      children: [],
    },
  ],
  total: 5,
  drift: 2,
  draft: { turn: 12, label: '再往里加一条"上次停在哪儿"' },
}

const store = { get: () => view, subscribe: () => () => {} }
const note = serialize(mod.GoalLedgerNote({ view }))
const chip = serialize(mod.GoalLedgerChip({ store }))

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  :root {
    --bg: #1c1c1f;
    --bg-elevated: #232327;
    --text: #e8e6e3;
    --text-dim: #9a968f;
    --border: #333338;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    font-size: 13px;
  }
  .app { display: flex; height: 100vh; }
  .side { width: 210px; border-right: 1px solid var(--border); padding: 14px 12px; color: var(--text-dim); font-size: 12px; }
  .side div { padding: 6px 8px; border-radius: 4px; }
  .side .on { background: #2b2b31; color: var(--text); }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  /* Mirror the real conversation header: a two-column grid, with the note as a
     full-width second row. */
  .conv-header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    padding: 10px 28px 0 20px;
    border-bottom: .5px solid var(--border);
    min-height: 76px;
  }
  .conv-header .leading { grid-area: 1 / 1; display: flex; align-items: center; gap: 8px; padding-top: 6px; }
  .conv-header .title { grid-column: 2; display: flex; align-items: center; min-height: 30px; gap: 10px; }
  .conv-header .title b { font-weight: 600; font-size: 14px; }
  .conv-header .title span { color: var(--text-dim); font-size: 12px; }
  .conv-header .title .slot { margin-left: auto; display: inline-flex; align-items: center; }
  .popover { position: fixed; top: 58px; right: 28px; width: 520px; z-index: 50; }
  .dot { width: 22px; height: 22px; border-radius: 11px; background: #3a3a42; }
  .msgs { flex: 1; padding: 22px 28px; display: flex; flex-direction: column; gap: 14px; }
  .msg { max-width: 720px; line-height: 1.7; color: #d6d2cc; }
  .msg.user { align-self: flex-end; background: #2b2b31; padding: 8px 12px; border-radius: 8px; color: var(--text); }
  .composer { margin: 0 28px 22px; border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; color: var(--text-dim); background: var(--bg-elevated); }
</style>
</head>
<body>
  <div class="app">
    <aside class="side">
      <div class="on">目标日志插件</div>
      <div>超级代理重写</div>
      <div>视频脚本</div>
    </aside>
    <main class="main">
      <header class="conv-header">
        <div class="leading"><div class="dot"></div></div>
        <div class="title"><b>目标日志插件</b><span>E:\新技术讨论</span><span class="slot">${chip}</span></div>
      </header>
      <div class="msgs">
        <div class="msg user">这个 ui 做的不行吧，可以做一个好看点的，和便签本差不多，可以放到顶部另开一栏</div>
        <div class="msg">明白，改成一张纸的质感，固定在会话标题下面那一栏，不再挤在输入框上面。</div>
      </div>
      <div class="composer">给 DeepSeek 发送消息…</div>
    </main>
    <div class="popover">${note}</div>
  </div>
</body>
</html>`

fs.writeFileSync(outPath, html, 'utf8')
console.log(`wrote ${outPath}`)
