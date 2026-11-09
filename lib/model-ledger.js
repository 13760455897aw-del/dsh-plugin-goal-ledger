/**
 * Model-backed ledger: the async half of the plugin.
 *
 * The rule projection stays as the instant, zero-cost view; this pipeline may
 * replace any node's wording and parentage with a model verdict, and the client
 * prefers it when a verdict exists. Every failure path falls back to the rules —
 * the card must never depend on a model call succeeding.
 *
 * Flow: `session/event` → per-session ledger state → on `turn/end` one small
 * completion → JSON verdict → state update → served over
 * `GET /goal-ledger/state?session=<id>`.
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const SYSTEM = [
  '你在维护一份"目标日志"：把一场开发对话归纳成树状的任务清单。',
  '任务是"用户想达成的事"，不是一句话，也不是助手做了什么；名字要像任务标题（≤14 个汉字），不要出现"你/这个/还是"这类对话残片。',
  '每轮只做一次判定：这一轮属于已有任务（continue）、是某个任务的子任务（child），还是一个全新任务（root）。',
  '只输出一行 JSON，不要代码块、不要解释：',
  '{"rel":"continue|child|root","parentId":"已有任务id或null","name":"任务名","progress":"这一轮的进展，≤30字","prevDone":true,"prevSummary":"上一件事的一句话结论，≤30字"}',
  'prevDone 表示上一件事是否真的做完了：换了方向、但上一件没做完，填 false。',
  'prevSummary 只在离开上一件事时填：一句话说清那件事最后的结果。',
].join('\n')

/** Prompt for the one-shot backfill of a session's existing history. */
export const BACKFILL_SYSTEM = [
  '你把一段已经发生的开发对话归纳成任务清单。',
  '任务是"用户想达成的事"，名字像任务标题（≤14 个汉字），不要抄原句。',
  '按时间顺序，最多 8 项；每项给出这一件事的一句话结论。',
  '只输出 JSON 数组，不要代码块、不要解释：',
  '[{"name":"任务名","progress":"这件事的结论，≤30字","parentIndex":null}]',
  'parentIndex 指向父任务在数组中的下标（从 0 开始），没有父任务填 null。',
].join('\n')

/** Cap on the ledger kept per session (memory + payload). */
const MAX_TASKS = 60
/** Assistant excerpt fed to the model. */
const EXCERPT = 600

function short(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
}

/** Join the text blocks of a message content array. */
function textBlocks(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Compress a session log into the transcript a one-shot backfill reads: human
 * prompts and the assistant's openings, newest kept first when the budget runs out.
 */
export function buildDigest(log, maxChars = 4000) {
  const lines = []
  for (const event of Array.isArray(log) ? log : []) {
    if (event?.type === 'user/message' && event.data?.source?.kind === 'user') {
      const text = textBlocks(event.data.content)
      if (text !== '') lines.push(`用户：${short(text, 200)}`)
    } else if (event?.type === 'assistant/message') {
      const text = textBlocks(event.data?.message?.content)
      if (text !== '') lines.push(`助手：${short(text, 160)}`)
    }
  }
  const picked = []
  let total = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (total + lines[index].length > maxChars) break
    picked.push(lines[index])
    total += lines[index].length + 1
  }
  return picked.reverse().join('\n')
}

/** Extract the first JSON object from model output, tolerating prose around it. */
export function parseVerdict(text) {
  const match = /\{[\s\S]*\}/.exec(String(text ?? ''))
  if (match === null) return null
  try {
    const value = JSON.parse(match[0])
    if (value === null || typeof value !== 'object') return null
    const rel = value.rel === 'child' || value.rel === 'root' ? value.rel : 'continue'
    const name = short(value.name ?? '', 28)
    const progress = short(value.progress ?? '', 60)
    const parentId = typeof value.parentId === 'string' && value.parentId !== 'null' ? value.parentId : null
    if (name === '' && rel !== 'continue') return null
    return {
      rel,
      name,
      progress,
      parentId,
      prevDone: value.prevDone !== false,
      prevSummary: short(value.prevSummary ?? '', 60)
    }
  } catch {
    return null
  }
}

/**
 * Extract the JSON array of a backfill answer: `[{name, progress, parentIndex}]`.
 * Positions are kept so `parentIndex` can be resolved after filtering.
 */
export function parseTaskList(text) {
  const match = /\[[\s\S]*\]/.exec(String(text ?? ''))
  if (match === null) return null
  try {
    const value = JSON.parse(match[0])
    if (!Array.isArray(value)) return null
    const items = []
    value.forEach((item, index) => {
      if (item === null || typeof item !== 'object') return
      const name = short(item.name ?? '', 28)
      if (name === '') return
      const parentIndex = Number.isInteger(item.parentIndex) ? item.parentIndex : null
      items.push({ index, name, progress: short(item.progress ?? '', 60), parentIndex })
    })
    return items.length === 0 ? null : items
  } catch {
    return null
  }
}

