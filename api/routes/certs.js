import { getTxtRecord, userRecordName } from '../services/dns.js'

const USERNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/

export default async function certs (req, res) {
  const username = req.query.username

  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Invalid or missing username' })
  }

  const certB64 = await getTxtRecord(userRecordName('_cert', username))
  const keyB64 = await getTxtRecord(userRecordName('_key', username))

  if (!certB64 || !keyB64) {
    return res.json({ ready: false })
  }

  const certPem = Buffer.from(certB64, 'base64').toString('utf8')
  const keyPem = Buffer.from(keyB64, 'base64').toString('utf8')
  res.json({ ready: true, cert_pem: certPem, key_pem: keyPem })
}
