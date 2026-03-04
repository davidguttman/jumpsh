import { randomBytes } from 'crypto'
import { createDnsRecord } from '../services/dns.js'
import { provisionUserCert } from '../jobs/provision.js'

const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET

// In-memory state store (same pattern as challenges.js)
const oauthSessions = new Map()
const TTL = 10 * 60 * 1000 // 10 minutes

// Cleanup expired sessions every 60s
setInterval(() => {
  const now = Date.now()
  for (const [state, entry] of oauthSessions) {
    if (entry.expiresAt < now) oauthSessions.delete(state)
  }
}, 60 * 1000).unref()

// GET /api/oauth/github — redirect to GitHub authorize
export function oauthRedirect (req, res) {
  const { state, ip } = req.query

  if (!state || !ip) {
    return res.status(400).json({ error: 'Missing state or ip parameter' })
  }

  // Store the session
  oauthSessions.set(state, {
    ip,
    complete: false,
    expiresAt: Date.now() + TTL
  })

  const params = new URLSearchParams({
    client_id: GITHUB_CLIENT_ID,
    redirect_uri: `${req.protocol}://${req.get('host')}/api/oauth/callback`,
    state,
    scope: ''
  })

  res.redirect(`https://github.com/login/oauth/authorize?${params}`)
}

// GET /api/oauth/callback — GitHub redirects back here
export async function oauthCallback (req, res, next) {
  try {
    const { code, state } = req.query

    if (!code || !state) {
      return res.status(400).send('Missing code or state parameter')
    }

    const session = oauthSessions.get(state)
    if (!session) {
      return res.status(400).send('Unknown or expired session. Please try again.')
    }

    // Exchange code for access token
    const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({
        client_id: GITHUB_CLIENT_ID,
        client_secret: GITHUB_CLIENT_SECRET,
        code
      })
    })

    const tokenData = await tokenRes.json()
    if (tokenData.error) {
      return res.status(401).send(`GitHub OAuth error: ${tokenData.error_description || tokenData.error}`)
    }

    // Fetch GitHub user profile
    const userRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        Accept: 'application/json'
      }
    })

    if (!userRes.ok) {
      return res.status(502).send('Failed to fetch GitHub user profile')
    }

    const { login: username } = await userRes.json()

    // Create DNS record and provision cert
    await createDnsRecord(username, session.ip)
    provisionUserCert(username).catch(() => {})

    // Update session with result
    session.complete = true
    session.username = username
    session.subdomain = `*.${username}.jump.sh`

    res.setHeader('Content-Type', 'text/html')
    res.send(`<!DOCTYPE html>
<html>
<head><title>jump.sh — registered</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; text-align: center; }
  .ok { color: #22c55e; font-size: 48px; }
  code { background: #f1f5f9; padding: 2px 8px; border-radius: 4px; }
</style>
</head>
<body>
  <div class="ok">&#10003;</div>
  <h1>Registered!</h1>
  <p>GitHub user: <strong>${username}</strong></p>
  <p>Subdomain: <code>*.${username}.jump.sh</code></p>
  <p>You can close this tab and return to your terminal.</p>
</body>
</html>`)
  } catch (err) {
    next(err)
  }
}

// GET /api/oauth/status — CLI polls this
export function oauthStatus (req, res) {
  const { state } = req.query

  if (!state) {
    return res.status(400).json({ error: 'Missing state parameter' })
  }

  const session = oauthSessions.get(state)
  if (!session) {
    return res.status(404).json({ error: 'Unknown or expired session' })
  }

  if (!session.complete) {
    return res.json({ complete: false })
  }

  res.json({
    complete: true,
    username: session.username,
    subdomain: session.subdomain
  })
}
