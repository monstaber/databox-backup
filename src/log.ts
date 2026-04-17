// Minimal structured logger. Never logs request/response bodies — only
// short, grepable status lines. Callers must not pass raw SOAP envelopes or
// Drive payloads; see ISDS_SAFE_FIELDS below if you need to widen surface.

type Level = 'info' | 'warn' | 'error' | 'debug';

let verbose = false;

export function setVerbose(v: boolean): void {
  verbose = v;
}

function emit(level: Level, msg: string, extra?: Record<string, unknown>): void {
  if (level === 'debug' && !verbose) return;
  const ts = new Date().toISOString();
  const parts: string[] = [`[${ts}] ${level}: ${msg}`];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined) continue;
      parts.push(`${k}=${formatValue(v)}`);
    }
  }
  const line = parts.join(' ');
  if (level === 'error' || level === 'warn') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

function formatValue(v: unknown): string {
  if (typeof v === 'string') {
    return v.length > 120 ? JSON.stringify(v.slice(0, 117) + '...') : JSON.stringify(v);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  try {
    const s = JSON.stringify(v);
    return s.length > 200 ? s.slice(0, 197) + '...' : s;
  } catch {
    return '<unserializable>';
  }
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
  debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', msg, extra),
};
