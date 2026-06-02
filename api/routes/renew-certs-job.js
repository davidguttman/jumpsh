import { timingSafeEqual } from 'node:crypto'

export const RENEW_CERTS_SECRET_ENV = 'JUMPSH_RENEW_CERTS_SECRET'

function headerValue (req, name) {
  if (typeof req.get === 'function') return req.get(name)
  return req.headers?.[name.toLowerCase()]
}

function suppliedSecret (req) {
  const authorization = headerValue(req, 'Authorization')
  if (authorization) {
    const match = String(authorization).match(/^Bearer\s+(.+)$/i)
    if (match) return match[1].trim()
  }

  const legacyHeader = headerValue(req, 'x-jumpsh-renew-certs-secret')
  return legacyHeader ? String(legacyHeader).trim() : null
}

function secretsMatch (expected, supplied) {
  if (!expected || !supplied) return false

  const expectedBuffer = Buffer.from(expected)
  const suppliedBuffer = Buffer.from(supplied)

  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)
}

async function defaultRenewExpiring () {
  const { renewExpiring } = await import('../jobs/renew.js')
  return renewExpiring()
}

export function createRenewCertsJobHandler (deps = {}) {
  const renewExpiring = deps.renewExpiring || defaultRenewExpiring
  const getSecret = deps.getSecret || (() => process.env[RENEW_CERTS_SECRET_ENV])
  let running = false

  return async function renewCertsJob (req, res, next) {
    const expectedSecret = getSecret()
    if (!expectedSecret) {
      return res.status(503).json({ error: 'Renewal secret is not configured' })
    }

    if (!secretsMatch(expectedSecret, suppliedSecret(req))) {
      return res.status(401).json({ error: 'Unauthorized' })
    }

    if (running) {
      return res.status(409).json({ error: 'Renewal already running' })
    }

    running = true
    try {
      const summary = await renewExpiring()
      const status = summary?.failed > 0 ? 500 : 200
      return res.status(status).json(summary)
    } catch (err) {
      next(err)
    } finally {
      running = false
    }
  }
}

export default createRenewCertsJobHandler()
