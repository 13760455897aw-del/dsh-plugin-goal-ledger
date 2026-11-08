/**
 * 目标日志 / Goal Ledger — host half.
 *
 * Two layers:
 *   1. the rule projection (`goalLedger`) — instant, zero-cost, always available;
 *   2. the model ledger (`ModelLedger`) — one small completion per finished turn,
 *      served at `GET /goal-ledger/state?session=<id>` and preferred by the card
 *      when it has something to say.
 *
 * Model-inert towards the conversation: nothing here injects context, registers a
 * tool, or writes to the session log. The only reader is our own UI.
 *
 * Defensive by construction: the optional services are attached through
 * `ctx.inject`, so the rule layer works even when the model pipeline cannot run,
 * and every failure is written to a diagnostic log instead of thrown — this
 * plugin once took a boot down with it, and the host log is not readable from
 * outside, so the plugin keeps its own.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createLedgerDefinition } from './lib/ledger.js'
import { ModelLedger } from './lib/model-ledger.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'goal-ledger'

/** The projection registry is required; the model pipeline attaches optionally. */
export const inject = ['sessionProjections']

/** Append one line to the plugin's own diagnostic log (never throws). */
export function diag(line) {
  try {
    const dir = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'state', 'goal-ledger')
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, 'diag.log'), `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {}
}

/**
 * Register the rule unit, then attach the model pipeline + its route when the
 * LLM and web-server services are available.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{enabled?: boolean, provider?: string, model?: string, maxTokens?: number, timeoutMs?: number}} [config]
 */
export function apply(ctx, config = {}) {
  diag(`apply start pid=${process.pid}`)

  try {
    ctx.sessionProjections.register(createLedgerDefinition())
    diag('rule projection registered')
  } catch (error) {
    diag(`rule projection failed: ${String(error)}`)
  }

  if (config.enabled === false) {
    diag('disabled by config')
    return
  }


  try {
    diag(`ctx.inject type=${typeof ctx.inject}`)
    // `ctx.inject` (not `ctx.get`) is the isolation-respecting way to use optional
    // services: the callback runs once both exist, and the plugin stays inert
    // otherwise. `ctx.get` returns nothing for services outside the inject list.
    ctx.inject(['llm', 'webServer'], (inner) => {
      diag('inject callback fired')

      const ledger = new ModelLedger({ llm: inner.llm, logger: inner.logger, trace: diag }, config)

      // The route is registered **first** and doubles as the single-instance lock:
      // HMR can re-apply this plugin, and a second live attach would add a second
      // `session/event` listener, spending one model call per listener on every
      // finished turn. Whichever attach owns the route owns the listener.
      let dispose
      try {
        dispose = inner.webServer.register({
          kind: 'exact',
          path: '/goal-ledger/state',
          handler: (req, res) => {
            try {
              const url = new URL(req.url ?? '/', 'http://localhost')
              const sessionId = url.searchParams.get('session')
              if (sessionId === null) {
                res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: 'session required' }))
                return
              }
              const state = ledger.stateOf(sessionId)
              res.writeHead(200, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store'
              })
              res.end(JSON.stringify(ledger.viewOf(state)))
            } catch (error) {
              res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
              res.end(JSON.stringify({ error: String(error) }))
            }
          }
        })
      } catch (error) {
        diag(`route conflict; a live instance already owns it: ${String(error)}`)
        return
      }
      inner.effect(() => dispose)
      diag('route /goal-ledger/state registered')

      // Click beacon: the chip reports whether a pointer event actually reached it,
      // which is the only way to tell a drag-region swallow from a render failure.
      try {
        const disposePing = inner.webServer.register({
          kind: 'exact',
          path: '/goal-ledger/ping',
          handler: (req, res) => {
            try {
              const url = new URL(req.url ?? '/', 'http://localhost')
              const mark = url.searchParams.get('m') ?? '?'
              const width = url.searchParams.get('w')
              const height = url.searchParams.get('h')
              const size = width === null ? '' : ` w=${width} h=${height}`
              diag(`ping session=${url.searchParams.get('session')} m=${mark}${size}`)
            } catch {}
            res.writeHead(204, { 'cache-control': 'no-store' })
            res.end()
          }
        })
        inner.effect(() => disposePing)
        diag('route /goal-ledger/ping registered')
      } catch (error) {
        diag(`ping route not registered: ${String(error)}`)
      }

      inner.on('session/event', (session, event) => {
        try {
          ledger.onEvent(session, event)
        } catch (error) {
          diag(`fold failed: ${String(error)}`)
        }
      })
      diag('session/event listener attached')

      // Sessions arrive with their history already loaded; summarise it once so a
      // resumed conversation has a ledger before its next turn happens.
      inner.on('session/created', (session) => {
        try {
          ledger.onSessionCreated(session)
        } catch (error) {
          diag(`backfill fold failed: ${String(error)}`)
        }
      })
      diag('session/created listener attached')
    })
  } catch (error) {
    diag(`inject attach failed: ${String(error)}`)
  }
}
