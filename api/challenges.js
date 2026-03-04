import { randomBytes } from 'crypto'

const challenges = new Map()
const TTL = 5 * 60 * 1000 // 5 minutes

export function createChallenge (username) {
  const nonce = randomBytes(32).toString('base64')
  challenges.set(nonce, { username, expiresAt: Date.now() + TTL })
  return nonce
}

export function consumeChallenge (nonce) {
  const entry = challenges.get(nonce)
  if (!entry) return null
  challenges.delete(nonce)
  if (entry.expiresAt < Date.now()) return null
  return entry.username
}

// Cleanup expired challenges every 60s
setInterval(() => {
  const now = Date.now()
  for (const [nonce, entry] of challenges) {
    if (entry.expiresAt < now) challenges.delete(nonce)
  }
}, 60 * 1000).unref()
