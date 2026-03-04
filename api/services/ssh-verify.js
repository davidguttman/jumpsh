import { execFile } from 'child_process'
import { writeFile, mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

export async function fetchGithubKeys (username) {
  const resp = await fetch(`https://github.com/${username}.keys`)
  if (!resp.ok) return null

  const body = (await resp.text()).trim()
  if (!body) return null

  return body.split('\n').filter(Boolean)
}

export async function verifySshSignature (username, keys, nonce, signature) {
  const tmpDir = await mkdtemp(join(tmpdir(), 'jump-verify-'))

  try {
    const allowedSignersPath = join(tmpDir, 'allowed_signers')
    const signaturePath = join(tmpDir, 'signature')

    const allowedSigners = keys
      .map(k => `${username} ${k}`)
      .join('\n')

    await writeFile(allowedSignersPath, allowedSigners)
    await writeFile(signaturePath, signature)

    return await new Promise((resolve) => {
      const proc = execFile('ssh-keygen', [
        '-Y', 'verify',
        '-f', allowedSignersPath,
        '-I', username,
        '-n', 'jump.sh',
        '-s', signaturePath
      ], (err) => {
        resolve(!err)
      })

      proc.stdin.write(nonce)
      proc.stdin.end()
    })
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}
