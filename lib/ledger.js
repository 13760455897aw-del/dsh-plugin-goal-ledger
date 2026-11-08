/**
 * Goal Ledger — the fold behind the "目标日志" notepad.
 *
 * It answers three questions from the committed session log alone:
 *   1. what the main line is,
 *   2. where the current turn sits relative to it (continue / refine /
 *      branch / aside / unrelated root),
 *   3. how many turns have passed since the main line last advanced.
 *
 * Two rules keep the note readable rather than a transcript:
 *
 *   - **Only goal-changing turns become nodes.** A turn that keeps working the
 *     current goal — including bare "继续"/"好的" — updates the node's turn
 *     count and its progress line; it never adds a row. Chatty projects
 *     therefore stay at a handful of stages.
 *   - **Every row is a summary, not a quote.** The intent line is condensed
 *     from the prompt (filler stripped, action clause kept); the progress line
 *     is the first sentence of the assistant's own closing message, which is
 *     already the model's summary of what it did.
 *
 * Still deterministic: no model call, no network, no I/O. Model-facing: nothing.
 */

/** Prompt text kept for classification. */
const PROMPT_LIMIT = 240
/** Assistant text kept while a turn is open, for the progress line. */
const ASSISTANT_LIMIT = 900
/** Goals kept in the view; older stages collapse into a "还有 N 段" counter. */
const VIEW_GOAL_LIMIT = 8

/** Explicit markers that a turn leaves the current line on purpose. */
const SWITCH_WORDS = [
  '另外', '换个', '换一个', '顺便', '先停', '先不', '先放', '还有个', '还有一个',
  '另一个', '再问', '跳过', '题外', '与此无关', '不相关',
]

/** Markers that a turn keeps working the same line. */
const CONTINUE_WORDS = ['继续', '接着', '下一步', '然后', '回到', '往下', '再看', '再改', '再来']

/** Markers that a turn narrows a goal into a concrete sub-goal. */
const REFINE_WORDS = ['细化', '拆成', '拆解', '分步', '具体', '第一步', '先做', '分别']

/** A turn that is only a nudge: never a new stage, always "more of the same". */
const NUDGE_ONLY = /^(继续|接着|好的?|可以|行|嗯+|ok|okay|开始|做吧|按这个来|就这样|往下|go|continue|yes)[。！!，,、\s]*$/iu

/** Action verbs that make a clause worth showing as an intent. */
const ACTION_WORDS = [
  '做', '改', '加', '删', '修', '写', '拆', '换', '挪', '放', '接', '装', '跑',
  '测', '查', '看', '重做', '合并', '拆出', '实现', '设计', '整理', '优化', '补',
  '总结', '输出', '归纳', '展示', '显示', '精简', '压缩', '移', '调整',
]

/** Leading chatter stripped before an intent is shown. */
const LEADING_FILLER = /^(那么|然后|另外|顺便|就是说|其实|我在想|我在考虑|我在琢磨|我想|我要|我准备|帮我|麻烦|请你?|咱们?|我们|这个|那个|现在|目前|能不能|可不可以|要不|还是|就是)+/u

/** Trailing particles stripped before an intent is shown. */
const TRAILING_FILLER = /[吧呢啊嘛哈呀了的]+$/u

/** Bigrams too common to carry a topic. */
const STOP_BIGRAMS = new Set([
  '这个', '那个', '我们', '你们', '他们', '什么', '怎么', '可以', '一下', '然后',
  '现在', '帮我', '一个', '就是', '还是', '不是', '因为', '所以', '已经', '需要',
  '应该', '如果', '但是', '而且', '这样', '那样', '是不', '有没', '没有', '不是',
])

/**
 * Anchors are the topic carriers of a prompt: ASCII identifiers and paths
 * verbatim, Han runs as bigrams minus a stopword list.
 * @param {string} text
 * @returns {Set<string>}
 */
