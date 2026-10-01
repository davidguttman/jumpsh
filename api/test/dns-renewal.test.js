import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { DNS } from '@google-cloud/dns'
import { listRecordsByPrefix } from '../services/dns.js'
import { createRenewExpiring } from '../jobs/renew.js'
import { createRenewCertsJobHandler } from '../routes/renew-certs-job.js'

describe('certificate DNS enumeration', () => {
  it('enumerates TXT records without an invalid type-only API query and preserves prefix filtering', async (t) => {
    const calls = []
    const records = [
      { name: '_cert.alice.jump.sh.', type: 'TXT' },
      { name: '_cert.bob.jump.sh.', type: 'TXT' },
      { name: '_key.alice.jump.sh.', type: 'TXT' },
      { name: '_certificate.alice.jump.sh.', type: 'TXT' },
      { name: 'other._cert.jump.sh.', type: 'TXT' },
      { name: '_cert.alice.jump.sh.', type: 'A' }
    ]
    t.mock.method(DNS.prototype, 'zone', () => ({
      getRecords: async (query) => {
        calls.push(query)
        // The SDK's string overload filters types locally, unlike { type }.
        if (query && typeof query === 'object' && query.type && !query.name) {
          throw new Error('Type parameter is only allowed if name parameter is specified')
        }
        return [typeof query === 'string' ? records.filter(r => r.type === query) : records]
      }
    }))

    assert.deepEqual(await listRecordsByPrefix('_cert'), records.slice(0, 2))
    assert.equal(calls.length, 1)
  })

  it('uses SDK pagination and local TXT filtering across mixed-record pages', async (t) => {
    const queries = []
    t.mock.method(DNS.prototype, 'request', (request, callback) => {
      queries.push(request.qs)
      assert.equal(request.qs.type, undefined)
      assert.equal(request.qs.name, undefined)
      const response = request.qs.pageToken
        ? { rrsets: [{ name: '_cert.bob.jump.sh.', type: 'TXT', ttl: 60, rrdatas: ['bob'] }] }
        : {
            rrsets: [
              { name: '_cert.alice.jump.sh.', type: 'TXT', ttl: 60, rrdatas: ['alice'] },
              { name: '_cert.other.jump.sh.', type: 'A', ttl: 60, rrdatas: ['127.0.0.1'] },
              { name: '_key.alice.jump.sh.', type: 'TXT', ttl: 60, rrdatas: ['key'] }
            ],
            nextPageToken: 'page-two'
          }
      callback(null, response)
    })

    const records = await listRecordsByPrefix('_cert')
    assert.deepEqual(records.map(r => r.name), ['_cert.alice.jump.sh.', '_cert.bob.jump.sh.'])
    assert.equal(queries.length, 2)
    assert.equal(queries[1].pageToken, 'page-two')
  })

  it('rejects DNS listing errors rather than reporting no certificates', async (t) => {
    const failure = new Error('DNS listing unavailable')
    t.mock.method(DNS.prototype, 'zone', () => ({ getRecords: async () => { throw failure } }))
    await assert.rejects(listRecordsByPrefix('_cert'), err => err === failure)
  })

  it('forwards a DNS listing failure through renewal to endpoint error middleware and unlocks retries', async (t) => {
    const failure = new Error('DNS listing unavailable')
    t.mock.method(DNS.prototype, 'zone', () => ({ getRecords: async () => { throw failure } }))
    const provisionCert = mock.fn()
    const handler = createRenewCertsJobHandler({
      getSecret: () => 'test-secret',
      renewExpiring: createRenewExpiring({ listRecordsByPrefix, provisionCert })
    })
    const req = { get: () => 'Bearer test-secret' }
    const res = { status: mock.fn(() => res), json: mock.fn(() => res) }
    const next = mock.fn()

    await handler(req, res, next)
    await handler(req, res, next)

    assert.equal(next.mock.callCount(), 2)
    assert.equal(next.mock.calls[0].arguments[0], failure)
    assert.equal(next.mock.calls[1].arguments[0], failure)
    assert.equal(res.json.mock.callCount(), 0)
    assert.equal(provisionCert.mock.callCount(), 0)
  })
})
