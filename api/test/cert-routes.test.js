import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createStatusHandler } from '../routes/status.js'
import { createCertsHandler } from '../routes/certs.js'

const certB64 = Buffer.from('-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n').toString('base64')
const keyB64 = Buffer.from('fake key').toString('base64')

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

describe('status route certificate readiness', () => {
  it('reports TXT-backed expired certs as not ready', async () => {
    const handler = createStatusHandler({
      getTxtRecord: async () => certB64,
      getARecord: async () => '203.0.113.5',
      getCertificateStatus: () => ({
        status: 'expired',
        ready: false,
        expires_at: '2026-06-01T00:00:00.000Z'
      })
    })
    const res = mockResponse()

    await handler({ query: { username: 'davidguttman' } }, res)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, {
      username: 'davidguttman',
      subdomain: '*.davidguttman.jump.sh',
      ready: false,
      cert_status: 'expired',
      expires_at: '2026-06-01T00:00:00.000Z',
      ip: '203.0.113.5'
    })
  })
})

describe('certs route certificate readiness', () => {
  it('returns stale expired metadata without stale cert/key material', async () => {
    const handler = createCertsHandler({
      getTxtRecord: async (name) => name.startsWith('_cert.') ? certB64 : keyB64,
      getCertificateStatus: () => ({
        status: 'expired',
        ready: false,
        expires_at: '2026-06-01T00:00:00.000Z'
      })
    })
    const res = mockResponse()

    await handler({ query: { username: 'davidguttman' } }, res)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, {
      ready: false,
      cert_status: 'expired',
      expires_at: '2026-06-01T00:00:00.000Z'
    })
    assert.equal('cert_pem' in res.body, false)
    assert.equal('key_pem' in res.body, false)
  })

  it('returns cert/key material only for valid non-expired certs with keys', async () => {
    const handler = createCertsHandler({
      getTxtRecord: async (name) => name.startsWith('_cert.') ? certB64 : keyB64,
      getCertificateStatus: () => ({
        status: 'valid',
        ready: true,
        expires_at: '2027-06-01T00:00:00.000Z'
      })
    })
    const res = mockResponse()

    await handler({ query: { username: 'davidguttman' } }, res)

    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.body, {
      ready: true,
      cert_status: 'valid',
      expires_at: '2027-06-01T00:00:00.000Z',
      cert_pem: Buffer.from(certB64, 'base64').toString('utf8'),
      key_pem: 'fake key'
    })
  })
})
