/**
 * Config and retry tests: the new knobs must actually change the prompt, and a
 * chatty (non-JSON) first answer must not lose the turn.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ModelLedger, buildPrompt } from '../lib/model-ledger.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok ${checks} - ${name}`)
}

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-ledger-cfg-'))

/** Fake context that answers with the given sequence and counts calls. */
function seqCtx(answers) {
  const calls = []
  return {
    calls,
    logger: { warn() {}, info() {} },
    llm: {
      async prepareCall() {
        return {
          config: {},
          async *stream() {
            const index = Math.min(calls.length, answers.length - 1)
            calls.push(answers[index])
            yield { type: 'text-delta', index: 0, text: answers[index] }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }
}

check('promptTasks limits how many tasks the prompt lists', () => {
  const tasks = Array.from({ length: 20 }, (_, i) => ({ id: `m${i + 1}`, label: `任务${i + 1}`, parentId: null }))
  const prompt = buildPrompt(tasks, 'm20', { prompt: '继续', assistant: '好了' }, 5)
  assert.ok(prompt.includes('m20'), 'newest task kept')
  assert.ok(prompt.includes('m16'), 'five newest kept')
  assert.ok(!prompt.includes('m15'), 'older tasks dropped')
})

check('excerptChars caps the assistant text stored per turn', () => {
  const ledger = new ModelLedger(seqCtx(['{"rel":"root","name":"任务","progress":"好了"}']), { excerptChars: 20 })
  const session = { id: 's1' }
  ledger.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  ledger.onEvent(session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '做件事' }] },
  })
  ledger.onEvent(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '一'.repeat(100) }] } },
  })
  assert.ok(ledger.stateOf('s1').draft.assistant.length <= 20, 'stored excerpt is capped')
})

check('a non-JSON answer is retried once and the turn still lands', async () => {
  const ctx = seqCtx(['我觉得应该继续', '{"rel":"root","parentId":null,"name":"装插件","progress":"装好了"}'])
  const ledger = new ModelLedger(ctx, { retries: 1 })
  const session = { id: 's2' }
  ledger.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  ledger.onEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '装个插件' }] } })
  ledger.onEvent(session, { type: 'turn/end', data: {} })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(ctx.calls.length, 2, 'exactly one retry')
  assert.equal(ledger.stateOf('s2').tasks.length, 1)
  assert.equal(ledger.stateOf('s2').tasks[0].label, '装插件')
})

check('retries: 0 keeps the strict single attempt', async () => {
  const ctx = seqCtx(['不是 JSON'])
  const ledger = new ModelLedger(ctx, { retries: 0 })
  const session = { id: 's3' }
  ledger.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  ledger.onEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '做件事' }] } })
  ledger.onEvent(session, { type: 'turn/end', data: {} })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(ctx.calls.length, 1)
  assert.equal(ledger.stateOf('s3').tasks.length, 0)
  assert.equal(ledger.stateOf('s3').error, '模型输出不是判定 JSON')
})

console.log(`\n${checks} checks passed`)
