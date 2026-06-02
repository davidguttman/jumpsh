import { getTxtRecord, userRecordName } from '../services/dns.js'
import { certificateStatusFromBase64 } from '../services/cert-validity.js'

const USERNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/

export function createCertsHandler (deps = {}) {
  const readTxtRecord = deps.getTxtRecord || getTxtRecord
  const getCertificateStatus = deps.getCertificateStatus || certificateStatusFromBase64

  return async function certs (req, res) {
    const username = req.query.username

    if (!username || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Invalid or missing username' })
    }

    const certB64 = await readTxtRecord(userRecordName('_cert', username))
    const certStatus = getCertificateStatus(certB64)

    if (!certStatus.ready) {
      return res.json({
        ready: false,
        cert_status: certStatus.status,
        expires_at: certStatus.expires_at
      })
    }

    const keyB64 = await readTxtRecord(userRecordName('_key', username))

    if (!keyB64) {
      return res.json({
        ready: false,
        cert_status: certStatus.status,
        expires_at: certStatus.expires_at,
        key_status: 'missing'
      })
    }

    const certPem = Buffer.from(certB64, 'base64').toString('utf8')
    const keyPem = Buffer.from(keyB64, 'base64').toString('utf8')
    res.json({
      ready: true,
      cert_status: certStatus.status,
      expires_at: certStatus.expires_at,
      cert_pem: certPem,
      key_pem: keyPem
    })
  }
}

export default createCertsHandler()
