import { execFile } from 'child_process'
import { writeFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { getTxtRecord, userRecordName } from '../services/dns.js'
import { provisionCert } from '../services/certbot.js'

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function parseCertExpiry(pemB64) {
  return new Promise((resolve, reject) => {
    const pem = Buffer.from(pemB64, 'base64').toString('utf8')

    mkdtemp(join(tmpdir(), 'jump-cert-')).then(dir => {
      const certPath = join(dir, 'cert.pem')
      writeFile(certPath, pem).then(() => {
        execFile('openssl', ['x509', '-noout', '-enddate', '-in', certPath], (err, stdout) => {
          rm(dir, { recursive: true, force: true }).catch(() => {})
          if (err) return reject(err)
          const match = stdout.match(/notAfter=(.+)/)
          if (!match) return reject(new Error('Could not parse cert expiry'))
          resolve(new Date(match[1].trim()))
        })
      })
    }).catch(reject)
  })
}

export async function provisionUserCert(username) {
  const certB64 = await getTxtRecord(userRecordName('_cert', username))

  if (certB64) {
    try {
      const expiry = await parseCertExpiry(certB64)
      const remaining = expiry.getTime() - Date.now()

      if (remaining > THIRTY_DAYS_MS) {
        console.log(`Cert for ${username} still valid until ${expiry.toISOString()} — skipping`)
        return { status: 'valid', expiry }
      }
      console.log(`Cert for ${username} expiring ${expiry.toISOString()} — renewing`)
    } catch (err) {
      console.error(`Could not parse cert expiry for ${username}:`, err.message)
      // Continue to re-provision if we can't parse
    }
  }

  try {
    await provisionCert(username)
    console.log(`Cert provisioned for ${username}`)
    return { status: 'provisioned' }
  } catch (err) {
    if (err.message === 'certbot_unavailable') {
      console.log(`Certbot unavailable for ${username} — will retry later`)
      return { status: 'pending' }
    }
    console.error(`Cert provision failed for ${username}:`, err.message)
    throw err
  }
}
