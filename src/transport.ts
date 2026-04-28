import { Buffer } from 'node:buffer';
import https from 'node:https';
import { URL } from 'node:url';
import type { CertCred } from './config.js';

// Thin abstraction over a SOAP POST so the IsdsClient doesn't have to know
// whether it is talking to /DS/... (Basic auth, no client cert) or
// /cert/DS/... (mTLS only, no Authorization header). Both transports share
// identical request/response semantics: POST text/xml body, return body
// string on 2xx, throw with a truncated body on non-2xx.
export interface IsdsTransport {
  call(endpoint: string, envelope: string): Promise<string>;
}

interface RequestResult {
  readonly statusCode: number;
  readonly statusMessage: string;
  readonly body: string;
}

// Node TLS layer error codes that mean "your client certificate did not pass
// the server's check" rather than a generic socket failure. Mapping these to
// a clear message saves users from wading through ECONNRESET / EPROTO logs.
const CERT_REJECT_CODES = new Set([
  'EPROTO',
  'ECONNRESET',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA',
  'ERR_SSL_SSLV3_ALERT_BAD_CERTIFICATE',
  'ERR_SSL_SSLV3_ALERT_CERTIFICATE_EXPIRED',
  'ERR_SSL_SSLV3_ALERT_CERTIFICATE_REVOKED',
]);

interface AgentLike {
  destroy(): void;
}

interface BasicAuthTransport extends IsdsTransport {
  destroy(): void;
}

interface CertAuthTransport extends IsdsTransport {
  destroy(): void;
}

export function makeBasicAuthTransport(
  username: string,
  password: string,
): BasicAuthTransport {
  const authHeader =
    'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  // Shared keep-alive agent so successive SOAP calls in one run reuse the TLS
  // session. maxSockets bounds parallelism conservatively.
  const agent = new https.Agent({ keepAlive: true, maxSockets: 8 });
  return {
    async call(endpoint: string, envelope: string): Promise<string> {
      const result = await postXml(endpoint, envelope, {
        agent,
        extraHeaders: { Authorization: authHeader },
      });
      throwIfNotOk(result);
      return result.body;
    },
    destroy: () => agent.destroy(),
  };
}

export function makeCertAuthTransport(cred: CertCred): CertAuthTransport {
  // Single agent carries the client cert; reused across all calls. The same
  // agent is what produces a client certificate during the TLS handshake.
  // Either a PFX bundle + passphrase, or a separate PEM cert + key, can
  // satisfy https.Agent — Node's TLS layer accepts both shapes.
  const credOpts =
    cred.kind === 'pem'
      ? { cert: cred.cert, key: cred.key }
      : { pfx: cred.pfx, passphrase: cred.passphrase };
  const agent = new https.Agent({
    ...credOpts,
    keepAlive: true,
    maxSockets: 8,
  });
  return {
    async call(endpoint: string, envelope: string): Promise<string> {
      let result: RequestResult;
      try {
        result = await postXml(endpoint, envelope, { agent });
      } catch (err) {
        throw wrapTlsError(err);
      }
      throwIfNotOk(result);
      return result.body;
    },
    destroy: () => agent.destroy(),
  };
}

interface PostOptions {
  readonly agent: AgentLike & https.Agent;
  readonly extraHeaders?: Record<string, string>;
}

function postXml(
  endpoint: string,
  body: string,
  opts: PostOptions,
): Promise<RequestResult> {
  return new Promise<RequestResult>((resolve, reject) => {
    const url = new URL(endpoint);
    const bodyBuf = Buffer.from(body, 'utf8');
    const headers: Record<string, string> = {
      'Content-Type': 'text/xml; charset=utf-8',
      'Content-Length': String(bodyBuf.length),
      Accept: 'text/xml',
      SOAPAction: '""',
      ...opts.extraHeaders,
    };
    const req = https.request(
      {
        method: 'POST',
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        headers,
        agent: opts.agent,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            statusMessage: res.statusMessage ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
}

function throwIfNotOk(result: RequestResult): void {
  if (result.statusCode >= 200 && result.statusCode < 300) return;
  throw new Error(
    `ISDS HTTP ${String(result.statusCode)} ${result.statusMessage} — ${truncate(result.body)}`,
  );
}

function wrapTlsError(err: unknown): Error {
  const code = errorCode(err);
  if (code !== undefined && CERT_REJECT_CODES.has(code)) {
    return new Error(
      `ISDS: client certificate rejected by server (${code}). Verify the cert is registered against this schránka via DS web UI → Nastavení → Externí aplikace, and that the PFX/passphrase env vars match.`,
    );
  }
  return err instanceof Error ? err : new Error(String(err));
}

function errorCode(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function truncate(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}