export function anchors(text) {
  const out = new Set()
  if (typeof text !== 'string' || text.length === 0) return out
  const lower = text.toLowerCase()

  for (const match of lower.matchAll(/[a-z0-9_@./:-]{2,}/g)) {
    const token = match[0].replace(/[./:-]+$/, '')
    if (token.length >= 2) out.add(`w:${token}`)
  }

  for (const match of lower.matchAll(/[\u4e00-\u9fff]+/g)) {
    const run = match[0]
    for (let i = 0; i + 1 < run.length; i += 1) {
      const bigram = run.slice(i, i + 2)
      if (STOP_BIGRAMS.has(bigram)) continue
      out.add(`c:${bigram}`)
    }
  }

  return out
}

/**
 * Overlap of two anchor sets, normalised by the smaller set.
 * @param {Set<string>} left
 * @param {Set<string>} right
 * @returns {number} 0..1
 */
export function overlap(left, right) {
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const item of left) if (right.has(item)) shared += 1
  return shared / Math.min(left.size, right.size)
}

function hasAny(text, words) {
  return words.some((word) => text.includes(word))
}

/** Strip Markdown emphasis/headings the model wraps around its own summary. */
function plain(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[*_`#>]+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The first sentence of the assistant's closing message — the model has already
 * summarised the turn there, so this is a summary of the work, not of the prompt.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function firstSentence(text, limit = 52) {
  const clean = plain(text)
  if (clean === '') return ''
  const cut = clean.split(/[。！？；\n]/u)[0] ?? clean
  const sentence = cut.replace(/^[-–—·\s]+/u, '').trim()
  if (sentence === '') return ''
  return sentence.length <= limit ? sentence : `${sentence.slice(0, limit - 1)}…`
}

/** A clause that describes the shape of the ask rather than the action. */
const DESCRIPTOR = /(和|跟|像|同).{1,14}(差不多|一样|那样|类似)/u
/** A clause that is only a complaint about the current state. */
const COMPLAINT = /不行|不好|难看|太丑|难受|有问题|不对|不如/u

/**
 * Condense a prompt into an intent line: split into clauses, prefer the clause
 * carrying an action verb, merge in a "shape" clause ("和便签本差不多"), then
 * strip chatter.
 * @param {string} text
 * @param {number} [limit]
 * @returns {string}
 */
export function summariseIntent(text, limit = 26) {
  const clean = plain(text)
  if (clean === '') return ''
  const clauses = clean
    .split(/[，,。；;：:！!？?\n]/u)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0)
  if (clauses.length === 0) return ''

  let best = clauses[0]
  let bestScore = -Infinity
  for (const clause of clauses) {
    let score = clause.length / 20
    if (ACTION_WORDS.some((word) => clause.includes(word))) score += 2
    if (COMPLAINT.test(clause)) score -= 2.5
    if (/^(可以|应该|但是|不过|如果|因为|所以)/u.test(clause)) score -= 0.3
    if (score > bestScore) {
      bestScore = score
      best = clause
    }
  }

  const descriptor = clauses.find((clause) => DESCRIPTOR.test(clause) && clause !== best)
  const joined = descriptor === undefined ? best : `${descriptor}，${best}`

  let intent = joined
    .replace(LEADING_FILLER, '')
    .replace(TRAILING_FILLER, '')
    .trim()
  if (intent === '') intent = best
  if (intent.length <= limit) return intent
  return `${intent.slice(0, limit - 1)}…`
}

/**
 * Decide where a prompt sits relative to the ledger.
 * @param {Array<{id: string, parentId: string | null, anchors: string[]}>} goals
 * @param {string} prompt
 * @param {string | null} currentId
 * @returns {{relation: string, parentId: string | null, targetId: string | null, score: number}}
 */
export function classify(goals, prompt, currentId) {
  const text = String(prompt ?? '')
  const promptAnchors = anchors(text)
  const switched = hasAny(text, SWITCH_WORDS)
  const refined = hasAny(text, REFINE_WORDS)
  const continued = hasAny(text, CONTINUE_WORDS)
  const nudge = NUDGE_ONLY.test(text.trim())

  if (goals.length === 0) {
    return { relation: 'root', parentId: null, targetId: null, score: 0 }
  }

  const current = goals.find((goal) => goal.id === currentId) ?? null

  // A bare "继续"/"好的" is never a new stage, whatever its anchors look like.
  if (nudge && current !== null) {
    return { relation: 'continue', parentId: current.id, targetId: current.id, score: 0 }
  }

  // Short lines, and feedback phrased about what is on screen ("没看到", "你这个…",
  // "还是不行"), talk about the current goal even when the wording shares nothing
  // with the prompt that opened it. Without this rule a real session shatters into
  // one "task" per sentence.
  const trimmed = text.trim()
  const aboutTheCurrent = /^(你|这|那|它|刚才|上面|现在|还是|不|没|怎么|为什么|能不能)/u.test(trimmed)
  if (current !== null && !switched && (trimmed.length <= 6 || (aboutTheCurrent && trimmed.length <= 26))) {
    return { relation: 'continue', parentId: current.id, targetId: current.id, score: 0 }
  }

  let best = null
  for (const goal of goals) {
    const score = overlap(promptAnchors, new Set(goal.anchors))
    if (best === null || score > best.score) best = { goal, score }
  }

  const currentScore = current === null
    ? 0
    : overlap(promptAnchors, new Set(current.anchors))

  if (best === null) {
    return { relation: 'root', parentId: null, targetId: null, score: 0 }
  }

  // Explicit discourse markers outrank anchor overlap.
  if (switched && current !== null) {
    return { relation: 'aside', parentId: current.id, targetId: null, score: currentScore }
  }

  if (refined && current !== null) {
    return { relation: 'refine', parentId: current.id, targetId: null, score: currentScore }
  }

  if (continued && current !== null) {
    return { relation: 'continue', parentId: current.id, targetId: current.id, score: currentScore }
  }

  if (best.score >= 0.34) {
    return { relation: 'continue', parentId: best.goal.id, targetId: best.goal.id, score: best.score }
  }

  if (best.score >= 0.15) {
    return {
      relation: 'branch',
      parentId: best.goal.parentId ?? best.goal.id,
      targetId: null,
      score: best.score,
    }
  }

  if (promptAnchors.size >= 2) {
    return { relation: 'root', parentId: null, targetId: null, score: best.score }
  }

  return { relation: 'aside', parentId: current?.id ?? null, targetId: null, score: best.score }
}

/** Empty fold state. */
export function emptyState() {
  return { turn: 0, goals: [], currentId: null, draft: null, seq: 0 }
}

/** Pull the text blocks of one assistant message. */
function messageText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
}

/**
 * Fold one committed session event into the ledger state. Events this unit does
 * not care about must return the same state reference.
 * @param {ReturnType<typeof emptyState>} state
 * @param {{type: string, seq: number, data: any}} event
 */
export function applyEvent(state, event) {
  switch (event.type) {
    case 'turn/start': {
      return {
        ...state,
        turn: event.data.turn,
        draft: { turn: event.data.turn, raw: '', anchors: [], assistant: '' },
        seq: event.seq,
      }
    }
    case 'user/message': {
      const source = event.data?.source
      if (!source || source.kind !== 'user') return state
      const draft = state.draft
      if (draft === null || draft.raw !== '') return state
      const text = (event.data.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (text === '') return state
      return {
        ...state,
        draft: {
          turn: draft.turn,
          raw: text.slice(0, PROMPT_LIMIT),
          anchors: [...anchors(text)],
          assistant: draft.assistant,
        },
        seq: event.seq,
      }
    }
    case 'assistant/message': {
      const draft = state.draft
      if (draft === null) return state
      const text = messageText(event.data?.message)
      if (text === '') return state
      return {
        ...state,
        draft: { ...draft, assistant: text.slice(0, ASSISTANT_LIMIT) },
        seq: event.seq,
      }
    }
    case 'turn/end': {
      const draft = state.draft
      if (draft === null) return state
      if (draft.raw === '') return { ...state, draft: null, seq: event.seq }

      const verdict = classify(state.goals, draft.raw, state.currentId)
      const progress = firstSentence(draft.assistant)
      const goals = [...state.goals]
      let currentId = state.currentId

      if (verdict.relation === 'continue' && verdict.targetId !== null) {
        const index = goals.findIndex((goal) => goal.id === verdict.targetId)
        if (index >= 0) {
          const target = goals[index]
          goals[index] = {
            ...target,
            turns: [...target.turns, draft.turn],
            lastTurn: draft.turn,
            anchors: [...new Set([...target.anchors, ...draft.anchors])],
            progress: progress === '' ? target.progress : progress,
          }
        }
        currentId = verdict.targetId
      } else {
        const id = `g${goals.length + 1}`
        goals.push({
          id,
          label: summariseIntent(draft.raw),
          raw: draft.raw,
          progress,
          relation: verdict.relation,
          parentId: verdict.parentId,
          turns: [draft.turn],
          lastTurn: draft.turn,
          anchors: draft.anchors,
        })
        if (verdict.relation === 'refine' || verdict.relation === 'branch') {
          currentId = id
        } else if (currentId === null) {
          currentId = id
        }
      }

      return { ...state, goals, currentId, draft: null, seq: event.seq }
    }
    default:
      return state
  }
}

/**
 * Client-facing view: the ledger as a tree — roots are tasks, children are the
 * branches a task split into — plus the totals a reader needs at a glance.
 * @param {ReturnType<typeof emptyState>} state
 */
export function viewOf(state) {
  const main = state.goals.find((goal) => goal.id === state.currentId) ?? null

  const nodes = new Map()
  for (const goal of state.goals) {
    nodes.set(goal.id, {
      id: goal.id,
      label: goal.label,
      progress: goal.progress ?? '',
      relation: goal.relation,
      parentId: goal.parentId,
      firstTurn: goal.turns.length > 0 ? goal.turns[0] : goal.lastTurn,
      lastTurn: goal.lastTurn,
      turns: goal.turns.length,
      active: goal.id === state.currentId,
      done: false,
      skipped: false,
      summary: '',
      children: [],
    })
  }

  const roots = []
  for (const node of nodes.values()) {
    const parent = node.parentId === null ? undefined : nodes.get(node.parentId)
    if (parent === undefined || parent.id === node.id) roots.push(node)
    else parent.children.push(node)
  }

  // Show where the session is without a click: open the current goal and its ancestors.
  let cursor = state.currentId
  const walked = new Set()
  while (cursor !== null && !walked.has(cursor)) {
    const node = nodes.get(cursor)
    if (node === undefined) break
    node.open = true
    walked.add(cursor)
    cursor = node.parentId
  }

  const drift = main === null ? 0 : Math.max(0, state.turn - main.lastTurn)
  const first = state.goals[0] ?? null

  return {
    turn: state.turn,
    main: main === null
      ? null
      : {
          id: main.id,
          label: main.label,
          progress: main.progress ?? '',
          firstTurn: main.turns.length > 0 ? main.turns[0] : main.lastTurn,
          turns: main.turns.length,
          lastTurn: main.lastTurn,
        },
    first: first === null ? null : { label: first.label, firstTurn: first.turns.length > 0 ? first.turns[0] : first.lastTurn },
    tasks: roots,
    total: state.goals.length,
    drift,
    draft: state.draft === null || state.draft.raw === ''
      ? null
      : { turn: state.draft.turn, label: summariseIntent(state.draft.raw) },
  }
}

/** Schema duck-type accepted by the projection registry (`parse` is all it calls). */
const passthrough = {
  parse: (value) => value,
  safeParse: (value) => ({ success: true, data: value }),
  '~standard': { version: 1, vendor: 'goal-ledger', validate: (value) => ({ value }) },
}

/** The `goalLedger` projection unit. */
export function createLedgerDefinition() {
  return {
    key: 'goalLedger',
    stateVersion: 4,
    stateSchema: passthrough,
    init: () => emptyState(),
    apply: (state, event) => applyEvent(state, event),
    wire: {
      viewSchema: passthrough,
      view: (state) => viewOf(state),
    },
  }
}


