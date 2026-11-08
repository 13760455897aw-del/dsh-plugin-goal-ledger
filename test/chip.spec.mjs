/**
 * Chip interaction test: open the card, close it again, and prove the card reports
 * its own size when it mounts. This is the regression guard for the class of bug
 * that cost several rounds — "the click lands but nothing visible appears".
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

let captured = null
globalThis.window = {
  __ModuleLoader__: { load: (definition) => { captured = definition } },
  localStorage: { getItem: () => null, setItem: () => {} },
}

const fetches = []
globalThis.fetch = (url) => {
  fetches.push(String(url))
  return Promise.resolve({ ok: true, json: async () => ({}) })
}

new Function('window', source)(globalThis.window)

/** Minimal hooks runtime: one component, stable call order, state kept between renders. */
const states = []
let cursor = 0
const React = {
  Fragment: Symbol.for('react.fragment'),
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useState(initial) {
    const index = cursor
    cursor += 1
    if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial
    return [states[index], (next) => { states[index] = typeof next === 'function' ? next(states[index]) : next }]
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
  Component: class {
    constructor(props) {
      this.props = props
      this.state = {}
    }
  },
}

const mod = captured.factory((id) => {
  if (id === 'react') return React
  throw new Error(`unexpected require: ${id}`)
})

const view = {
  turn: 4,
  total: 2,
  drift: 0,
  main: { id: 'm2', label: '核查标题', progress: '逐条溯源 40 条', turns: 1, lastTurn: 4 },
  first: { label: '分析文章', firstTurn: 1 },
  tasks: [
    { id: 'm1', label: '分析文章', progress: '', done: true, summary: '解析 1978 篇', active: false, open: false, children: [], relation: 'root', parentId: null, firstTurn: 1, lastTurn: 1, turns: 1 },
    { id: 'm2', label: '核查标题', progress: '逐条溯源 40 条', done: false, summary: '', active: true, open: true, children: [], relation: 'root', parentId: null, firstTurn: 4, lastTurn: 4, turns: 1 },
  ],
}
const store = { get: () => view, subscribe: () => () => {} }
const modelStore = { get: () => view, subscribe: () => () => {} }

const render = () => {
  cursor = 0
  return mod.GoalLedgerChip({ store, modelStore, sessionId: 'session-x' })
}

const wrapperChildren = (tree) => tree.children.filter((child) => child !== null && child !== undefined)

let tree = render()
assert.equal(wrapperChildren(tree).length, 1, 'closed: only the chip')

const chip = wrapperChildren(tree)[0]
assert.equal(chip.type, 'button')

chip.props.onClick()
tree = render()
const open = wrapperChildren(tree)
assert.equal(open.length, 2, 'open: chip + card')

const card = open.find((child) => typeof child.props.ref === 'function')
assert.ok(card, 'card mounts with a size probe')
assert.ok(fetches.some((url) => url.includes('m=open')), 'opening reports a beacon')

card.props.ref({ getBoundingClientRect: () => ({ width: 460, height: 312 }) })
assert.ok(
  fetches.some((url) => url.includes('m=card') && url.includes('w=460') && url.includes('h=312')),
  'card reports its own non-zero size'
)

const chipOpen = open.find((child) => child.type === 'button')
chipOpen.props.onClick()
tree = render()
assert.equal(wrapperChildren(tree).length, 1, 'closing removes the card')

console.log('chip interaction test passed')
