import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

describe('getRegisterApiOrigin', () => {
  let saved;

  beforeEach(() => {
    saved = { ...process.env };
  });

  afterEach(() => {
    delete process.env.JUMPSH_API;
    delete process.env.JUMPSH_API_ORIGIN;
    if (saved.JUMPSH_API) process.env.JUMPSH_API = saved.JUMPSH_API;
    if (saved.JUMPSH_API_ORIGIN) process.env.JUMPSH_API_ORIGIN = saved.JUMPSH_API_ORIGIN;
  });

  it('returns JUMPSH_API when set', async () => {
    process.env.JUMPSH_API = 'https://custom.api';
    process.env.JUMPSH_API_ORIGIN = 'https://fallback';
    // Re-import to pick up env
    const { getRegisterApiOrigin } = await import('../lib/ssh-register.js?t=1');
    assert.equal(getRegisterApiOrigin(), 'https://custom.api');
  });

  it('falls back to JUMPSH_API_ORIGIN', async () => {
    delete process.env.JUMPSH_API;
    process.env.JUMPSH_API_ORIGIN = 'https://fallback';
    const { getRegisterApiOrigin } = await import('../lib/ssh-register.js?t=2');
    assert.equal(getRegisterApiOrigin(), 'https://fallback');
  });

  it('falls back to default', async () => {
    delete process.env.JUMPSH_API;
    delete process.env.JUMPSH_API_ORIGIN;
    const { getRegisterApiOrigin } = await import('../lib/ssh-register.js?t=3');
    assert.equal(getRegisterApiOrigin(), 'https://api.jump.sh');
  });
});

describe('detectGitHubUsername', () => {
  it('is a function', async () => {
    const { detectGitHubUsername } = await import('../lib/ssh-register.js');
    assert.equal(typeof detectGitHubUsername, 'function');
  });

  // Note: actual GitHub detection requires network + SSH key,
  // so we only verify the function exists and returns string|null.
  it('returns string or null', async () => {
    const { detectGitHubUsername } = await import('../lib/ssh-register.js');
    const result = detectGitHubUsername();
    assert.ok(result === null || typeof result === 'string');
  });
});

describe('signChallenge', () => {
  it('throws when no keys in agent', async () => {
    const { signChallenge } = await import('../lib/ssh-register.js');
    // Pass keys that won't match anything in agent
    const fakeKeys = ['ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeKeyThatDoesNotExist fake@test'];
    await assert.rejects(
      () => signChallenge('test-nonce', fakeKeys),
      (err) => {
        assert.ok(err.message.includes('SSH key') || err.message.includes('agent'));
        return true;
      }
    );
  });

  it('throws on empty keys array', async () => {
    const { signChallenge } = await import('../lib/ssh-register.js');
    await assert.rejects(
      () => signChallenge('test-nonce', []),
      (err) => {
        assert.ok(err.message.includes('match') || err.message.includes('agent'));
        return true;
      }
    );
  });
});
