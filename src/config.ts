import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface IsdsEndpoints {
  // dmInfoWebService — list messages, (signed) delivery info
  readonly info: string;
  // dmOperationsWebService — (signed) message download
  readonly operations: string;
}

export interface Config {
  readonly isds: {
    // Login code assigned to you as a user of a specific schránka
    // (6-12 lowercase alphanumeric chars, e.g. "d2in23"). NOT the same as the
    // schránka's own dbID — one physical person can hold multiple schránky
    // and gets a separate username for each.
    readonly username: string;
    readonly password: string;
    // The schránka's own identifier (7 chars, e.g. "3viy925"). Used for:
    // (a) self-documentation in folder paths on Drive,
    // (b) runtime sanity check that the credentials opened the schránka we
    //     expected. NOT sent to ISDS — auth scope handles routing.
    readonly dbId: string;
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

const ISDS_ENDPOINTS = {
  production: {
    info: 'https://ws1.mojedatovaschranka.cz/DS/dx',
    operations: 'https://ws1.mojedatovaschranka.cz/DS/dz',
  },
  test: {
    info: 'https://ws1.czebox.cz/DS/dx',
    operations: 'https://ws1.czebox.cz/DS/dz',
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

// Load only the ISDS portion of the config. Kept separate from the full
// loadConfig so that ISDS-only entry points don't need to demand Google
// credentials.
export function loadIsdsConfig(): Config['isds'] {
  loadDotenvLocalInto(process.env);
  const which = process.env['ISDS_ENV']?.toLowerCase() === 'test' ? 'test' : 'production';
  return {
    username: required('ISDS_USERNAME', process.env),
    password: required('ISDS_PASSWORD', process.env),
    dbId: required('ISDS_DBID', process.env),
    endpoints: ISDS_ENDPOINTS[which],
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
