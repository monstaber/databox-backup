import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { XMLParser } from 'fast-xml-parser';
import { log } from './log.js';

// Parser tuned like src/isds-xml.ts: strip prefixes so we can look up elements
// by bare name regardless of the namespace prefix the signer used.
const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

// Unwrap the PKCS#7/CMS envelope around a signed ZFO via the system `openssl`
// binary and return the count of `<dmFile>` children inside `<dmFiles>`.
// Returns `null` if any step fails (subprocess missing, unexpected structure,
// parse error) so the caller can fall back to a `?` placeholder without
// failing the run.
export async function countAttachmentsInZfo(zfo: Buffer): Promise<number | null> {
  try {
    const xml = await unwrapCms(zfo);
    const parsed = parser.parse(xml) as unknown;
    return countDmFiles(parsed);
  } catch (err) {
    log.warn('zfo: could not count attachments', { error: errMsg(err) });
    return null;
  }
}

function unwrapCms(zfo: Buffer): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const proc = spawn('openssl', ['cms', '-verify', '-noverify', '-inform', 'DER'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => stdout.push(c));
    proc.stderr.on('data', (c: Buffer) => stderr.push(c));
    proc.on('error', (e) => {
      reject(e);
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        const err = Buffer.concat(stderr).toString('utf8').slice(0, 200);
        reject(new Error(`openssl cms exited ${code?.toString() ?? '?'}: ${err}`));
        return;
      }
      resolve(Buffer.concat(stdout).toString('utf8'));
    });
    proc.stdin.write(zfo);
    proc.stdin.end();
  });
}

// Walks the parsed XML tree looking for a `dmFiles` object and counts its
// `dmFile` children. fast-xml-parser represents a single child as an object
// and multiple children as an array.
function countDmFiles(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0;
  for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'dmFiles' && val !== null && typeof val === 'object') {
      const files = (val as Record<string, unknown>)['dmFile'];
      if (Array.isArray(files)) return files.length;
      if (files !== undefined && files !== null) return 1;
      return 0;
    }
    const sub = countDmFiles(val);
    if (sub > 0) return sub;
  }
  return 0;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
