import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createOauthRegisterHandler } from '../routes/oauth.js'

function mockResponse () {
  return {
    statusCode: 200,
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

function waitForFireAndForget () {
  return new Promise(resolve => setImmediate(resolve))
}

describe('oauthRegister', () => {
  it('logs async cert provisioning failures with the GitHub username', async () => {
    const errors = []
    const handler = createOauthRegisterHandler({
      fetch: async () => ({
        ok: true,
        json: async () => ({ login: 'octocat' })
      }),
      createDnsRecord: async () => {},
      provisionUserCert: async () => {
        throw new Error('certbot unavailable')
      },
      log: {
        error: (...args) => errors.push(args.join(' '))
      }
    })
    const res = mockResponse()

    await handler({ body: { access_token: 'token', ip: '203.0.113.7' } }, res, assert.fail)
    await waitForFireAndForget()

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, {
      ok: true,
      username: 'octocat',
      subdomain: '*.octocat.jump.sh'
    })
    assert.deepEqual(errors, ['Cert provisioning failed for octocat: certbot unavailable'])
  })
})
