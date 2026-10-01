import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const entrypoint = fileURLToPath(new URL('../jobs/renew.js', import.meta.url))

function runCli (scenario) {
  // Preload mocks before running the actual entrypoint; no DNS or certbot calls.
  const preload = `
    import { registerHooks } from 'node:module';
    registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith('/services/dns.js')) return {
          format: 'module', shortCircuit: true,
          source: ${JSON.stringify(`
            export const userRecordName = (prefix, username) => prefix + '.' + username + '.jump.sh.';
            export const getTxtRecord = async () => 'mock-certificate';
            export const listRecordsByPrefix = async () => {
              if (${JSON.stringify(scenario)} === 'listing-error') throw new Error('mock listing failure');
              return [{ name: '_cert.alice.jump.sh.' }, { name: '_cert.bob.jump.sh.' }];
            };
          `)}
        };
        if (url.endsWith('/services/cert-validity.js')) return {
          format: 'module', shortCircuit: true,
          source: 'export const certificateStatusFromBase64 = () => ({ status: "expired" });'
        };
        if (url.endsWith('/services/certbot.js')) return {
          format: 'module', shortCircuit: true,
          source: ${JSON.stringify(`
            export const provisionCert = async username => {
              if (${JSON.stringify(scenario)} === 'partial-failure' && username === 'alice') throw new Error('mock provisioning failure');
            };
          `)}
        };
        return nextLoad(url, context);
      }
    });
  `
  const env = { ...process.env, JUMP_DOMAIN: 'jump.sh' }
  delete env.GCP_CREDENTIALS_BASE64
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, entrypoint], {
    encoding: 'utf8', env, timeout: 10000
  })
}

describe('standalone renewal CLI', () => {
  it('exits nonzero for partial failures while finishing the remaining certificates', () => {
    const result = runCli('partial-failure')
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stdout, /"checked":2/)
    assert.match(result.stdout, /"renewed":1,"failed":1/)
  })

  it('exits zero when all renewals succeed', () => {
    const result = runCli('success')
    assert.equal(result.error, undefined)
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /"renewed":2,"failed":0/)
  })

  it('exits nonzero when listing rejects', () => {
    const result = runCli('listing-error')
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /mock listing failure/)
    assert.doesNotMatch(result.stdout, /Renewal run summary/)
  })
})
