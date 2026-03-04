import { createDnsRecord } from '../services/dns.js'
import { fetchGithubKeys, verifySshSignature } from '../services/ssh-verify.js'
import { createChallenge, consumeChallenge } from '../challenges.js'

const USERNAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/
const IP_RE = /^(\d{1,3}\.){3}\d{1,3}$/

export default async function updateIp (req, res, next) {
  try {
    const { username, ip, nonce, signature } = req.body || {}

    if (!username || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'Invalid username format' })
    }

    if (!ip || !IP_RE.test(ip)) {
      return res.status(400).json({ error: 'Invalid IP address format' })
    }

    // Step 1: return challenge
    if (!nonce) {
      const keys = await fetchGithubKeys(username)
      if (!keys) {
        return res.status(404).json({ error: 'GitHub user not found or has no public keys' })
      }

      const challenge = createChallenge(username)
      return res.json({ nonce: challenge, keys })
    }

    // Step 2: verify signature, update A record
    if (!signature) {
      return res.status(400).json({ error: 'Missing signature' })
    }

    const challengeUser = consumeChallenge(nonce)
    if (!challengeUser || challengeUser !== username) {
      return res.status(401).json({ error: 'Challenge expired or not found' })
    }

    const keys = await fetchGithubKeys(username)
    if (!keys) {
      return res.status(401).json({ error: 'Could not fetch GitHub keys' })
    }

    const verified = await verifySshSignature(username, keys, nonce, signature)
    if (!verified) {
      return res.status(401).json({ error: 'Invalid signature' })
    }

    await createDnsRecord(username, ip)

    res.json({ ok: true, ip })
  } catch (err) {
    next(err)
  }
}
