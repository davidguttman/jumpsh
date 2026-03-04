import { execFile } from 'child_process'
import { readFile } from 'fs/promises'
import { setTxtRecord, userRecordName } from './dns.js'

const DOMAIN = process.env.JUMP_DOMAIN || 'jump.sh'

export async function provisionCert (username) {
  const wildcard = `*.${username}.${DOMAIN}`
  const certPaths = await runCertbot(wildcard)
  const certPem = await readFile(certPaths.fullchain, 'utf8')
  const keyPem = await readFile(certPaths.privkey, 'utf8')

  const certB64 = Buffer.from(certPem).toString('base64')
  const keyB64 = Buffer.from(keyPem).toString('base64')

  await setTxtRecord(userRecordName('_cert', username), certB64)
  await setTxtRecord(userRecordName('_key', username), keyB64)

  return { success: true }
}

function runCertbot (domain) {
  return new Promise((resolve, reject) => {
    const credsFile = process.env.GOOGLE_APPLICATION_CREDENTIALS || '/tmp/gcp-creds.json'
    
    const args = [
      'certonly',
      '--dns-google',
      '--dns-google-credentials', credsFile,
      '--non-interactive',
      '--agree-tos',
      '--register-unsafely-without-email',
      '-d', domain
    ]

    console.log(`Running certbot for ${domain}...`)

    execFile('certbot', args, (err, stdout, stderr) => {
      if (err) {
        console.error('Certbot error:', stderr || err.message)
        const cannotRun = err.code === 'ENOENT' || (stderr && stderr.includes('credentials'))
        if (cannotRun) {
          console.warn('Certbot not available or no credentials — skipping cert provisioning')
          reject(new Error('certbot_unavailable'))
          return
        }
        reject(new Error(`certbot failed: ${stderr || err.message}`))
        return
      }

      console.log('Certbot stdout:', stdout)
      console.log('Certbot stderr:', stderr)

      const output = stdout + '\n' + stderr
      const certDir = output.match(/\/etc\/letsencrypt\/live\/[^\s/]+/)

      if (certDir) {
        resolve({
          fullchain: `${certDir[0]}/fullchain.pem`,
          privkey: `${certDir[0]}/privkey.pem`
        })
      } else {
        const safeDomain = domain.replace('*.', '')
        resolve({
          fullchain: `/etc/letsencrypt/live/${safeDomain}/fullchain.pem`,
          privkey: `/etc/letsencrypt/live/${safeDomain}/privkey.pem`
        })
      }
    })
  })
}
