import { getTxtRecord, userRecordName } from '../services/dns.js'
import { provisionCert } from '../services/certbot.js'
import { certificateStatusFromBase64 } from '../services/cert-validity.js'

export async function provisionUserCert (username) {
  const certB64 = await getTxtRecord(userRecordName('_cert', username))
  const certStatus = certificateStatusFromBase64(certB64)

  if (certStatus.ready && certStatus.status === 'valid') {
    console.log(`Cert for ${username} still valid until ${certStatus.expires_at} — skipping`)
    return { status: 'valid', expiry: new Date(certStatus.expires_at) }
  }

  if (certStatus.ready && certStatus.status === 'expiring') {
    console.log(`Cert for ${username} expiring ${certStatus.expires_at} — renewing`)
  } else if (certStatus.status === 'expired') {
    console.log(`Cert for ${username} expired ${certStatus.expires_at} — renewing`)
  } else if (certStatus.status === 'malformed') {
    console.error(`Could not parse cert expiry for ${username}: malformed certificate data`)
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
