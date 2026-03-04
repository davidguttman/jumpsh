import { writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DNS } from '@google-cloud/dns'

// Decode base64 GCP credentials to a temp file for Render/container deployments
if (process.env.GCP_CREDENTIALS_BASE64 && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const dir = mkdtempSync(join(tmpdir(), 'gcp-'))
  const credPath = join(dir, 'credentials.json')
  writeFileSync(credPath, Buffer.from(process.env.GCP_CREDENTIALS_BASE64, 'base64'))
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credPath
}

const ZONE_NAME = process.env.GCP_DNS_ZONE || 'jump-sh'
const DOMAIN = process.env.JUMP_DOMAIN || 'jump.sh'

let dns
try {
  dns = new DNS()
} catch (err) {
  console.warn('GCP DNS client not initialized:', err.message)
}

export function userRecordName (prefix, username) {
  return `${prefix}.${username}.${DOMAIN}.`
}

export async function createDnsRecord (username, ip = '127.0.0.1') {
  if (!dns) {
    console.warn(`Skipping DNS creation for ${username}: no GCP credentials`)
    return
  }

  const zone = dns.zone(ZONE_NAME)
  const recordName = `*.${username}.${DOMAIN}.`

  try {
    const [records] = await zone.getRecords({ name: recordName, type: 'A' })

    const newRecord = zone.record('A', {
      name: recordName,
      ttl: 300,
      data: ip
    })

    if (records.length > 0) {
      await zone.createChange({ add: newRecord, delete: records })
      console.log(`DNS updated: ${recordName} → ${ip}`)
    } else {
      await zone.createChange({ add: newRecord })
      console.log(`DNS created: ${recordName} → ${ip}`)
    }
  } catch (err) {
    console.error(`DNS creation failed for ${recordName}:`, err.message)
  }
}

export async function getARecord (username) {
  if (!dns) return null

  const zone = dns.zone(ZONE_NAME)
  const recordName = `*.${username}.${DOMAIN}.`

  try {
    const [records] = await zone.getRecords({ name: recordName, type: 'A' })
    if (!records.length) return null
    return records[0].data[0]
  } catch (err) {
    console.error(`A record get failed for ${recordName}:`, err.message)
    return null
  }
}

function chunkString (str, size) {
  const chunks = []
  for (let i = 0; i < str.length; i += size) {
    chunks.push(str.slice(i, i + size))
  }
  return chunks
}

export async function setTxtRecord (name, value) {
  if (!dns) {
    console.warn(`Skipping TXT set for ${name}: no GCP credentials`)
    return
  }

  const zone = dns.zone(ZONE_NAME)
  const fqdn = name.endsWith('.') ? name : `${name}.`

  const values = Array.isArray(value) ? value : chunkString(value, 255)

  try {
    const [existing] = await zone.getRecords({ name: fqdn, type: 'TXT' })

    const newRecord = zone.record('TXT', {
      name: fqdn,
      ttl: 60,
      data: values
    })

    if (existing.length > 0) {
      await zone.createChange({ add: newRecord, delete: existing })
    } else {
      await zone.createChange({ add: newRecord })
    }
  } catch (err) {
    console.error(`TXT set failed for ${fqdn}:`, err.message)
    throw err
  }
}

export async function getTxtRecord (name) {
  if (!dns) return null

  const zone = dns.zone(ZONE_NAME)
  const fqdn = name.endsWith('.') ? name : `${name}.`

  try {
    const [records] = await zone.getRecords({ name: fqdn, type: 'TXT' })
    if (!records.length) return null

    const rrdatas = records[0].data
    const joined = rrdatas.map(s => s.replace(/^"|"$/g, '')).join('')
    return joined
  } catch (err) {
    console.error(`TXT get failed for ${fqdn}:`, err.message)
    return null
  }
}

export async function listRecordsByPrefix (prefix) {
  if (!dns) return []

  const zone = dns.zone(ZONE_NAME)

  try {
    const [records] = await zone.getRecords({ type: 'TXT' })
    return records.filter(r => r.name.startsWith(`${prefix}.`))
  } catch (err) {
    console.error(`TXT list failed for prefix ${prefix}:`, err.message)
    return []
  }
}
