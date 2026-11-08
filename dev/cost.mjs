/**
 * Cost probe: measure what one ledger completion actually sends, using the real
 * session data this plugin has stored plus a representative turn.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { SYSTEM, buildPrompt } from '../lib/model-ledger.js'

const dir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'state', 'goal-ledger')

/** Rough token estimate for mixed Chinese/ASCII text. */
const tokens = (text) => {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1
    else other += 1
  }
  return Math.ceil(cjk / 1.5 + other / 4)
}

const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.json')) : []
let worstTasks = []
for (const file of files) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    const tasks = (state.tasks ?? []).map((task) => ({ ...task, id: task.id, label: task.label, parentId: task.parentId ?? null }))
    if (tasks.length > worstTasks.length) worstTasks = tasks
  } catch {}
}

const sampleDraft = {
  prompt: '这个需要多少token一次总结，消耗大吗',
  assistant: '极简卡片：一行一个任务，✓ 完成 / ● 当前 / ○ 未开始；只有当前任务带一行进展，完成的任务点开才显示一句话总结。',
}

const small = worstTasks.slice(-5)
const promptSmall = buildPrompt(small, small.at(-1)?.id ?? null, sampleDraft)
const promptAll = buildPrompt(worstTasks, worstTasks.at(-1)?.id ?? null, sampleDraft)
const promptFull = buildPrompt(
  Array.from({ length: 60 }, (_, i) => ({ id: `m${i + 1}`, label: '一个大概十四个字左右的任务名称示例', parentId: null })),
  'm60',
  { prompt: 'x'.repeat(500), assistant: 'y'.repeat(600) }
)

console.log(`storage: ${files.length} sessions, largest ledger ${worstTasks.length} tasks`)
for (const [label, prompt] of [
  ['typical (last 5 tasks)', promptSmall],
  ['largest real ledger', promptAll],
  ['worst case (60 tasks, max draft)', promptFull],
]) {
  const input = tokens(SYSTEM) + tokens(prompt)
  console.log(`${label}: system ${tokens(SYSTEM)} + prompt ${tokens(prompt)} = ~${input} input tokens`)
}
console.log('output: verdict JSON ≈ 40–80 tokens (cap 320)')
