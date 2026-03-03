# Register CLI SSH — Implementation Plan (Revised)

## Goal

Replace the existing token-based `jumpsh register` with a zero-touch SSH-key flow that authenticates via GitHub identity, provisions `*.{username}.jump.sh` DNS + wildcard TLS cert, and downloads certs locally.

---

## 1. New file: `lib/ssh-register.js`

Single helper module containing all registration logic. Keeps `lib/commands/register.js` thin (just orchestration + output). Functions:

### `detectGitHubUsername()`
- Run `ssh -T git@github.com` via `execSync` with a **10-second timeout** (`{ timeout: 10_000 }`), capture combined stdout/stderr (command exits non-zero on success).
- Parse `Hi ([^!]+)!` from output.
- Return username string or `null`.
- On timeout: return `null` (caller prints guidance).

### `requestChallenge(username)`
- `POST ${JUMPSH_API}/api/register` with `{ github_username }`.
- Build URL from `getRegisterApiOrigin()` (new helper: `JUMPSH_API` env > `JUMPSH_API_ORIGIN` env > `https://api.jump.sh`).
- Return `{ nonce, keys }`.
- **If `keys` is empty or missing**, throw with message: "GitHub has no SSH keys for this account. Add one at https://github.com/settings/keys".

### `signChallenge(nonce, keys)` — CORRECTED

**Critical fix**: `ssh-keygen -Y sign -f <file>` requires a **private key** file (or an agent-backed identity). You cannot sign with just a public key file from the server.

