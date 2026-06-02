import { listRecordsByPrefix, getTxtRecord, userRecordName } from '../services/dns.js'
import { provisionCert } from '../services/certbot.js'
import { certificateStatusFromBase64 } from '../services/cert-validity.js'

const DOMAIN = process.env.JUMP_DOMAIN || 'jump.sh'

async function renewExpiring () {
  // Find all users by looking for _cert records
  const certRecords = await listRecordsByPrefix('_cert')

  if (!certRecords.length) {
    console.log('No certs found')
    return
  }

  let renewed = 0

  for (const record of certRecords) {
    // Skip _key records
    if (record.name.startsWith('_key.')) continue

    const nameMatch = record.name.match(new RegExp(`^_cert\\.([^.]+)\\.${DOMAIN.replace('.', '\\.')}\\.?$`))
    if (!nameMatch) continue

    const username = nameMatch[1]
    const certB64 = await getTxtRecord(userRecordName('_cert', username))
    if (!certB64) continue

    const certStatus = certificateStatusFromBase64(certB64)

    if (certStatus.status === 'valid') continue

    try {
      if (certStatus.status === 'expiring') {
        console.log(`Cert for ${username} expires ${certStatus.expires_at} — renewing`)
      } else if (certStatus.status === 'expired') {
        console.log(`Cert for ${username} expired ${certStatus.expires_at} — renewing`)
      } else {
        console.log(`Cert for ${username} is ${certStatus.status} — renewing`)
      }

      await provisionCert(username)
      renewed++
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
