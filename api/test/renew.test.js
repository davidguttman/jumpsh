import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRenewExpiring } from '../jobs/renew.js'

function captureLog () {
  const lines = []
  return {
    lines,
    log: (...args) => lines.push(args.join(' ')),
    error: (...args) => lines.push(args.join(' '))
  }
}

describe('renewExpiring', () => {
  it('reports summary counts and renews expiring, expired, malformed, and missing certs', async () => {
    const logger = captureLog()
    const provisioned = []
    const certs = new Map([
      ['_cert.alice.test.jump.sh.', 'valid-cert'],
      ['_cert.bob.test.jump.sh.', 'expiring-cert'],
      ['_cert.carol.test.jump.sh.', 'malformed-cert'],
      ['_cert.erin.test.jump.sh.', 'expired-cert']
    ])

    const renewExpiring = createRenewExpiring({
      domain: 'test.jump.sh',
      log: logger,
      listRecordsByPrefix: async () => [
        { name: '_cert.alice.test.jump.sh.' },
        { name: '_cert.bob.test.jump.sh.' },
        { name: '_cert.carol.test.jump.sh.' },
        { name: '_cert.dana.test.jump.sh.' },
        { name: '_cert.erin.test.jump.sh.' },
        { name: '_key.alice.test.jump.sh.' },
        { name: '_cert.notjump.example.com.' }
      ],
      userRecordName: (prefix, username) => `${prefix}.${username}.test.jump.sh.`,
      getTxtRecord: async (name) => certs.get(name) || null,
      getCertificateStatus: (certB64) => {
        if (certB64 === 'valid-cert') return { status: 'valid', ready: true, expires_at: '2027-06-01T00:00:00.000Z' }
        if (certB64 === 'expiring-cert') return { status: 'expiring', ready: true, expires_at: '2026-06-15T00:00:00.000Z' }
        if (certB64 === 'expired-cert') return { status: 'expired', ready: false, expires_at: '2026-05-01T00:00:00.000Z' }
        if (certB64 === 'malformed-cert') return { status: 'malformed', ready: false, expires_at: null }
        return { status: 'missing', ready: false, expires_at: null }
      },
      provisionCert: async (username) => {
        provisioned.push(username)
        if (username === 'erin') throw new Error('certbot failed')
      }
    })

    const summary = await renewExpiring()

    assert.deepEqual(summary, {
      checked: 5,
      valid: 1,
      expiring: 1,
      expired: 1,
      malformed_missing: 2,
      renewed: 3,
      failed: 1
    })
    assert.deepEqual(provisioned, ['bob', 'carol', 'dana', 'erin'])
    assert(logger.lines.some(line => line.includes('Renewal run summary') && line.includes('"checked":5')))
    assert(logger.lines.some(line => line.includes('Renewal failed') && line.includes('"username":"erin"') && line.includes('"status":"expired"') && line.includes('certbot failed')))
  })
})
