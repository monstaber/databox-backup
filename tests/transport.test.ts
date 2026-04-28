import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { TLSSocket } from 'node:tls';
import {
  makeBasicAuthTransport,
  makeCertAuthTransport,
} from '../src/transport.js';

// Generates a self-signed RSA cert + key + matching client PFX in a temp
// directory using the openssl(1) binary already required for ZFO parsing.
// This avoids committing test fixtures and avoids any new dependency.
interface CertSet {
  readonly serverCertPem: Buffer;
  readonly serverKeyPem: Buffer;
  readonly clientCertPem: Buffer;
  readonly clientKeyPem: Buffer;
  readonly clientPfx: Buffer;
  readonly clientPfxPassphrase: string;
  readonly tmpDir: string;
}

function runOpenssl(args: readonly string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('openssl', [...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr: Buffer[] = [];
    proc.stderr.on('data', (c: Buffer) => stderr.push(c));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `openssl ${args.join(' ')} exited ${String(code)}: ${Buffer.concat(stderr).toString('utf8').slice(0, 200)}`,
          ),
        );
    });
  });
}

async function generateCertSet(): Promise<CertSet> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'isds-transport-test-'));
  const passphrase = 'testpass';
  await runOpenssl([
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', join(tmpDir, 'server.key'),
    '-out', join(tmpDir, 'server.crt'),
    '-days', '1', '-nodes',
    '-subj', '/CN=localhost',
  ]);
  await runOpenssl([
    'req', '-x509', '-newkey', 'rsa:2048',
    '-keyout', join(tmpDir, 'client.key'),
    '-out', join(tmpDir, 'client.crt'),
    '-days', '1', '-nodes',
    '-subj', '/CN=test-client',
  ]);
  await runOpenssl([
    'pkcs12', '-export',
    '-out', join(tmpDir, 'client.p12'),
    '-inkey', join(tmpDir, 'client.key'),
    '-in', join(tmpDir, 'client.crt'),
    '-password', `pass:${passphrase}`,
  ]);
  return {
    serverCertPem: readFileSync(join(tmpDir, 'server.crt')),
    serverKeyPem: readFileSync(join(tmpDir, 'server.key')),
    clientCertPem: readFileSync(join(tmpDir, 'client.crt')),
    clientKeyPem: readFileSync(join(tmpDir, 'client.key')),
    clientPfx: readFileSync(join(tmpDir, 'client.p12')),
    clientPfxPassphrase: passphrase,
    tmpDir,
  };
}

interface CapturedRequest {
  authorization: string | undefined;
  contentType: string | undefined;
  body: string;
  hasPeerCert: boolean;
  peerCertSubject: string | undefined;
}

function startServer(
  certs: CertSet,
  onRequest: (req: CapturedRequest) => { status: number; body: string },
): Promise<{ server: Server; url: string }> {
  return new Promise((resolveServer) => {
    const server = createServer(
      {
        cert: certs.serverCertPem,
        key: certs.serverKeyPem,
        // requestCert demands a client cert; rejectUnauthorized:false lets the
        // server accept self-signed clients so we can inspect getPeerCertificate.
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const peer = (req.socket as TLSSocket).getPeerCertificate();
          const auth = req.headers['authorization'];
          const ct = req.headers['content-type'];
          const captured: CapturedRequest = {
            authorization: typeof auth === 'string' ? auth : undefined,
            contentType: typeof ct === 'string' ? ct : undefined,
            body: Buffer.concat(chunks).toString('utf8'),
            hasPeerCert: peer !== null && Object.keys(peer).length > 0,
            peerCertSubject: typeof peer.subject?.CN === 'string' ? peer.subject.CN : undefined,
          };
          const out = onRequest(captured);
          res.writeHead(out.status, { 'Content-Type': 'text/xml' });
          res.end(out.body);
        });
      },
    );
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        throw new Error('unexpected server address');
      }
      resolveServer({ server, url: `https://127.0.0.1:${String(addr.port)}/DS/dx` });
    });
  });
}

describe('transport — real local HTTPS round-trips', () => {
  let certs: CertSet;
  // Both transports point at a self-signed local server. Disable global TLS
  // verification only for the duration of this test file; restored in after().
  let originalReject: string | undefined;

  before(async () => {
    originalReject = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    certs = await generateCertSet();
  });

  after(() => {
    if (originalReject === undefined) delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    else process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = originalReject;
    rmSync(certs.tmpDir, { recursive: true, force: true });
  });

  it('basic transport sends Authorization: Basic <b64(user:pass)>', async () => {
    let captured: CapturedRequest | undefined;
    const { server, url } = await startServer(certs, (req) => {
      captured = req;
      return { status: 200, body: '<ok/>' };
    });
    try {
      const transport = makeBasicAuthTransport('alice', 'rabbit');
      const body = await transport.call(url, '<envelope/>');
      assert.equal(body, '<ok/>');
      transport.destroy();
    } finally {
      server.close();
    }
    assert.ok(captured, 'request captured');
    assert.equal(
      captured.authorization,
      'Basic ' + Buffer.from('alice:rabbit', 'utf8').toString('base64'),
    );
    assert.match(captured.contentType ?? '', /^text\/xml/);
    assert.equal(captured.body, '<envelope/>');
  });

  it('cert transport (PFX) presents a peer cert and sends NO Authorization header', async () => {
    let captured: CapturedRequest | undefined;
    const { server, url } = await startServer(certs, (req) => {
      captured = req;
      return { status: 200, body: '<ok/>' };
    });
    try {
      const transport = makeCertAuthTransport({
        kind: 'pfx',
        pfx: certs.clientPfx,
        passphrase: certs.clientPfxPassphrase,
      });
      const body = await transport.call(url, '<envelope/>');
      assert.equal(body, '<ok/>');
      transport.destroy();
    } finally {
      server.close();
    }
    assert.ok(captured, 'request captured');
    assert.equal(captured.authorization, undefined, 'no Authorization header on /cert/ path');
    assert.equal(captured.hasPeerCert, true, 'server saw a client certificate');
    assert.equal(captured.peerCertSubject, 'test-client');
  });

  it('cert transport (PEM pair) presents a peer cert and sends NO Authorization header', async () => {
    let captured: CapturedRequest | undefined;
    const { server, url } = await startServer(certs, (req) => {
      captured = req;
      return { status: 200, body: '<ok/>' };
    });
    try {
      const transport = makeCertAuthTransport({
        kind: 'pem',
        cert: certs.clientCertPem,
        key: certs.clientKeyPem,
      });
      const body = await transport.call(url, '<envelope/>');
      assert.equal(body, '<ok/>');
      transport.destroy();
    } finally {
      server.close();
    }
    assert.ok(captured, 'request captured');
    assert.equal(captured.authorization, undefined, 'no Authorization header on /cert/ path');
    assert.equal(captured.hasPeerCert, true, 'server saw a client certificate');
    assert.equal(captured.peerCertSubject, 'test-client');
  });

  it('basic transport throws on non-2xx with truncated body', async () => {
    const { server, url } = await startServer(certs, () => ({
      status: 401,
      body: 'unauthorized',
    }));
    try {
      const transport = makeBasicAuthTransport('alice', 'wrong');
      await assert.rejects(
        () => transport.call(url, '<envelope/>'),
        (err: unknown) =>
          err instanceof Error &&
          err.message.includes('401') &&
          err.message.includes('unauthorized'),
      );
      transport.destroy();
    } finally {
      server.close();
    }
  });
});
