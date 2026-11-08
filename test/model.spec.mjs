/**
 * Model ledger tests: verdict parsing, prompt shape, folding, and the served view.
 * The LLM is faked — the point is the contract around it, not the provider.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ModelLedger, buildDigest, buildPrompt, parseVerdict } from '../lib/model-ledger.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok ${checks} - ${name}`)
}

process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-ledger-'))

check('parseVerdict accepts a bare JSON line', () => {
  const verdict = parseVerdict('{"rel":"child","parentId":"a1","name":"挪到顶部","progress":"改完了"}')
  assert.deepEqual(verdict, { rel: 'child', name: '挪到顶部', progress: '改完了', parentId: 'a1', prevDone: true, prevSummary: '' })
})

check('parseVerdict tolerates fences and prose', () => {
  const verdict = parseVerdict('好的，判定如下：\n```json\n{"rel":"root","parentId":null,"name":"装插件","progress":"装好了"}\n```')
  assert.equal(verdict?.rel, 'root')
  assert.equal(verdict?.parentId, null)
})

check('parseVerdict rejects junk', () => {
  assert.equal(parseVerdict('我觉得应该继续'), null)
  assert.equal(parseVerdict('{"rel":"child","name":""}'), null)
})

check('buildPrompt lists ids, the current marker and the turn', () => {
  const prompt = buildPrompt(
    [{ id: 'm1', label: '装插件', parentId: null }],
    'm1',
    { prompt: '没看到啊', assistant: '改好了，位置也换了' }
  )
  assert.ok(prompt.includes('m1｜装插件 ←当前'))
  assert.ok(prompt.includes('本轮用户输入：没看到啊'))
  assert.ok(prompt.includes('本轮助手收尾：改好了'))
})

/** One fake completion that returns the given text. */
function fakeCtx(text) {
  return {
    logger: { warn() {}, info() {} },
    llm: {
      async prepareCall(_route, _signal, pick) {
        return {
          config: pick({}, {}),
          async *stream() {
            yield { type: 'text-delta', index: 0, text }
            yield { type: 'finish', reason: { kind: 'stop' } }
          },
        }
      },
    },
  }
}

check('a root verdict creates the first task', async () => {
  const ledger = new ModelLedger(fakeCtx('{"rel":"root","parentId":null,"name":"装目标日志插件","progress":"装好了"}'))
  const state = ledger.stateOf('s1')
  ledger.applyVerdict(state, parseVerdict('{"rel":"root","parentId":null,"name":"装目标日志插件","progress":"装好了"}'), 1)
  assert.equal(state.tasks.length, 1)
  assert.equal(state.tasks[0].label, '装目标日志插件')
  assert.equal(state.currentId, state.tasks[0].id)
})

check('a child verdict nests under its parent', () => {
  const ledger = new ModelLedger(fakeCtx('{}'))
  const state = { turn: 3, tasks: [{ id: 'm1', label: '装插件', progress: '', parentId: null, firstTurn: 1, lastTurn: 1, turns: 1 }], currentId: 'm1', draft: null, pending: false }
  ledger.applyVerdict(state, { rel: 'child', parentId: 'm1', name: '改成便签样式', progress: '重做了' }, 3)
  assert.equal(state.tasks.length, 2)
  assert.equal(state.tasks[1].parentId, 'm1')
  const view = ledger.viewOf(state)
  assert.equal(view.tasks.length, 1, 'one root')
  assert.equal(view.tasks[0].children.length, 1, 'one child under it')
  assert.equal(view.tasks[0].children[0].label, '改成便签样式')
})

check('a continue verdict updates the current task in place', () => {
  const ledger = new ModelLedger(fakeCtx('{}'))
  const state = { turn: 4, tasks: [{ id: 'm1', label: '装插件', progress: '', parentId: null, firstTurn: 1, lastTurn: 2, turns: 1 }], currentId: 'm1', draft: null, pending: false }
  ledger.applyVerdict(state, { rel: 'continue', parentId: 'm1', name: '装插件', progress: '又改了一版' }, 4)
  assert.equal(state.tasks.length, 1)
  assert.equal(state.tasks[0].turns, 2)
  assert.equal(state.tasks[0].progress, '又改了一版')
})

