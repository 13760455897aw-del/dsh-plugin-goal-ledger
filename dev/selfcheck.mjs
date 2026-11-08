/**
 * Self-check: decode this session's real log, fold it through the ledger, and
 * write the exact view the card would receive plus a short text report.
 */
import fs from 'node:fs'
import zlib from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyEvent, emptyState, viewOf } from '../lib/ledger.js'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function decode(buf) {
  const starts = []
  let i = 0
  while (i >= 0 && i < buf.length) {
    const j = buf.indexOf(MAGIC, i)
    if (j < 0) break
    starts.push(j)
    i = j + 1
  }
  const parts = []
  let idx = 0
  let seg = starts[0] ?? 0
  while (idx < starts.length) {
    const end = idx + 1 < starts.length ? starts[idx + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(seg, end)))
      idx += 1
      seg = idx < starts.length ? starts[idx] : buf.length
    } catch {
      if (idx + 1 < starts.length) idx += 1
      else {
        parts.push(buf.subarray(seg))
        idx += 1
      }
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

const source = process.argv[2]
const outDir = path.dirname(fileURLToPath(import.meta.url))
const text = decode(fs.readFileSync(source))
const lines = text.split('\n').filter(Boolean)

let state = emptyState()
let events = 0
let turns = 0
for (const line of lines) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    continue
  }
  if (
    record.type !== 'turn/start' &&
    record.type !== 'user/message' &&
    record.type !== 'assistant/message' &&
    record.type !== 'turn/end'
  ) continue
  events += 1
  if (record.type === 'turn/start') turns += 1
  state = applyEvent(state, { type: record.type, seq: record.seq ?? 0, data: record.data ?? {} })
}

const view = viewOf(state)

const flatten = (list, depth = 0) =>
  list.flatMap((node) => [
    {
      depth,
      path: null,
      label: node.label,
      relation: node.relation,
      progress: node.progress,
      turns: node.turns,
      firstTurn: node.firstTurn,
      lastTurn: node.lastTurn,
      active: node.active,
      children: node.children.length,
    },
    ...flatten(node.children, depth + 1),
  ])

console.log(`events=${events} turns=${turns} goals=${view.total} drift=${view.drift}`)
console.log(`main: ${view.main ? view.main.label : '(none)'}  [${view.main ? view.main.firstTurn + '–' + view.main.lastTurn : ''}]`)
for (const row of flatten(view.tasks)) {
  console.log(`${'  '.repeat(row.depth)}${row.depth === 0 ? '任务' : '- '} ${row.label}  [${row.firstTurn}–${row.lastTurn}] x${row.turns}${row.active ? '  <= current' : ''}${row.children ? `  (${row.children} children)` : ''}`)
  if (row.progress) console.log(`${'  '.repeat(row.depth)}   ↳ ${row.progress}`)
}

fs.writeFileSync(path.join(outDir, 'real-view.json'), JSON.stringify(view, null, 2), 'utf8')
console.log(`\nwrote ${path.join(outDir, 'real-view.json')}`)

