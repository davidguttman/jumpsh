import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { certificateStatusFromBase64 } from '../services/cert-validity.js'

const execFileAsync = promisify(execFile)

let tmpDir
let certB64

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'jump-cert-test-'))
  const keyPath = join(tmpDir, 'key.pem')
  const certPath = join(tmpDir, 'cert.pem')

  await execFileAsync('openssl', [
    'req',
    '-x509',
    '-newkey', 'rsa:2048',
    '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    '-days', '365',
    '-subj', '/CN=test.jump.sh'
  ])

  const certPem = await readFile(certPath, 'utf8')
  certB64 = Buffer.from(certPem).toString('base64')
})

after(async () => {
  if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
})

describe('certificateStatusFromBase64', () => {
  it('classifies a missing certificate', () => {
    assert.deepEqual(certificateStatusFromBase64(null), {
      status: 'missing',
      ready: false,
      expires_at: null
    })
  })

  it('classifies malformed certificate data', () => {
    assert.deepEqual(certificateStatusFromBase64(Buffer.from('not a certificate').toString('base64')), {
      status: 'malformed',
      ready: false,
      expires_at: null
    })
  })

  it('classifies a currently valid certificate', () => {
    const status = certificateStatusFromBase64(certB64)

    assert.equal(status.status, 'valid')
    assert.equal(status.ready, true)
    assert.match(status.expires_at, /^\d{4}-\d{2}-\d{2}T/)
  })

  it('classifies a valid certificate as expiring inside the warning window', () => {
    const valid = certificateStatusFromBase64(certB64)
    const expiresAt = new Date(valid.expires_at)
    const oneDayBeforeExpiry = new Date(expiresAt.getTime() - 24 * 60 * 60 * 1000)

    const status = certificateStatusFromBase64(certB64, { now: oneDayBeforeExpiry })

    assert.equal(status.status, 'expiring')
    assert.equal(status.ready, true)
    assert.equal(status.expires_at, valid.expires_at)
  })

  it('classifies a certificate as expired after notAfter', () => {
    const valid = certificateStatusFromBase64(certB64)
    const expiresAt = new Date(valid.expires_at)
    const oneMillisecondAfterExpiry = new Date(expiresAt.getTime() + 1)

    const status = certificateStatusFromBase64(certB64, { now: oneMillisecondAfterExpiry })

    assert.equal(status.status, 'expired')
    assert.equal(status.ready, false)
    assert.equal(status.expires_at, valid.expires_at)
  })
})