check('a finished turn reaches the model and stores the verdict', async () => {
  const ledger = new ModelLedger(fakeCtx('{"rel":"root","parentId":null,"name":"装上插件","progress":"等你重启"}'))
  const session = { id: 's2' }
  ledger.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  ledger.onEvent(session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '先在我的dsh中装上这个插件看看' }] },
  })
  ledger.onEvent(session, {
    type: 'assistant/message',
    data: { message: { content: [{ type: 'text', text: '装好了，现在只剩你刷新/重启这一步。' }] } },
  })
  ledger.onEvent(session, { type: 'turn/end', data: {} })
  // decide() is fire-and-forget; let the microtasks drain.
  await new Promise((resolve) => setTimeout(resolve, 20))
  const state = ledger.stateOf('s2')
  assert.equal(state.tasks.length, 1)
  assert.equal(state.tasks[0].label, '装上插件')
  assert.equal(state.tasks[0].progress, '等你重启')
})

check('a failing model call never throws and leaves the ledger untouched', async () => {
  const ctx = {
    logger: { warn() {}, info() {} },
    llm: {
      async prepareCall() {
        throw new Error('NO_ADAPTER')
      },
    },
  }
  const ledger = new ModelLedger(ctx)
  const session = { id: 's3' }
  ledger.onEvent(session, { type: 'turn/start', data: { turn: 1 } })
  ledger.onEvent(session, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '测试' }] } })
  ledger.onEvent(session, { type: 'turn/end', data: {} })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(ledger.stateOf('s3').tasks.length, 0)
  assert.equal(ledger.stateOf('s3').pending, false)
})

check('buildDigest keeps prompts and assistant openings, newest when over budget', () => {
  const log = []
  for (let i = 1; i <= 50; i += 1) {
    log.push({ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${i} 个请求` }] } })
    log.push({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `第 ${i} 个回答。` }] } } })
  }
  const full = buildDigest(log, 100000)
  assert.ok(full.includes('用户：第 1 个请求'))
  const clipped = buildDigest(log, 200)
  assert.ok(!clipped.includes('第 1 个请求'), 'oldest lines are dropped first')
  assert.ok(clipped.includes('用户：第 50 个请求'), 'newest lines survive')
})

check('opening a session with history backfills the whole log once', async () => {
  const answer = '[{"name":"分析文章数据","progress":"解析 1978 篇","parentIndex":null},{"name":"生成标题","progress":"产出 40 条","parentIndex":0}]'
  const ledger = new ModelLedger(fakeCtx(answer))
  const session = {
    id: 's4',
    log: [
      { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我看看这些文章' }] } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '先跑一遍数据。' }] } } },
    ],
  }
  ledger.onSessionCreated(session)
  await new Promise((resolve) => setTimeout(resolve, 20))
  const state = ledger.stateOf('s4')
  assert.equal(state.tasks.length, 2)
  assert.equal(state.currentId, 'b2', 'the newest task is the current one')
  assert.equal(state.tasks[0].done, true)
  assert.equal(state.tasks[1].parentId, 'b1', 'parentIndex became a parent id')
  assert.equal(state.backfilled, true)

  // Second open must not spend another call.
  const before = state.tasks.length
  ledger.onSessionCreated(session)
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(ledger.stateOf('s4').tasks.length, before)
})

check('leaving a task stores the model one-line conclusion', () => {
  const ledger = new ModelLedger(fakeCtx('{}'))
  const state = { turn: 5, tasks: [{ id: 'm1', label: '装插件', progress: '装好了', parentId: null, firstTurn: 1, lastTurn: 2, turns: 1, done: false, summary: '' }], currentId: 'm1', draft: null, pending: false }
  ledger.applyVerdict(state, { rel: 'root', name: '新任务', progress: '开始了', parentId: null, prevDone: true, prevSummary: '插件装好并能显示卡片' }, 5)
  assert.equal(state.tasks[0].done, true)
  assert.equal(state.tasks[0].summary, '插件装好并能显示卡片')
})

console.log(`\n${checks} checks passed`)
