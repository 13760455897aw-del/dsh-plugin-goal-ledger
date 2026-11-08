/**
 * Host-half smoke test: the rule unit always registers; the model pipeline and
 * its route attach only through `ctx.inject` when both services exist (the
 * isolation-respecting path), and the route answers with the served view.
 */
import assert from 'node:assert/strict'
import { apply, inject, name } from '../index.js'

assert.equal(name, 'goal-ledger')
assert.deepEqual(inject, ['sessionProjections'])

/** Minimal cordis-ish context with optional-service injection. */
function makeCtx(services = {}) {
  const registered = []
  const listeners = []
  const logger = { warn() {}, info() {} }

  const base = {
    sessionProjections: { register: (definition) => registered.push(definition) },
    // Mirrors cordis: the callback runs only when every requested service exists.
    inject: (deps, callback) => {
      const missing = deps.filter((dep) => services[dep] === undefined)
      if (missing.length > 0) return
      callback({ ...base, ...services })
    },
    on: (event, handler) => {
      listeners.push({ event, handler })
    },
    effect: (fn) => {
      const dispose = fn()
      if (typeof dispose === 'function') dispose()
    },
    logger,
  }
  return { ctx: base, registered, listeners }
}

// Without the optional services: the rule unit registers, nothing else runs.
{
  const { ctx, registered, listeners } = makeCtx()
  apply(ctx, {})
  assert.equal(registered.length, 1)
  assert.equal(registered[0].key, 'goalLedger')
  assert.equal(listeners.length, 0)
}

// With both services: the pipeline listens and the same-origin route is served.
{
  const pushed = []
  const services = {
    llm: { prepareCall: async () => ({ config: {}, stream: async function* () {} }) },
    webServer: {
      register: (definition) => {
        pushed.push(definition)
        return () => {}
      },
    },
  }
  const { ctx, registered, listeners } = makeCtx(services)
  apply(ctx, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(registered.length, 1)
  assert.equal(listeners.length, 2)
  assert.equal(listeners[0].event, 'session/event')
  assert.equal(listeners[1].event, 'session/created')
  assert.equal(pushed.length, 2)
  assert.equal(pushed[0].kind, 'exact')
  assert.equal(pushed[0].path, '/goal-ledger/state')
  assert.equal(pushed[1].path, '/goal-ledger/ping')

  const chunks = []
  const res = {
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(body) {
      chunks.push(body)
    },
  }
  pushed[0].handler({ url: '/goal-ledger/state?session=s1' }, res)
  assert.equal(res.status, 200)
  const body = JSON.parse(chunks[0])
  assert.equal(body.source, 'model')
  assert.deepEqual(body.tasks, [])
}

// A broken registration must not escape apply().
{
  const services = {
    llm: {},
    webServer: {
      register() {
        throw new Error('route conflict')
      },
    },
  }
  const { ctx } = makeCtx(services)
  assert.doesNotThrow(() => apply(ctx, {}))
}

console.log('host half smoke test passed')