/**
 * Build the model input: existing task ids and names, the turn's prompt, and the
 * assistant's closing words.
 */
export function buildPrompt(tasks, currentId, draft, limit = MAX_TASKS) {
  const lines = tasks.slice(-limit).map((task) => {
    const mark = task.id === currentId ? ' ←当前' : ''
    return `${task.id}｜${task.label}${task.parentId === null ? '' : `（父 ${task.parentId}）`}${mark}`
  })
  return [
    '已有任务：',
    lines.length === 0 ? '（空）' : lines.join('\n'),
    '',
    `本轮用户输入：${draft.prompt}`,
    `本轮助手收尾：${draft.assistant || '（无）'}`,
    '',
    '判断这一轮属于哪个已有任务，或给出新任务。'
  ].join('\n')
}

/** State store per session, persisted next to the DSH home so restarts keep it. */
export class ModelLedger {
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.enabled = config.enabled !== false
    this.provider = typeof config.provider === 'string' ? config.provider : 'deepseek-account'
    this.model = typeof config.model === 'string' ? config.model : 'deepseek-flash'
    this.maxTokens = Number.isInteger(config.maxTokens) ? config.maxTokens : 320
    this.timeoutMs = Number.isInteger(config.timeoutMs) ? config.timeoutMs : 25000
    /** How many tasks the prompt lists (the ledger itself keeps up to MAX_TASKS). */
    this.promptTasks = Number.isInteger(config.promptTasks) && config.promptTasks > 0 ? config.promptTasks : 12
    /** Assistant excerpt sent with each turn. */
    this.excerptChars = Number.isInteger(config.excerptChars) && config.excerptChars > 0 ? config.excerptChars : 240
    /** Transcript budget for the one-shot history backfill. */
    this.digestChars = Number.isInteger(config.digestChars) && config.digestChars > 0 ? config.digestChars : 4000
    /** Extra attempts when the model answers with something that is not a verdict. */
    this.retries = Number.isInteger(config.retries) && config.retries >= 0 ? Math.min(config.retries, 3) : 1
    this.log = typeof ctx.logger?.warn === 'function' ? ctx.logger.warn.bind(ctx.logger) : () => {}
    /** Optional sink for the plugin's own diagnostic file (the host log is not readable). */
    this.trace = typeof ctx.trace === 'function' ? ctx.trace : () => {}
    this.dir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'state', 'goal-ledger')
    this.sessions = new Map()
    /** Long-poll waiters keyed by session id. */
    this.waiters = new Map()
  }

  /** Load (or lazily create) the ledger for one session. */
  stateOf(sessionId) {
    let state = this.sessions.get(sessionId)
    if (state !== undefined) return state
    state = { turn: 0, tasks: [], currentId: null, draft: null, pending: false, rev: 0 }
    try {
      const raw = fs.readFileSync(path.join(this.dir, `${sessionId}.json`), 'utf8')
      const stored = JSON.parse(raw)
      if (stored !== null && Array.isArray(stored.tasks)) {
        state.turn = Number.isInteger(stored.turn) ? stored.turn : 0
        state.tasks = stored.tasks
        state.currentId = typeof stored.currentId === 'string' ? stored.currentId : null
        // Migration: ledgers written before the quest-log fields existed have no
        // `done`; anything that is not the current task was, by definition, left.
        for (const task of state.tasks) {
          if (task.done === undefined) task.done = task.id !== state.currentId
          if (task.skipped === undefined) task.skipped = false
          if (task.summary === undefined) task.summary = task.done ? (task.progress ?? '') : ''
        }
      }
    } catch {}
    this.sessions.set(sessionId, state)
    return state
  }

  save(sessionId, state) {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(path.join(this.dir, `${sessionId}.json`), JSON.stringify({
        turn: state.turn,
        tasks: state.tasks,
        currentId: state.currentId
      }), 'utf8')
    } catch {}
    // Every persisted change wakes the long polls watching this session, so the
    // card updates on the next paint instead of on the next timer tick.
    state.rev = (state.rev ?? 0) + 1
    this.notify(sessionId)
  }

  /** Resolve every open long poll for one session. */
  notify(sessionId) {
    const waiting = this.waiters.get(sessionId)
    if (waiting === undefined) return
    this.waiters.delete(sessionId)
    for (const resolve of waiting) resolve()
  }

  /** Resolve as soon as the ledger is newer than `since`, or after `timeoutMs`. */
  waitFor(sessionId, since, timeoutMs) {
    const state = this.stateOf(sessionId)
    if ((state.rev ?? 0) > since) return Promise.resolve()
    return new Promise((resolve) => {
      let set = this.waiters.get(sessionId)
      if (set === undefined) {
        set = new Set()
        this.waiters.set(sessionId, set)
      }
      const done = () => {
        set.delete(done)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, Math.max(0, timeoutMs))
      set.add(done)
    })
  }

  /** The payload the card polls for, with the revision it should echo back. */
  viewFor(sessionId) {
    const state = this.stateOf(sessionId)
    return { rev: state.rev ?? 0, ...this.viewOf(state) }
  }

  /**
   * A session was opened. If it arrives with history and no ledger, summarise the
   * whole log once — the incremental pipeline only sees turns that happen while
   * the plugin is loaded, so without this a resumed conversation shows nothing
   * until its next turn.
   */
  onSessionCreated(session) {
    if (!this.enabled) return
    const sessionId = session?.id ?? session?.sessionId
    if (typeof sessionId !== 'string') return
    const state = this.stateOf(sessionId)
    if (state.tasks.length > 0 || state.backfilled === true) return
    const log = Array.isArray(session?.log) ? session.log : []
    if (log.length === 0) return
    const digest = buildDigest(log, this.digestChars)
    if (digest === '') return
    state.backfilled = true
    void this.backfill(sessionId, state, digest)
  }

  /** One call over the whole log; replaces the (empty) ledger with a task tree. */
  async backfill(sessionId, state, digest) {
    try {
      const text = await this.complete(`把下面这段对话归纳成任务清单。\n\n${digest}`, sessionId, BACKFILL_SYSTEM)
      if (text === null) return
      const items = parseTaskList(text)
      if (items === null) {
        this.trace(`backfill unparseable: ${short(text, 120)}`)
        return
      }
      const ids = items.map((_, index) => `b${index + 1}`)
      state.tasks = items.map((item, index) => ({
        id: ids[index],
        label: item.name,
        progress: item.progress,
        parentId: item.parentIndex !== null && item.parentIndex < index ? ids[item.parentIndex] : null,
        firstTurn: 0,
        lastTurn: state.turn,
        turns: 0,
        done: index < items.length - 1,
        skipped: false,
        summary: index < items.length - 1 ? item.progress : ''
      }))
      state.currentId = ids[ids.length - 1] ?? null
      this.save(sessionId, state)
      this.trace(`backfilled ${state.tasks.length} tasks for ${sessionId}`)
    } catch (error) {
      this.trace(`backfill failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** Fold one committed session event; a finished turn schedules one model call. */
  onEvent(session, event) {
    if (!this.enabled) return
    const sessionId = session?.id ?? session?.sessionId
    if (typeof sessionId !== 'string') return
    const state = this.stateOf(sessionId)
    switch (event.type) {
      case 'turn/start':
        state.turn = event.data?.turn ?? state.turn
        state.draft = { turn: state.turn, prompt: '', assistant: '' }
        return
      case 'user/message': {
        if (event.data?.source?.kind !== 'user') return
        if (state.draft === null || state.draft.prompt !== '') return
        const text = (event.data.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (text !== '') state.draft.prompt = short(text, 500)
        return
      }
      case 'assistant/message': {
        if (state.draft === null) return
        const text = (event.data?.message?.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join(' ')
        if (text.trim() !== '') state.draft.assistant = short(text, this.excerptChars)
        return
      }
      case 'turn/end': {
        const draft = state.draft
        if (draft === null || draft.prompt === '') {
          state.draft = null
          return
        }
        state.draft = null
        void this.decide(sessionId, state, draft)
        return
      }
      default: return
    }
  }

  /** One completion per turn, serialised per session; failures are logged, never thrown. */
  async decide(sessionId, state, draft) {
    if (state.pending) {
      state.draft2 = state.draft2 ?? []
      state.draft2.push(draft)
      return
    }
    state.pending = true
    try {
      const prompt = buildPrompt(state.tasks, state.currentId, draft, this.promptTasks)
      let verdict = null
      let text = null
      // One retry with a pointed reminder: the usual failure is a chatty preamble
      // around the JSON, not a broken model.
      for (let attempt = 0; attempt <= this.retries; attempt += 1) {
        text = await this.complete(
          attempt === 0 ? prompt : `${prompt}\n\n只输出那一行 JSON，不要任何其他字符。`,
          sessionId
        )
        if (text === null) return
        verdict = parseVerdict(text)
        if (verdict !== null) break
        this.trace(`model verdict unparseable (attempt ${attempt + 1}): ${short(text, 120)}`)
      }
      if (verdict === null) {
        state.error = '模型输出不是判定 JSON'
        this.log('[goal-ledger] model output was not a verdict: %s', short(text, 120))
        return
      }
      state.error = null
      this.applyVerdict(state, verdict, draft.turn)
      this.save(sessionId, state)
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error)
      this.log('[goal-ledger] model decision failed: %s', state.error)
      this.trace(`model decision failed: ${state.error}`)
    } finally {
      state.pending = false
      const queued = state.draft2?.shift()
      if (queued !== undefined) void this.decide(sessionId, state, queued)
      else delete state.draft2
    }
  }

  applyVerdict(state, verdict, turn) {
    const parent = verdict.parentId === null ? null : state.tasks.find((task) => task.id === verdict.parentId) ?? null
    const current = state.tasks.find((task) => task.id === state.currentId) ?? null

    if (verdict.rel === 'continue' && current !== null) {
      current.progress = verdict.progress || current.progress
      current.lastTurn = turn
      current.turns += 1
      if (verdict.name !== '') current.label = verdict.name
      return
    }

    // Leaving a task closes it. The model says whether it was actually finished
    // and gives the one-line conclusion for it; fall back to the last progress
    // when the model did not supply one.
    if (current !== null) {
      current.done = verdict.prevDone !== false
      current.skipped = verdict.prevDone === false
      current.summary = verdict.prevSummary || current.progress || ''
    }

    const id = `m${state.tasks.length + 1}`
    const node = {
      id,
      label: verdict.name || short('未命名任务', 12),
      progress: verdict.progress,
      parentId: verdict.rel === 'root' ? null : (parent ?? current)?.id ?? null,
      firstTurn: turn,
      lastTurn: turn,
      turns: 1,
      done: false,
      summary: ''
    }
    state.tasks.push(node)
    if (state.tasks.length > MAX_TASKS) state.tasks = state.tasks.slice(-MAX_TASKS)
    state.currentId = id
  }

  /** Stream one completion and return its text, or null when the route is unusable. */
  async complete(prompt, sessionId, system = SYSTEM) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const call = await this.ctx.llm.prepareCall(
        { provider: this.provider, model: this.model, maxTokens: this.maxTokens },
        controller.signal,
        (controls) => controls
      )
      const messages = [{
        role: 'user',
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'plugin:goal-ledger' }
      }]
      const options = {
        ...call.config,
        messages,
        system,
        sessionId,
        purpose: 'goal-ledger',
        signal: controller.signal
      }
      let out = ''
      for await (const chunk of call.stream(options)) {
        if (chunk.type === 'text-delta') out += chunk.text
        if (chunk.type === 'finish' && chunk.reason?.kind !== 'stop') break
      }
      return out
    } finally {
      clearTimeout(timer)
    }
  }

  /** Build the client view: the same shape the projection serves. */
  viewOf(state) {
    const nodes = new Map()
    for (const task of state.tasks) {
      nodes.set(task.id, {
        id: task.id,
        label: task.label,
        progress: task.progress ?? '',
        relation: task.parentId === null ? 'root' : 'refine',
        parentId: task.parentId ?? null,
        firstTurn: task.firstTurn,
        lastTurn: task.lastTurn,
        turns: task.turns,
        active: task.id === state.currentId,
        done: task.done === true,
        skipped: task.skipped === true,
        summary: task.summary ?? '',
        children: []
      })
    }
    const roots = []
    for (const node of nodes.values()) {
      const parent = node.parentId === null ? undefined : nodes.get(node.parentId)
      if (parent === undefined || parent.id === node.id) roots.push(node)
      else parent.children.push(node)
    }

    // The task in progress is never hidden: open it and every ancestor so the
    // card always shows where the session is without a click.
    let cursor = state.currentId
    const walked = new Set()
    while (cursor !== null && !walked.has(cursor)) {
      const node = nodes.get(cursor)
      if (node === undefined) break
      node.open = true
      walked.add(cursor)
      cursor = node.parentId
    }
    const main = state.tasks.find((task) => task.id === state.currentId) ?? null
    return {
      source: 'model',
      error: state.error ?? null,
      turn: state.turn,
      main: main === null ? null : { id: main.id, label: main.label, progress: main.progress ?? '', firstTurn: main.firstTurn, turns: main.turns, lastTurn: main.lastTurn },
      first: state.tasks[0] === undefined ? null : { label: state.tasks[0].label, firstTurn: state.tasks[0].firstTurn },
      tasks: roots,
      total: state.tasks.length,
      drift: main === null ? 0 : Math.max(0, state.turn - main.lastTurn),
      draft: null
    }
  }
}

