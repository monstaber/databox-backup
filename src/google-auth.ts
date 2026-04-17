import { log } from './log.js';

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export class GoogleAuth {
  private cached: { token: string; expiresAt: number } | null = null;

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly refreshToken: string,
  ) {}

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt - 60_000 > now) {
      return this.cached.token;
    }
    log.debug('google-auth: refreshing access token');
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '<no body>');
      // Do not log secrets; the refresh-token error body from Google does not echo secrets.
      throw new Error(
        `google token refresh failed: ${res.status} ${res.statusText} — ${truncate(text)}`,
      );
    }
    const json = (await res.json()) as TokenResponse;
    this.cached = {
      token: json.access_token,
      expiresAt: now + json.expires_in * 1000,
    };
    return json.access_token;
  }
}

function truncate(s: string, n = 200): string {
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}
