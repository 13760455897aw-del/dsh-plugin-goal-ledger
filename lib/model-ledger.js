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
  '{"rel":"continue|child|root","parentId":"已有任务id或null","name":"任务名","progress":"这一轮的进展，≤30字","prevDone":true}',
  'prevDone 表示上一件事是否真的做完了：换了方向、但上一件没做完，填 false。',
].join('\n')

/** Cap on the ledger kept per session (memory + payload). */
const MAX_TASKS = 60
/** Assistant excerpt fed to the model. */
const EXCERPT = 600

function short(text, limit) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
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
    return { rel, name, progress, parentId, prevDone: value.prevDone !== false }
  } catch {
    return null
  }
}

/**
 * Build the model input: existing task ids and names, the turn's prompt, and the
 * assistant's closing words.
 */
export function buildPrompt(tasks, currentId, draft) {
  const lines = tasks.slice(-MAX_TASKS).map((task) => {
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
    this.log = typeof ctx.logger?.warn === 'function' ? ctx.logger.warn.bind(ctx.logger) : () => {}
    /** Optional sink for the plugin's own diagnostic file (the host log is not readable). */
    this.trace = typeof ctx.trace === 'function' ? ctx.trace : () => {}
    this.dir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'state', 'goal-ledger')
    this.sessions = new Map()
  }

  /** Load (or lazily create) the ledger for one session. */
  stateOf(sessionId) {
    let state = this.sessions.get(sessionId)
    if (state !== undefined) return state
    state = { turn: 0, tasks: [], currentId: null, draft: null, pending: false }
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
        if (text.trim() !== '') state.draft.assistant = short(text, EXCERPT)
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
      const prompt = buildPrompt(state.tasks, state.currentId, draft)
      const text = await this.complete(prompt, sessionId)
      if (text === null) return
      const verdict = parseVerdict(text)
      if (verdict === null) {
        state.error = '模型输出不是判定 JSON'
        this.log('[goal-ledger] model output was not a verdict: %s', short(text, 120))
        this.trace(`model verdict unparseable: ${short(text, 120)}`)
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
    // (crossed off) or merely dropped for something else (left open, marked as
    // skipped); either way its last progress line becomes its one-line summary.
    if (current !== null) {
      current.done = verdict.prevDone !== false
      current.skipped = verdict.prevDone === false
      current.summary = current.progress ?? ''
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
  async complete(prompt, sessionId) {
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
        system: SYSTEM,
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

