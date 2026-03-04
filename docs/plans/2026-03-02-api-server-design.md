# jump.sh API Server Design

## Overview

Transform www-jump-sh from a static landing page into an API service that enables self-serve per-user subdomains with automatic DNS provisioning and certificate management.

## User Flow

```
$ jumpsh register

Detecting GitHub identity...
✓ Found: davidguttman

Registering davidguttman.jump.sh...
✓ DNS record created
✓ Certificate provisioning started

Verifying identity...
[SSH agent signs challenge automatically]
✓ Identity verified

Downloading certificates...
✓ Saved to ~/.jump.sh/certs/davidguttman/

You're all set! Your projects will be available at:
  https://*.davidguttman.jump.sh
```

**Zero touch.** No prompts, no typing, no browser popups.

## Architecture

### API Endpoints

```
POST /api/register
  Input: { github_username }
  Actions:
    1. Validate username exists on GitHub
    2. Fetch public keys from https://github.com/{username}.keys
    3. Create DNS record: *.{username}.jump.sh → 127.0.0.1
    4. Generate challenge nonce
    5. Store pending registration
  Output: { challenge_nonce, keys: [...] }

POST /api/verify
  Input: { username, signature, nonce }
  Actions:
    1. Verify signature against stored GitHub public keys
    2. If valid: mark user as verified, issue API token
    3. Start async cert provisioning
  Output: { token, cert_status: "provisioning" | "ready" }

GET /api/certs
  Auth: Bearer token
  Output: { cert_pem, key_pem } or { status: "provisioning" }

GET /api/status
  Auth: Bearer token
  Output: { username, subdomain, cert_expires_at, cert_status }
```

### Client-Side Auth Flow

```bash
# 1. Detect GitHub username (zero touch)
username=$(ssh -T git@github.com 2>&1 | sed -n 's/Hi \([^!]*\)!.*/\1/p')

# 2. Start registration, get challenge + their GitHub public keys
response=$(curl -s -X POST "$API/register" -d "{\"github_username\":\"$username\"}")
nonce=$(echo "$response" | jq -r '.challenge_nonce')
keys=$(echo "$response" | jq -r '.keys[]')

# 3. Sign challenge using GitHub public key + local agent
for pubkey in $keys; do
  echo "$pubkey" > /tmp/gh.pub
  if sig=$(ssh-keygen -Y sign -f /tmp/gh.pub -n jump.sh <<< "$nonce" 2>/dev/null); then
    break
  fi
done

# 4. Verify signature, get token
token=$(curl -s -X POST "$API/verify" \
  -d "{\"username\":\"$username\",\"signature\":\"$sig\",\"nonce\":\"$nonce\"}" \
  | jq -r '.token')

# 5. Save token
echo "token=$token" > ~/.jump.sh/config
```

### DNS Management (GCP Cloud DNS)

Uses existing GCP setup from homebase:
- Project: (configured via gcloud)
- Service account: letsencrypt-dns@{project}.iam.gserviceaccount.com
- Role: roles/dns.admin

```javascript
// Create wildcard A record
await dns.createRecord({
  zone: 'jump-sh',
  name: `*.${username}.jump.sh.`,
  type: 'A',
  ttl: 300,
  rrdatas: ['127.0.0.1']
});
```

### Certificate Provisioning

Uses certbot with dns-google plugin:

```bash
certbot certonly \
  --dns-google \
  --dns-google-credentials /etc/letsencrypt/gcp-dns-credentials.json \
  -d "*.${username}.jump.sh" \
  --non-interactive \
  --agree-tos \
  --email admin@jump.sh
```

Certs stored in database (encrypted at rest with server key).

### Database Schema (SQLite)

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  github_username TEXT UNIQUE NOT NULL,
  token_hash TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  verified_at DATETIME
);

CREATE TABLE github_keys (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  key_type TEXT,
  key_data TEXT,
  fingerprint TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE challenges (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  nonce TEXT NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME
);

CREATE TABLE certs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  cert_pem_encrypted BLOB,
  key_pem_encrypted BLOB,
  issued_at DATETIME,
  expires_at DATETIME,
  renewed_at DATETIME
);
```

### Background Jobs

1. **Cert provisioning**: Triggered after verification, runs certbot
2. **Cert renewal**: Cron job checks for certs expiring within 30 days
3. **Challenge cleanup**: Remove expired challenges

## Tech Stack

- **Runtime**: Node.js + Express (matches jumpsh daemon)
- **Database**: SQLite (simple, file-based, matches jumpsh)
- **DNS**: GCP Cloud DNS via @google-cloud/dns
- **Certs**: certbot CLI (shelled out)
- **Encryption**: Node crypto for cert storage

## File Structure

```
api/
├── server.js          # Express app
├── challenges.js      # In-memory challenge nonce management
├── routes/
│   ├── register.js    # POST /api/register (two-step)
│   ├── certs.js       # GET /api/certs
│   ├── status.js      # GET /api/status
│   └── ip.js          # POST /api/ip
├── services/
│   ├── dns.js         # GCP Cloud DNS
│   ├── certbot.js     # Cert provisioning
│   └── ssh-verify.js  # SSH signature verification
└── jobs/
    ├── provision.js   # Async cert provisioning
    └── renew.js       # Renewal cron
```

## Security Considerations

1. **Rate limiting**: Limit registrations per IP (prevent abuse)
2. **Challenge expiry**: Nonces expire after 5 minutes
3. **Token hashing**: Store bcrypt hash of tokens, not plaintext
4. **Cert encryption**: Encrypt private keys at rest
5. **Let's Encrypt limits**: Track usage, warn before hitting 50/week

## V1 Simplifications

- No token revocation (re-register if needed)
- No username changes
- No OAuth fallback (SSH-only)
- SQLite is fine (no Postgres)
- Single-server deployment (no queue system for jobs)

## Open Questions (Resolved)

1. GitHub username detection: `ssh -T git@github.com` greeting
2. Key file specification: Use GitHub public keys + agent signing
3. Auth concern: Agent-based signing, never touch private keys
