/**
 * Render a stored model ledger exactly as the card would receive it.
 * Usage: node dev/state-view.mjs <sessionId>
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { ModelLedger } from '../lib/model-ledger.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const sessionId = process.argv[2]
if (sessionId === undefined) {
  console.error('usage: node dev/state-view.mjs <sessionId>')
  process.exit(1)
}

const ledger = new ModelLedger({ llm: {}, logger: { warn() {}, info() {} } })
const state = ledger.stateOf(sessionId)
const view = ledger.viewOf(state)
const out = path.join(here, 'state-view.json')
fs.writeFileSync(out, JSON.stringify(view, null, 2), 'utf8')
console.log(`turn=${view.turn} total=${view.total} done=${view.tasks.filter((t) => t.done).length}`)
for (const task of view.tasks) {
  const walk = (node, depth) => {
    const mark = node.active ? '●' : node.done ? '✓' : node.skipped ? '→' : '○'
    console.log(`${'  '.repeat(depth)}${mark} ${node.label}${node.children.length ? ` (${node.children.length})` : ''}`)
    for (const child of node.children) walk(child, depth + 1)
  }
  walk(task, 0)
}
console.log(`wrote ${out}`)
