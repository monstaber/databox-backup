import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { describe, it } from 'node:test';
import { loadIsdsAuth } from '../src/config.js';

// Synthetic placeholder bytes — not real certificate material. The auth
// loader only round-trips base64 here; cert validity is enforced later by
// Node's TLS layer, so a non-empty buffer is enough to exercise the branch.
const placeholderPfx = Buffer.from([0x30, 0x82, 0x01, 0x00, 0xde, 0xad, 0xbe, 0xef]);
const placeholderPfxB64 = placeholderPfx.toString('base64');
const placeholderCertPem = Buffer.from('-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----\n');
const placeholderCertB64 = placeholderCertPem.toString('base64');
const placeholderKeyPem = Buffer.from('-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----\n');
const placeholderKeyB64 = placeholderKeyPem.toString('base64');

describe('loadIsdsAuth — env-var precedence', () => {
  it('selects PFX cert mode when PFX_BASE64 is set', () => {
    const auth = loadIsdsAuth({
      ISDS_CERT_PFX_BASE64: placeholderPfxB64,
      ISDS_CERT_PFX_PASSPHRASE: 'hunter2',
      ISDS_USERNAME: 'shouldBeIgnored',
      ISDS_PASSWORD: 'shouldBeIgnoredToo',
    });
    assert.equal(auth.mode, 'cert');
    if (auth.mode !== 'cert') return;
    assert.equal(auth.cred.kind, 'pfx');
    if (auth.cred.kind !== 'pfx') return;
    assert.equal(auth.cred.passphrase, 'hunter2');
    assert.equal(auth.cred.pfx.equals(placeholderPfx), true);
  });

  it('selects PEM cert mode when both PEM vars are set', () => {
    const auth = loadIsdsAuth({
      ISDS_CERT_PEM_BASE64: placeholderCertB64,
      ISDS_KEY_PEM_BASE64: placeholderKeyB64,
    });
    assert.equal(auth.mode, 'cert');
    if (auth.mode !== 'cert') return;
    assert.equal(auth.cred.kind, 'pem');
    if (auth.cred.kind !== 'pem') return;
    assert.equal(auth.cred.cert.equals(placeholderCertPem), true);
    assert.equal(auth.cred.key.equals(placeholderKeyPem), true);
  });

  it('PEM pair takes precedence over PFX when all are set', () => {
    const auth = loadIsdsAuth({
      ISDS_CERT_PEM_BASE64: placeholderCertB64,
      ISDS_KEY_PEM_BASE64: placeholderKeyB64,
      ISDS_CERT_PFX_BASE64: placeholderPfxB64,
      ISDS_CERT_PFX_PASSPHRASE: 'ignored',
    });
    assert.equal(auth.mode, 'cert');
    if (auth.mode !== 'cert') return;
    assert.equal(auth.cred.kind, 'pem');
  });

  it('throws when only one of the PEM pair is provided', () => {
    assert.throws(
      () =>
        loadIsdsAuth({
          ISDS_CERT_PEM_BASE64: placeholderCertB64,
          // ISDS_KEY_PEM_BASE64 missing
        }),
      /must be set together/,
    );
    assert.throws(
      () =>
        loadIsdsAuth({
          ISDS_KEY_PEM_BASE64: placeholderKeyB64,
        }),
      /must be set together/,
    );
  });

  it('cert mode wins even when basic creds are also configured (no fallback)', () => {
    const auth = loadIsdsAuth({
      ISDS_CERT_PFX_BASE64: placeholderPfxB64,
      ISDS_USERNAME: 'u',
      ISDS_PASSWORD: 'p',
    });
    assert.equal(auth.mode, 'cert');
  });

  it('PFX cert mode allows an empty passphrase (PFX without one)', () => {
    const auth = loadIsdsAuth({
      ISDS_CERT_PFX_BASE64: placeholderPfxB64,
    });
    assert.equal(auth.mode, 'cert');
    if (auth.mode !== 'cert' || auth.cred.kind !== 'pfx') return;
    assert.equal(auth.cred.passphrase, undefined);
  });

  it('selects basic mode when no cert credentials are present', () => {
    const auth = loadIsdsAuth({
      ISDS_USERNAME: 'user',
      ISDS_PASSWORD: 'pass',
    });
    assert.equal(auth.mode, 'basic');
    if (auth.mode !== 'basic') return;
    assert.equal(auth.username, 'user');
    assert.equal(auth.password, 'pass');
  });

  it('treats empty cert env vars as absent and falls back to basic', () => {
    const auth = loadIsdsAuth({
      ISDS_CERT_PFX_BASE64: '',
      ISDS_CERT_PEM_BASE64: '',
      ISDS_KEY_PEM_BASE64: '',
      ISDS_USERNAME: 'user',
      ISDS_PASSWORD: 'pass',
    });
    assert.equal(auth.mode, 'basic');
  });

  it('strips whitespace inside the base64 values', () => {
    const wrapped = `${placeholderPfxB64.slice(0, 4)}\n${placeholderPfxB64.slice(4)}`;
    const auth = loadIsdsAuth({ ISDS_CERT_PFX_BASE64: wrapped });
    assert.equal(auth.mode, 'cert');
    if (auth.mode !== 'cert' || auth.cred.kind !== 'pfx') return;
    assert.equal(auth.cred.pfx.equals(placeholderPfx), true);
  });

  it('throws when neither cert nor basic credentials are provided', () => {
    assert.throws(
      () => loadIsdsAuth({}),
      /missing required env var: ISDS_USERNAME/,
    );
  });

  it('throws when only username is set (password missing)', () => {
    assert.throws(
      () => loadIsdsAuth({ ISDS_USERNAME: 'u' }),
      /missing required env var: ISDS_PASSWORD/,
    );
  });

  it('throws on garbage base64 in PFX_BASE64', () => {
    assert.throws(
      () => loadIsdsAuth({ ISDS_CERT_PFX_BASE64: '!!!not-base64!!!' }),
      /not valid base64/,
    );
  });

  it('throws on garbage base64 in PEM vars', () => {
    assert.throws(
      () =>
        loadIsdsAuth({
          ISDS_CERT_PEM_BASE64: '!!!nope!!!',
          ISDS_KEY_PEM_BASE64: placeholderKeyB64,
        }),
      /not valid base64/,
    );
  });
});
