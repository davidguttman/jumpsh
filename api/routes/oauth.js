import { createDnsRecord } from '../services/dns.js'
import { provisionUserCert } from '../jobs/provision.js'

// POST /api/oauth/register — CLI sends GitHub access_token + ip after Device Flow
// Server verifies token with GitHub, gets username, creates DNS + cert
export async function oauthRegister (req, res, next) {
  try {
    const { access_token, ip } = req.body || {}

    if (!access_token) {
      return res.status(400).json({ error: 'Missing access_token' })
    }
    if (!ip || !/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
      return res.status(400).json({ error: 'Missing or invalid ip' })
    }

    // Verify token with GitHub
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${access_token}`,
        Accept: 'application/json'
      }
    })

    if (!userRes.ok) {
      return res.status(401).json({ error: 'Invalid GitHub access token' })
    }

    const { login: username } = await userRes.json()

    if (!username) {
      return res.status(401).json({ error: 'Could not determine GitHub username' })
    }

    // Create DNS record and provision cert
    await createDnsRecord(username, ip)
    provisionUserCert(username).catch(() => {})

    res.json({ ok: true, username, subdomain: `*.${username}.jump.sh` })
  } catch (err) {
    next(err)
  }
}
