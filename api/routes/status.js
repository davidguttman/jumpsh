import { getTxtRecord, getARecord, userRecordName } from '../services/dns.js'

const USERNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/

export default async function status (req, res) {
  const username = req.query.username

  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: 'Invalid or missing username' })
  }

  const certB64 = await getTxtRecord(userRecordName('_cert', username))
  const ip = await getARecord(username)

  res.json({
    username,
    subdomain: `*.${username}.jump.sh`,
    ready: !!certB64,
    ip: ip || null
  })
}