**Correct approach — ssh-agent signing**:
1. List keys loaded in the local ssh-agent via `ssh-add -L` (outputs public keys, one per line).
2. Intersect agent keys with `keys` returned by the server (which are the user's GitHub public keys). Match on the key body (type + base64 portion).
3. For each matching key:
   - Write the **public key** to a temp file.
   - Run `ssh-keygen -Y sign -f <pubkey_file> -n jump.sh`, piping `nonce` to stdin.
   - `ssh-keygen` contacts the **ssh-agent** to perform the actual signing using the corresponding private key. This works because ssh-keygen recognizes that the file is a public key and delegates to the agent.
   - On success, return the signature string. On failure (`AGENT_REFUSED` / key not in agent), try next key.
4. If no intersection between agent keys and server keys: throw with agent-keys-available but no match message.
5. If `ssh-add -L` fails or returns "no identities": throw with "no keys loaded in ssh-agent" message.
6. Clean up temp dir in `finally`.

### `completeRegistration(username, nonce, signature, ip)`
- `POST ${JUMPSH_API}/api/register` with `{ github_username, nonce, signature, ip }`.
- Return response body.

### `waitForCert(username, { maxWaitMs = 120_000, intervalMs = 3_000 })`
- Poll `GET ${JUMPSH_API}/api/status?username=${username}`.
- Return when `ready === true`; throw on timeout.
- **Transient error resilience**: catch network errors during individual polls and continue polling (only throw on timeout). Log transient failures to stderr as dots.

### `downloadCertsForUser(username)`
- `GET ${JUMPSH_API}/api/certs?username=${username}`.
- Create cert dir `~/.jump.sh/certs/{username}/` with `mode: 0o700` (secure — only user can read).
- Write `fullchain.pem` (mode 0o644) and `privkey.pem` (mode 0o600).
- **Overwrite behavior**: always overwrite existing files. This supports re-registration and cert renewal. No prompt.
- Return cert directory path.

### `getRegisterApiOrigin()`
- `process.env.JUMPSH_API || process.env.JUMPSH_API_ORIGIN || 'https://api.jump.sh'`

---

## 2. Rewrite `lib/commands/register.js`

Replace the current token-based register with the SSH flow.

### New implementation

```
export default async function register(argv) {
  // --help / -h
  // --ip <address> (default 127.0.0.1)
  // --username <name> (override auto-detect)

  Step 1: if --username provided, use it; else detectGitHubUsername() → print or exit
  Step 2: requestChallenge(username) → print
  Step 3: signChallenge(nonce, keys) → print
  Step 4: completeRegistration(username, nonce, signature, ip) → print
  Step 5: waitForCert(username) → print dots + done
  Step 6: downloadCertsForUser(username) → print files
  Final:  print "https://*.{username}.jump.sh"
}
```

Error handling follows the spec error table — each step catches and prints the mapped message, then `process.exit(1)`.

The `--username` flag provides a fallback when auto-detect fails (e.g. corporate SSH proxy blocking `ssh -T git@github.com`).

---

## 3. Update `server.js`

### `loadCertPair()` — support dual cert naming

Try both naming conventions in order:
1. `server-key.pem` + `server.pem` (existing)
2. `privkey.pem` + `fullchain.pem` (new, from register flow)

Return whichever pair exists first. No change to function signature.

### `detectDomainFromCerts()` — support dual naming

Also check for `privkey.pem` + `fullchain.pem` in subdirectories.

### SNI — dynamic user cert loading

Replace the hard-coded `dmg` SNI context with a generic loop:

```
const sniContexts = {};
for each subdirectory in certPath:
  const pair = loadCertPair(subdir)
  if (pair) sniContexts[subdir.name] = tls.createSecureContext(pair)

SNICallback(hostname, cb):
  // Strip .jump.sh suffix, extract the user portion
  // e.g. "foo.david.jump.sh" → "david", "dash.username.jump.sh" → "username"
  // Strategy: match hostname against "*.{name}.jump.sh" for each name in sniContexts
  for (const name of Object.keys(sniContexts)):
    if hostname ends with `.${name}.jump.sh` or hostname === `${name}.jump.sh`:
      return cb(null, sniContexts[name])
  cb(null)  // fall through to default cert
```

This generalizes cleanly — `dmg` cert continues working, user certs (e.g. `davidguttman`) work identically. The hostname matching is explicit suffix-based, not regex-based.

---

## 4. Update CLI help text

In `lib/cli.js` HELP string, update the `register` line:

```
  register            Register via GitHub SSH key (provisions *.you.jump.sh)
```

---

## 5. Migration / backward compat

| Concern | Decision |
|---------|----------|
| Old `register` command (token-based) | **Replace entirely.** It depends on `jumpsh login --token` which is being superseded. |
| Old `login` command | **Keep as-is.** Not touched. |
| Old `status` / `sync` commands | **Keep as-is.** Orthogonal. |
| Shared certs (`server.pem`) | **Keep working.** The `certs` command and `certsExist()` unchanged. |
| Per-user certs (`fullchain.pem`) | **New path.** Only created by new `register` flow. |

---

## 6. Files changed summary

| File | Change |
|------|--------|
| `lib/ssh-register.js` | **New** — all SSH registration helpers |
| `lib/commands/register.js` | **Rewrite** — new SSH flow |
| `server.js` | **Minor** — dual cert naming in `loadCertPair` + `detectDomainFromCerts`; generalize SNI loop |
| `lib/cli.js` | **Trivial** — update help text |
| `test/ssh-register.test.js` | **New** — unit tests |

Note: `lib/commands/certs.js` is NOT modified. The new register flow handles its own cert downloads via `downloadCertsForUser()` in `lib/ssh-register.js`. No need for a `certsExistForUser()` export since nothing else calls it.

---

## 7. Error handling

| Step | Error condition | User message |
|------|----------------|--------------|
| 1 | `ssh -T` timeout or no match, and no `--username` | "Could not detect GitHub username.\nMake sure you have an SSH key added to your GitHub account.\nSee: https://docs.github.com/en/authentication/connecting-to-github-with-ssh\n\nOr pass --username <github_username> to skip auto-detection." |
| 2 | Empty keys from server | "GitHub has no SSH keys for this account.\nAdd one at https://github.com/settings/keys" |
| 2 | Other API error | Forward `err.error` from response body |
| 3 | No keys in agent | "No SSH keys loaded in your agent.\n  ssh-add -l\n  ssh-add ~/.ssh/id_ed25519" |
| 3 | Agent keys don't match GitHub keys | "None of your loaded SSH keys match your GitHub account.\n  ssh-add -l        # loaded keys\n  Check https://github.com/settings/keys" |
| 4 | Signature invalid | "Signature verification failed" (from API) |
| 4 | Challenge expired | "Challenge expired, please try again" (from API) |
| 5 | Timeout (transient errors ignored) | "Timed out waiting for certificate (120s). Try again later." |
| 6 | Download fail | "Failed to download certificates" |

---

## 8. Test plan

### Unit tests (`test/ssh-register.test.js`, `node --test`)

- `detectGitHubUsername`: verify parsing of success output, error output, timeout.
- `signChallenge`: verify agent key intersection logic, temp file cleanup.
- `getRegisterApiOrigin`: verify env var priority.

### Manual verification

```bash
# Happy path
jumpsh register

# Custom IP
jumpsh register --ip 100.64.1.2

# Username override
jumpsh register --username someuser

# Dev API
JUMPSH_API=http://localhost:3000 jumpsh register

# Verify cert files
ls -la ~/.jump.sh/certs/$USER/

# Error: no SSH key in agent
SSH_AUTH_SOCK= jumpsh register

# Verify server picks up new certs
jumpsh  # foreground, check SNI log output
```

---

## 9. Implementation order

1. `lib/ssh-register.js` — all helper functions
2. `lib/commands/register.js` — rewrite using helpers
3. `server.js` — dual cert naming + generalized SNI loop
4. `lib/cli.js` — help text
5. `test/ssh-register.test.js` — unit tests
6. Verification
