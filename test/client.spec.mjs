/**
 * Smoke test for the browser half: load the bundle the way the client module
 * loader does, then exercise slot registration and one render of the dock with
 * a stub React. No DOM needed — the point is that the factory, the inject list
 * and the store wiring survive contact with the real loader contract.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'lib', 'client.js')
const source = fs.readFileSync(bundlePath, 'utf8')

let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      captured = definition
    },
  },
}

// eslint-disable-next-line no-new-func
new Function('window', source)(globalThis.window)
assert.ok(captured, 'bundle must call window.__ModuleLoader__.load')
assert.equal(captured.id, 'dsh-plugin-goal-ledger')

const calls = []
const React = {
  Fragment: Symbol.for('react.fragment'),
  createElement(type, props, ...children) {
    const element = { type, props: props ?? {}, children }
    calls.push(element)
    // Stub renderer: invoke function components so assertions can see the tree,
    // but never classes (they need `new`, and the boundary is exercised elsewhere).
    const isClass = typeof type === 'function' && type.prototype && type.prototype.render !== undefined
    if (typeof type === 'function' && !isClass) return type(element.props)
    return element
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useSyncExternalStore(subscribe, getSnapshot) {
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

assert.equal(typeof mod.apply, 'function')
assert.deepEqual(mod.inject, ['slots', 'sessions'])

const view = {
  turn: 12,
  main: {
    id: 'g3',
    label: '把目标日志做成便签本，挪到会话顶部',
    progress: '改好了，便签挪到标题下面，收起态还留着',
    firstTurn: 6,
    turns: 4,
    lastTurn: 12,
  },
  first: { label: '做一个能看的主线 + 偏离提醒', firstTurn: 1 },
  tasks: [
    {
      id: 'g1',
      label: '做一个能看的主线 + 偏离提醒',
      progress: '先拆问题，再定主线',
      relation: 'root',
      parentId: null,
      firstTurn: 1,
      turns: 3,
      lastTurn: 3,
      active: false,
      done: true,
      open: true,
      children: [
        {
          id: 'g2',
          label: '关系判定改成锚点重叠',
          progress: '锚点层写完了',
          relation: 'refine',
          parentId: 'g1',
          firstTurn: 4,
          turns: 2,
          lastTurn: 5,
          active: false,
          done: true,
          open: true,
          children: [
            {
              id: 'g3',
              label: '把目标日志做成便签本，挪到会话顶部',
              progress: '改好了，便签挪到标题下面，收起态还留着',
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
          progress: '飞书是第二个事件源',
          relation: 'aside',
          parentId: 'g1',
          firstTurn: 10,
          turns: 1,
          lastTurn: 10,
          active: false,
          done: true,
          children: [],
        },
      ],
    },
  ],
  total: 4,
  drift: 2,
  draft: null,
}

const registered = []
const disposers = []
const ctx = {
  sessions: {
    binding(sessionId) {
      return {
        session: {
          projections: {
            faceOf(key) {
              assert.equal(key, 'goalLedger')
              return { getSnapshot: () => view, subscribe: () => () => {} }
            },
          },
        },
      }
    },
  },
  effect(fn) {
    disposers.push(fn())
  },
  slots: {
    inject(name, register) {
      assert.equal(name, 'conversation.input.dock')
      register()
    },
    register(spec, component) {
      const entry = { spec, component }
      registered.push(entry)
      return () => {
        const index = registered.indexOf(entry)
        if (index >= 0) registered.splice(index, 1)
      }
    },
  },
}

mod.apply(ctx)
// Registration is synchronous now: slot order comes from `dsh.client.inject`,
// and the entry must belong to the plugin's fiber so disabling it removes the UI.
assert.equal(registered.length, 1)
assert.equal(registered[0].spec.id, 'goal-ledger')
assert.equal(disposers.length, 1, 'the slot entry is owned by the plugin fiber')

const props = registered[0].spec.inject('session-1')
assert.deepEqual(Object.keys(props), ['sessionId'])
assert.equal(props.sessionId, 'session-1')

// Render the notepad itself with the store the wrapper would have built.
calls.length = 0
const element = mod.GoalLedgerNote({ view })
assert.ok(element, 'notepad must render an element')
assert.ok(calls.length > 0)

// The card is a glance: a brand, a count, and one line per task.
const text = JSON.stringify(calls)
assert.ok(text.includes('目标日志'), 'headline carries the notepad brand')
assert.ok(text.includes('4 个目标'), 'headline carries the task count')
assert.ok(text.includes('做一个能看的主线 + 偏离提醒'), 'first task is rendered')
assert.ok(text.includes('●'), 'the task in progress is marked')
assert.ok(text.includes('✓'), 'finished tasks are ticked')
assert.ok(text.includes('从「') === false, 'no overview paragraph')
assert.ok(text.includes('最近') === false, 'no per-turn rows')
assert.ok(text.includes('改好了，便签挪到标题下面'), 'current task shows its progress line')

// Empty ledger must not throw and must explain itself.
calls.length = 0
const emptyElement = mod.GoalLedgerNote({
  view: { turn: 0, main: null, tasks: [], total: 0, drift: 0, draft: null },
})
assert.ok(emptyElement)
assert.ok(JSON.stringify(calls).includes('等待第一轮'))

// No session on screen: the wrapper must render nothing rather than an empty chip.
const wrapper = registered[0].component
assert.equal(wrapper({}), null)

// With a session, the header entry renders the paper chip.
calls.length = 0
const chip = wrapper({ sessionId: 'session-1' })
assert.ok(chip)

calls.length = 0
const chipElement = mod.GoalLedgerChip({ store: { get: () => view, subscribe: () => () => {} } })
assert.ok(chipElement)
const chipText = JSON.stringify(calls)
assert.ok(chipText.includes('目标日志'), 'chip carries the brand')
assert.ok(chipText.includes('"2"'), 'chip carries the drift count')

// Disabling the plugin must remove its UI: disposing the fiber kills the slot entry.
assert.equal(registered.length, 1, 'entry present while the plugin is active')
disposers[0]()
assert.equal(registered.length, 0, 'disposing the plugin removes the chip')

// A hostile slot service must cost the notepad, never the boot.
const brokenCtx = {
  sessions: ctx.sessions,
  slots: {
    inject() {
      throw new Error('slot "conversation.header" is already declared')
    },
  },
}
const originalWarn = console.warn
console.warn = () => {}
try {
  mod.apply(brokenCtx)
  await new Promise((resolve) => setTimeout(resolve, 0))
} finally {
  console.warn = originalWarn
}

console.log('client bundle smoke test passed')



