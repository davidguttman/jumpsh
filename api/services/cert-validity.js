import { X509Certificate } from 'crypto'

export const CERT_EXPIRING_SOON_MS = 30 * 24 * 60 * 60 * 1000

const CERT_BLOCK_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/

function emptyResult (status) {
  return {
    status,
    ready: false,
    expires_at: null
  }
}

function firstCertificatePem (pem) {
  if (typeof pem !== 'string') return null
  const match = pem.match(CERT_BLOCK_RE)
  return match ? match[0] : null
}

export function certificateStatusFromPem (pem, options = {}) {
  const now = options.now ? new Date(options.now) : new Date()
  const expiringSoonMs = options.expiringSoonMs ?? CERT_EXPIRING_SOON_MS
  const certPem = firstCertificatePem(pem)

  if (!certPem) {
    return emptyResult('malformed')
  }

  try {
    const cert = new X509Certificate(certPem)
    const expiresAt = new Date(cert.validTo)

    if (Number.isNaN(expiresAt.getTime())) {
      return emptyResult('malformed')
    }

    const expires_at = expiresAt.toISOString()
    const remainingMs = expiresAt.getTime() - now.getTime()

    if (remainingMs <= 0) {
      return {
        status: 'expired',
        ready: false,
        expires_at
      }
    }

    if (remainingMs <= expiringSoonMs) {
      return {
        status: 'expiring',
        ready: true,
        expires_at
      }
    }

    return {
      status: 'valid',
      ready: true,
      expires_at
    }
  } catch {
    return emptyResult('malformed')
  }
}

export function certificateStatusFromBase64 (certB64, options = {}) {
  if (!certB64) {
    return emptyResult('missing')
  }

  try {
    const certPem = Buffer.from(certB64, 'base64').toString('utf8')
    return certificateStatusFromPem(certPem, options)
  } catch {
    return emptyResult('malformed')
  }
}
