// One-time bootstrap: exchange an OAuth consent code for a refresh token,
// then create the root Drive folder. Prints the two values (refresh_token,
// folder_id) that you paste into `.env.local` and GitHub Secrets.
//
// Prereq: OAuth 2.0 client (Desktop app type) created in Google Cloud Console,
// with the Drive API enabled. Put client_id / client_secret in `.env.local`.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { resolve } from 'node:path';

const PORT = 8787;
const REDIRECT = `http://localhost:${PORT.toString()}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

interface TokenExchangeResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

interface CreateFolderResponse {
  id: string;
}

function loadDotenvLocal(): void {
  try {
    const text = readFileSync(resolve(process.cwd(), '.env.local'), 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const k = line.slice(0, eq).trim();
      const v = line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    // no .env.local — user may have exported manually
  }
}

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(
      `missing env var: ${name} — put it in .env.local or export it in your shell`,
    );
  }
  return v;
}

function openInBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // non-fatal: user can paste URL manually
  }
}

async function captureCode(): Promise<string> {
  return new Promise<string>((resolveCode, rejectCode) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', `http://localhost:${PORT.toString()}`);
      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      if (error !== null) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end(`OAuth error: ${error}`);
        server.close();
        rejectCode(new Error(`OAuth error: ${error}`));
        return;
      }
      if (code === null) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('no code in redirect');
        server.close();
        rejectCode(new Error('no code in redirect'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<!doctype html><meta charset="utf-8"><h1>OK — you can close this tab.</h1>',
      );
      server.close();
      resolveCode(code);
    });
    server.listen(PORT);
  });
}

async function exchangeCode(
  code: string,
  clientId: string,
  clientSecret: string,
): Promise<TokenExchangeResponse> {
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '<no body>');
    throw new Error(`token exchange failed: ${res.status.toString()} ${t}`);
  }
  return (await res.json()) as TokenExchangeResponse;
}

async function createRootFolder(name: string, accessToken: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/drive/v3/files?fields=id', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '<no body>');
    throw new Error(`folder create failed: ${res.status.toString()} ${t}`);
  }
  const json = (await res.json()) as CreateFolderResponse;
  return json.id;
}

async function main(): Promise<void> {
  loadDotenvLocal();
  const clientId = required('GOOGLE_OAUTH_CLIENT_ID');
  const clientSecret = required('GOOGLE_OAUTH_CLIENT_SECRET');
  const folderName = process.env['DRIVE_FOLDER_NAME'] ?? 'DatovaSchranka';

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  process.stdout.write(
    `\nOpening browser for consent. If it doesn't open, paste this URL manually:\n  ${authUrl.toString()}\n\n`,
  );
  openInBrowser(authUrl.toString());

  const code = await captureCode();
  process.stdout.write('Got auth code. Exchanging for tokens...\n');

  const tokens = await exchangeCode(code, clientId, clientSecret);
  if (tokens.refresh_token === undefined) {
    throw new Error(
      'No refresh_token returned — this usually means this Google account already granted consent to this OAuth client. Revoke access at https://myaccount.google.com/permissions for this app, then re-run the bootstrap.',
    );
  }

  process.stdout.write(`Creating Drive root folder "${folderName}"...\n`);
  const folderId = await createRootFolder(folderName, tokens.access_token);

  process.stdout.write(
    '\n=====================================================\n' +
      '  Add the following to .env.local (local dev) AND to\n' +
      '  the GitHub repo Settings → Secrets and variables → Actions:\n' +
      '=====================================================\n\n' +
      `GOOGLE_OAUTH_REFRESH_TOKEN=${tokens.refresh_token}\n` +
      `DRIVE_FOLDER_ID=${folderId}\n\n` +
      `Folder URL: https://drive.google.com/drive/folders/${folderId}\n`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`bootstrap failed: ${msg}\n`);
  process.exit(1);
});
