import { execFile } from 'child_process'
import { writeFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { listRecordsByPrefix, getTxtRecord, userRecordName } from '../services/dns.js'
import { provisionCert } from '../services/certbot.js'

const DOMAIN = process.env.JUMP_DOMAIN || 'jump.sh'
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

function parseCertExpiry (pemB64) {
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

async function renewExpiring () {
  // Find all users by looking for _cert records
  const certRecords = await listRecordsByPrefix('_cert')

  if (!certRecords.length) {
    console.log('No certs found')
    return
  }

  const now = Date.now()
  let renewed = 0

  for (const record of certRecords) {
    // Skip _key records
    if (record.name.startsWith('_key.')) continue

    const nameMatch = record.name.match(new RegExp(`^_cert\\.([^.]+)\\.${DOMAIN.replace('.', '\\.')}\\.?$`))
    if (!nameMatch) continue

    const username = nameMatch[1]
    const certB64 = await getTxtRecord(userRecordName('_cert', username))
    if (!certB64) continue

    try {
      const expiry = await parseCertExpiry(certB64)
      const remaining = expiry.getTime() - now

      if (remaining < THIRTY_DAYS_MS) {
        console.log(`Cert for ${username} expires ${expiry.toISOString()} — renewing`)
        await provisionCert(username)
        renewed++
      }
    } catch (err) {
      console.error(`Renewal check failed for ${username}:`, err.message)
    }
  }

  console.log(`Renewal run complete — renewed ${renewed} cert(s)`)
}

renewExpiring().then(() => process.exit(0)).catch(err => {
  console.error('Renewal script failed:', err)
  process.exit(1)
})
