import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRenewCertsJobHandler } from '../routes/renew-certs-job.js'

function mockReq (headers = {}) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]))
  return {
    headers: normalized,
    get (name) {
      return normalized[name.toLowerCase()]
    }
  }
}

function mockRes () {
  return {
    statusCode: null,
    body: null,
    status (code) {
      this.statusCode = code
      return this
    },
    json (body) {
      this.body = body
      return this
    }
  }
}

async function callHandler (handler, headers = {}) {
  const res = mockRes()
  const errors = []
  await handler(mockReq(headers), res, (err) => errors.push(err))
  return { res, errors }
}

const successSummary = {
  checked: 1,
  valid: 1,
  expiring: 0,
  expired: 0,
  malformed_missing: 0,
  renewed: 0,
  failed: 0
}

describe('renew certs scheduler job route', () => {
  it('returns 503 when the environment secret is missing', async () => {
    let calls = 0
    const handler = createRenewCertsJobHandler({
      getSecret: () => '',
      renewExpiring: async () => {
        calls++
        return successSummary
      }
    })

    const { res, errors } = await callHandler(handler, { Authorization: 'Bearer supplied-secret' })

    assert.equal(res.statusCode, 503)
    assert.deepEqual(res.body, { error: 'Renewal secret is not configured' })
    assert.equal(calls, 0)
    assert.deepEqual(errors, [])
  })

  it('returns 401 for a bad secret', async () => {
    let calls = 0
    const handler = createRenewCertsJobHandler({
      getSecret: () => 'correct-secret',
      renewExpiring: async () => {
        calls++
        return successSummary
      }
    })

    const { res, errors } = await callHandler(handler, { Authorization: 'Bearer wrong-secret' })

    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.body, { error: 'Unauthorized' })
    assert.equal(calls, 0)
    assert.deepEqual(errors, [])
  })

  it('returns renewal summary on success', async () => {
    const handler = createRenewCertsJobHandler({
      getSecret: () => 'correct-secret',
      renewExpiring: async () => successSummary
    })

    const { res, errors } = await callHandler(handler, { Authorization: 'Bearer correct-secret' })

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, successSummary)
    assert.deepEqual(errors, [])
  })

  it('returns 500 when the renewal summary has failures', async () => {
    const failedSummary = { ...successSummary, valid: 0, renewed: 0, failed: 1 }
    const handler = createRenewCertsJobHandler({
      getSecret: () => 'correct-secret',
      renewExpiring: async () => failedSummary
    })

    const { res, errors } = await callHandler(handler, { Authorization: 'Bearer correct-secret' })

    assert.equal(res.statusCode, 500)
    assert.deepEqual(res.body, failedSummary)
    assert.deepEqual(errors, [])
  })

  it('returns 409 while a renewal is already running', async () => {
    let releaseRenewal
    const renewalStarted = new Promise(resolve => {
      releaseRenewal = resolve
    })
    const handler = createRenewCertsJobHandler({
      getSecret: () => 'correct-secret',
      renewExpiring: async () => {
        await renewalStarted
        return successSummary
      }
    })

    const first = callHandler(handler, { Authorization: 'Bearer correct-secret' })
    const second = await callHandler(handler, { Authorization: 'Bearer correct-secret' })
    releaseRenewal()
    const firstResult = await first

    assert.equal(second.res.statusCode, 409)
    assert.deepEqual(second.res.body, { error: 'Renewal already running' })
    assert.equal(firstResult.res.statusCode, 200)
    assert.deepEqual(firstResult.errors, [])
    assert.deepEqual(second.errors, [])
  })
})
