import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface IsdsEndpoints {
  // dmInfoWebService — list messages, (signed) delivery info
  readonly info: string;
  // dmOperationsWebService — (signed) message download
  readonly operations: string;
}

// Two auth modes against ISDS. The /cert/DS/... endpoints accept only mTLS
// with a registered system certificate (no Authorization header); the /DS/...
// endpoints accept only HTTP Basic. Selection is by env-var presence: if a
// cert credential is provided (PEM-pair OR PFX) it wins, with no fallback
// to credentials. See loadIsdsConfig for the precedence rules.
export type CertCred =
  | { readonly kind: 'pem'; readonly cert: Buffer; readonly key: Buffer }
  | { readonly kind: 'pfx'; readonly pfx: Buffer; readonly passphrase: string | undefined };

export type IsdsAuth =
  | { readonly mode: 'basic'; readonly username: string; readonly password: string }
  | { readonly mode: 'cert'; readonly cred: CertCred };

export interface Config {
  readonly isds: {
    // The schránka's own identifier (7 chars, e.g. "xyz1234"). Used for:
    // (a) self-documentation in folder paths on Drive,
    // (b) runtime sanity check that the credentials/cert opened the schránka
    //     we expected. NOT sent to ISDS — auth scope handles routing.
    readonly dbId: string;
    readonly auth: IsdsAuth;
    readonly endpoints: IsdsEndpoints;
  };
  readonly google: {
    readonly clientId: string;
    readonly clientSecret: string;
    readonly refreshToken: string;
  };
  readonly drive: {
    readonly rootFolderId: string;
  };
  readonly run: {
    readonly lookbackDays: number;
    readonly concurrency: number;
    readonly verbose: boolean;
  };
}

// Endpoint host & path differs by auth mode: cert auth requires the ws1c host
// AND a /cert path prefix on top of the per-service postfix. Both differences
// are mandatory — rewriting only the path is not sufficient.
const ISDS_ENDPOINTS = {
  production: {
    basic: {
      info: 'https://ws1.mojedatovaschranka.cz/DS/dx',
      operations: 'https://ws1.mojedatovaschranka.cz/DS/dz',
    },
    cert: {
      info: 'https://ws1c.mojedatovaschranka.cz/cert/DS/dx',
      operations: 'https://ws1c.mojedatovaschranka.cz/cert/DS/dz',
    },
  },
  test: {
    basic: {
      info: 'https://ws1.czebox.cz/DS/dx',
      operations: 'https://ws1.czebox.cz/DS/dz',
    },
    cert: {
      info: 'https://ws1c.czebox.cz/cert/DS/dx',
      operations: 'https://ws1c.czebox.cz/cert/DS/dz',
    },
  },
} as const;

function loadDotenvLocalInto(env: NodeJS.ProcessEnv): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (env[key] === undefined) env[key] = value;
    }
  } catch {
    // no .env.local — fine in CI
  }
}

function required(name: string, env: NodeJS.ProcessEnv): string {
  const v = env[name];
  if (v === undefined || v === '') {
    throw new Error(`missing required env var: ${name}`);
  }
  return v;
}

function nonEmpty(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const v = env[name];
  return v === undefined || v === '' ? undefined : v;
}

function decodeBase64(b64: string, varName: string): Buffer {
  // Strip whitespace so that accidentally-wrapped values still decode. Empty
  // input has been ruled out before this is called.
  const stripped = b64.replace(/\s+/g, '');
  // Buffer.from is permissive; check the round-trip to detect corruption.
  const buf = Buffer.from(stripped, 'base64');
  if (
    buf.length === 0 ||
    buf.toString('base64').replace(/=+$/, '') !== stripped.replace(/=+$/, '')
  ) {
    throw new Error(`${varName} is not valid base64 (decoded round-trip mismatch)`);
  }
  return buf;
}

function loadCertCred(env: NodeJS.ProcessEnv): CertCred | undefined {
  // PEM pair takes precedence over PFX. The two PEM vars are required as a
  // pair — providing one without the other is a configuration error.
  const certB64 = nonEmpty('ISDS_CERT_PEM_BASE64', env);
  const keyB64 = nonEmpty('ISDS_KEY_PEM_BASE64', env);
  if (certB64 !== undefined && keyB64 !== undefined) {
    return {
      kind: 'pem',
      cert: decodeBase64(certB64, 'ISDS_CERT_PEM_BASE64'),
      key: decodeBase64(keyB64, 'ISDS_KEY_PEM_BASE64'),
    };
  }
  if (certB64 !== undefined || keyB64 !== undefined) {
    throw new Error(
      'ISDS_CERT_PEM_BASE64 and ISDS_KEY_PEM_BASE64 must be set together',
    );
  }
  const pfxB64 = nonEmpty('ISDS_CERT_PFX_BASE64', env);
  if (pfxB64 !== undefined) {
    return {
      kind: 'pfx',
      pfx: decodeBase64(pfxB64, 'ISDS_CERT_PFX_BASE64'),
      passphrase: nonEmpty('ISDS_CERT_PFX_PASSPHRASE', env),
    };
  }
  return undefined;
}

export function loadIsdsAuth(env: NodeJS.ProcessEnv = process.env): IsdsAuth {
  const cred = loadCertCred(env);
  if (cred !== undefined) return { mode: 'cert', cred };
  return {
    mode: 'basic',
    username: required('ISDS_USERNAME', env),
    password: required('ISDS_PASSWORD', env),
  };
}

// Load only the ISDS portion of the config. Kept separate from the full
// loadConfig so that ISDS-only entry points don't need to demand Google
// credentials.
export function loadIsdsConfig(): Config['isds'] {
  loadDotenvLocalInto(process.env);
  const which = process.env['ISDS_ENV']?.toLowerCase() === 'test' ? 'test' : 'production';
  const auth = loadIsdsAuth(process.env);
  return {
    dbId: required('ISDS_DBID', process.env),
    auth,
    endpoints: ISDS_ENDPOINTS[which][auth.mode],
  };
}

export function loadConfig(): Config {
  const isds = loadIsdsConfig();
  return {
    isds,
    google: {
      clientId: required('GOOGLE_OAUTH_CLIENT_ID', process.env),
      clientSecret: required('GOOGLE_OAUTH_CLIENT_SECRET', process.env),
      refreshToken: required('GOOGLE_OAUTH_REFRESH_TOKEN', process.env),
    },
    drive: {
      rootFolderId: required('DRIVE_FOLDER_ID', process.env),
    },
    run: {
      lookbackDays: Number(process.env['LOOKBACK_DAYS'] ?? 95),
      concurrency: Number(process.env['MAX_CONCURRENCY'] ?? 4),
      verbose: process.env['VERBOSE'] === '1',
    },
  };
}
