import assert from 'node:assert/strict'
import {
  anchors,
  classify,
  emptyState,
  applyEvent,
  viewOf,
  overlap,
  summariseIntent,
  firstSentence,
} from '../lib/ledger.js'

let checks = 0
function check(name, fn) {
  fn()
  checks += 1
  console.log(`ok ${checks} - ${name}`)
}

/** Fold [turn, prompt, assistantReply] triples as if each turn ran to the end. */
function foldTurns(turns) {
  let state = emptyState()
  for (const [turn, prompt, reply] of turns) {
    state = applyEvent(state, { type: 'turn/start', seq: 1, data: { turn } })
    state = applyEvent(state, {
      type: 'user/message',
      seq: 2,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: prompt }] },
    })
    if (reply !== undefined) {
      state = applyEvent(state, {
        type: 'assistant/message',
        seq: 3,
        data: { message: { content: [{ type: 'text', text: reply }] } },
      })
    }
    state = applyEvent(state, { type: 'turn/end', seq: 4, data: {} })
  }
  return state
}

check('anchors keep ascii identifiers and han bigrams', () => {
  const set = anchors('把 README.md 里的 install 段落改一下，然后重新打包')
  assert.ok(set.has('w:readme.md'))
  assert.ok(set.has('w:install'))
  assert.ok(!set.has('c:这个'))
})

check('overlap is normalised by the smaller set', () => {
  const a = anchors('superagent 的 router 层要汇总 worker 报告')
  const b = anchors('router 汇总报告再补一句')
  assert.ok(overlap(a, b) > 0.25)
})

check('an intent line drops chatter and stays short', () => {
  const intent = summariseIntent('这个ui做的不行吧，可以做一个好看点的，和便签本差不多，可以放到顶部另开一栏')
  assert.ok(!intent.startsWith('这个'), 'leading filler stripped')
  assert.ok(intent.length <= 26, `bounded: ${intent}`)
  assert.ok(intent.includes('便签本') || intent.includes('一栏') || intent.includes('好看'), intent)
})

check('a progress line is the assistant first sentence, not the prompt', () => {
  const progress = firstSentence('**改好了。** 便签挪到标题下面，收起态还在收。')
  assert.equal(progress, '改好了')
  assert.ok(!progress.includes('**'))
})

check('first prompt opens a root goal and stores its summary', () => {
  const state = foldTurns([[1, '我想做一个过滤低质量数据的插件', '先拆问题。低质量数据其实是四种不同的东西。']])
  assert.equal(state.goals.length, 1)
  assert.equal(state.goals[0].relation, 'root')
  assert.equal(state.currentId, state.goals[0].id)
  assert.equal(state.goals[0].label, '做一个过滤低质量数据的插件')
  assert.equal(state.goals[0].progress, '先拆问题')
})

check('same topic next turn continues without adding a row', () => {
  const state = foldTurns([
    [1, '我想做一个过滤低质量数据的插件', '先拆问题。'],
    [2, '继续，把补证做成异步的', '补证改完了。后台跑，不阻塞。'],
  ])
  assert.equal(state.goals.length, 1, 'continue must extend, not add')
  assert.equal(state.goals[0].turns.length, 2)
  assert.equal(state.goals[0].progress, '补证改完了')
})

check('a bare nudge never becomes a stage', () => {
  const state = foldTurns([
    [1, '把目标日志做成便签本样式', '改了纸张和折角。'],
    [2, '继续', '把间距调了一下。'],
    [3, '好的', '换了个字体。'],
  ])
  assert.equal(state.goals.length, 1)
  assert.equal(state.goals[0].turns.length, 3)
})

check('explicit switch becomes an aside without moving the main line', () => {
  const state = foldTurns([
    [1, '我想做一个过滤低质量数据的插件', '先拆问题。'],
    [2, '另外，飞书有什么用，会影响现在的用法吗', '飞书是第二个事件源。'],
  ])
  assert.equal(state.goals.length, 2)
  assert.equal(state.goals[1].relation, 'aside')
  assert.equal(state.currentId, state.goals[0].id, 'aside must not take the main line')
  assert.equal(viewOf(state).drift, 1)
})

check('refine opens a child of the current goal', () => {
  const state = foldTurns([
    [1, '我想做一个过滤低质量数据的插件', '先拆问题。'],
    [2, '细化一下：先做折叠算法，再做补证', '先做折叠。'],
  ])
  assert.equal(state.goals.length, 2)
  assert.equal(state.goals[1].relation, 'refine')
  assert.equal(state.goals[1].parentId, state.goals[0].id)
  assert.equal(state.currentId, state.goals[1].id)
})

check('drift counts turns since the main line advanced and resets on return', () => {
  const state = foldTurns([
    [1, '我想做一个过滤低质量数据的插件', '先拆问题。'],
    [2, '另外，飞书有什么用', '飞书是事件源。'],
    [3, '顺便问下 GitHub token 怎么配', '用环境变量。'],
    [4, '继续，回到插件本体，把折叠算法写掉', '折叠写完了。'],
  ])
  const view = viewOf(state)
  assert.equal(view.drift, 0)
  assert.equal(view.main.id, state.currentId)
})

check('the view carries every goal, the totals and the draft turn', () => {
  const turns = []
  for (let i = 1; i <= 20; i += 1) turns.push([i, `第 ${i} 轮：另外，换一个话题，讲讲第 ${i} 件事`, `讲完了第 ${i} 件。`])
  const state = foldTurns(turns)
  const view = viewOf(state)
  const flatten = (list) => list.reduce((count, node) => count + 1 + flatten(node.children), 0)
  assert.equal(flatten(view.tasks), view.total, 'every goal reaches the client')
  assert.ok(view.total >= 1)
  assert.equal(view.turn, 20)
  assert.equal(view.tasks[0].firstTurn, view.first.firstTurn, 'tasks are oldest first')
})

check('irrelevant events keep the state reference', () => {
  const state = foldTurns([[1, '做一个插件', '好。']])
  const same = applyEvent(state, { type: 'session/title', seq: 9, data: { title: 'x' } })
  assert.equal(same, state)
})

console.log(`\n${checks} checks passed`)

