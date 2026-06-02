import { getTxtRecord, getARecord, userRecordName } from '../services/dns.js'
import { certificateStatusFromBase64 } from '../services/cert-validity.js'

const USERNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/

export function createStatusHandler (deps = {}) {
  const readTxtRecord = deps.getTxtRecord || getTxtRecord
  const readARecord = deps.getARecord || getARecord
  const getCertificateStatus = deps.getCertificateStatus || certificateStatusFromBase64

  return async function status (req, res) {
    const username = req.query.username

    if (!username || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Invalid or missing username' })
    }

    const certB64 = await readTxtRecord(userRecordName('_cert', username))
    const ip = await readARecord(username)
    const certStatus = getCertificateStatus(certB64)

    res.json({
      username,
      subdomain: `*.${username}.jump.sh`,
      ready: certStatus.ready,
      cert_status: certStatus.status,
      expires_at: certStatus.expires_at,
      ip: ip || null
    })
  }
}

export default createStatusHandler()
