import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import type { CertCred } from './config.js';

export interface CertInfo {
  readonly subject: string;
  readonly issuer: string;
  readonly validTo: string;
  readonly daysUntilExpiry: number;
}

// Inspect the client cert from either a PEM or PFX credential so the run log
// shows which cert is in use. Best-effort: returns null on any failure
// (missing openssl, legacy-encryption PFX that the local OpenSSL build
// rejects, parse error). Failure to inspect must not block the actual SOAP
// calls — Node's native TLS layer parses the credential independently.
export async function inspectCertCred(cred: CertCred): Promise<CertInfo | null> {
  try {
    const pem = cred.kind === 'pem' ? cred.cert.toString('utf8') : await pfxToCertPem(cred.pfx, cred.passphrase);
    const cert = new X509Certificate(pem);
    const validTo = new Date(cert.validTo);
    const days = Math.floor((validTo.getTime() - Date.now()) / 86_400_000);
    return {
      subject: cert.subject,
      issuer: cert.issuer,
      validTo: validTo.toISOString(),
      daysUntilExpiry: days,
    };
  } catch {
    return null;
  }
}

function pfxToCertPem(pfx: Buffer, passphrase: string | undefined): Promise<string> {
  // Pass the passphrase via a private env var (not argv) so it doesn't leak
  // into ps(1) output. PFX bytes go in over stdin via /dev/stdin.
  const PASS_VAR = '_DATABOX_PFX_PASSPHRASE';
  const args = [
    'pkcs12',
    '-in',
    '/dev/stdin',
    '-nokeys',
    '-clcerts',
    '-passin',
    `env:${PASS_VAR}`,
  ];
  return runOpenssl(args, pfx, { [PASS_VAR]: passphrase ?? '' }).catch(() =>
    // Some CA-issued PFX files use legacy 3DES/RC2 encryption that openssl 3.x
    // refuses to decrypt without the -legacy provider. Retry once with it.
    runOpenssl([...args, '-legacy'], pfx, { [PASS_VAR]: passphrase ?? '' }),
  );
}

function runOpenssl(
  args: readonly string[],
  stdin: Buffer,
  extraEnv: Record<string, string>,
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn('openssl', [...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => stdout.push(c));
    proc.stderr.on('data', (c: Buffer) => stderr.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        const e = Buffer.concat(stderr).toString('utf8').slice(0, 200);
        reject(new Error(`openssl pkcs12 exited ${String(code)}: ${e}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
    proc.stdin.write(stdin);
    proc.stdin.end();
  });
}
