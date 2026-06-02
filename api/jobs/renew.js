import { resolve } from 'path'
import { fileURLToPath } from 'url'
import {
  listRecordsByPrefix as defaultListRecordsByPrefix,
  getTxtRecord as defaultGetTxtRecord,
  userRecordName as defaultUserRecordName
} from '../services/dns.js'
import { provisionCert as defaultProvisionCert } from '../services/certbot.js'
import { certificateStatusFromBase64 as defaultCertificateStatusFromBase64 } from '../services/cert-validity.js'

const DOMAIN = process.env.JUMP_DOMAIN || 'jump.sh'

function escapeRegExp (value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function emptySummary () {
  return {
    checked: 0,
    valid: 0,
    expiring: 0,
    expired: 0,
    malformed_missing: 0,
    renewed: 0,
    failed: 0
  }
}

function errorMessage (err) {
  return err?.message || String(err)
}

function logInfo (logger, message, fields) {
  if (fields) {
    logger.log(`${message} ${JSON.stringify(fields)}`)
  } else {
    logger.log(message)
  }
}

function logError (logger, message, fields) {
  logger.error(`${message} ${JSON.stringify(fields)}`)
}

export function createRenewExpiring (deps = {}) {
  const listRecordsByPrefix = deps.listRecordsByPrefix || defaultListRecordsByPrefix
  const getTxtRecord = deps.getTxtRecord || defaultGetTxtRecord
  const userRecordName = deps.userRecordName || defaultUserRecordName
  const provisionCert = deps.provisionCert || defaultProvisionCert
  const getCertificateStatus = deps.getCertificateStatus || defaultCertificateStatusFromBase64
  const logger = deps.log || console
  const domain = deps.domain || DOMAIN
  const certRecordRe = new RegExp(`^_cert\\.([^.]+)\\.${escapeRegExp(domain)}\\.?$`)

  return async function renewExpiring () {
    const summary = emptySummary()
    const certRecords = await listRecordsByPrefix('_cert')

    for (const record of certRecords) {
      if (record.name.startsWith('_key.')) continue

      const nameMatch = record.name.match(certRecordRe)
      if (!nameMatch) continue

      const username = nameMatch[1]
      summary.checked++

      let certStatus
      try {
        const certB64 = await getTxtRecord(userRecordName('_cert', username))
        certStatus = getCertificateStatus(certB64)
      } catch (err) {
        summary.failed++
        logError(logger, 'Renewal check failed', {
          username,
          status: 'read_failed',
          error: errorMessage(err)
        })
        continue
      }

      const status = certStatus.status

      if (status === 'valid') {
        summary.valid++
        continue
      }

      if (status === 'expiring') {
        summary.expiring++
        logInfo(logger, 'Renewing expiring cert', { username, status, expires_at: certStatus.expires_at })
      } else if (status === 'expired') {
        summary.expired++
        logInfo(logger, 'Renewing expired cert', { username, status, expires_at: certStatus.expires_at })
      } else {
        summary.malformed_missing++
        logInfo(logger, 'Renewing malformed/missing cert', { username, status })
      }

      try {
        await provisionCert(username)
        summary.renewed++
      } catch (err) {
        summary.failed++
        logError(logger, 'Renewal failed', {
          username,
          status,
          error: errorMessage(err)
        })
      }
    }

    logInfo(logger, 'Renewal run summary', summary)
    return summary
  }
}

export async function renewExpiring (deps = {}) {
  return createRenewExpiring(deps)()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  renewExpiring().then(() => process.exit(0)).catch(err => {
    console.error('Renewal script failed:', err)
    process.exit(1)
  })
}
