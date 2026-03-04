import { getTxtRecord, userRecordName } from '../services/dns.js'
import { provisionCert } from '../services/certbot.js'

export async function provisionUserCert (username) {
  // If cert already exists, nothing to do
  const certB64 = await getTxtRecord(userRecordName('_cert', username))
  if (certB64) return

  try {
    await provisionCert(username)
    console.log(`Cert provisioned for ${username}`)
  } catch (err) {
    if (err.message === 'certbot_unavailable') {
      console.log(`Certbot unavailable for ${username} — will retry later`)
      return
    }
    console.error(`Cert provision failed for ${username}:`, err.message)
  }
}
