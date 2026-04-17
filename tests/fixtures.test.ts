import { strict as assert } from 'node:assert';
import { Buffer } from 'node:buffer';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { IsdsClient } from '../src/isds.js';
import {
  parseGetSignedDeliveryInfoResponse,
  parseListResponse,
  parseSignedDownloadResponse,
} from '../src/isds-xml.js';

const FIXTURES_DIR = resolve(process.cwd(), 'tests/fixtures');

// Real values used during capture — must NEVER appear in committed fixtures.
// Any one of these surfacing here is a redaction regression, flag hard.
const LEAK_TOKENS: readonly string[] = [
  // real dmIDs (kept + deleted ones)
  '1681224087',
  '1674308973',
  '1681013424',
  '1680620313',
  '1670515679',
  '1680627730',
  // real dbIDs
  '3viy925',
  'kq4aawz',
  '7y7abii',
  '29acihr',
  // identifying strings
  'Campbell',
  'Ministerstvo',
  'Vodafone',
  'Brně',
  'Havlenova',
];

const DUMMY_DMIDS = ['1313131313', '1313131314', '1313131315', '1313131316'] as const;

interface Fixture {
  readonly name: string;
  readonly path: string;
  readonly text: string;
}

function listFixtures(predicate: (name: string) => boolean): Fixture[] {
  if (!existsSync(FIXTURES_DIR)) return [];
  return readdirSync(FIXTURES_DIR)
    .filter(predicate)
    .sort()
    .map((name) => {
      const path = resolve(FIXTURES_DIR, name);
      return { name, path, text: readFileSync(path, 'utf8') };
    });
}

function assertNoLeaks(name: string, text: string): void {
  for (const token of LEAK_TOKENS) {
    assert.equal(
      text.includes(token),
      false,
      `redaction regression: "${token}" leaked into ${name}`,
    );
  }
}

// ---------- list responses ----------

describe('fixtures: list responses', () => {
  for (const direction of ['received', 'sent'] as const) {
    for (const fx of listFixtures((n) => n === `list_${direction}.xml`)) {
      it(`parses ${fx.name}`, () => {
        const result = parseListResponse(fx.text, direction);
        assert.equal(result.status.code, '0000', 'dmStatusCode is success');
        assert.ok(result.messages.length >= 1, 'at least one message listed');
        for (const m of result.messages) {
          assert.equal(m.direction, direction);
          assert.ok(
            (DUMMY_DMIDS as readonly string[]).includes(m.dmId),
            `dmId ${m.dmId} is one of the dummy IDs`,
          );
          assert.ok(Number.isInteger(m.dmStatus), 'dmStatus is an integer');
        }
        assertNoLeaks(fx.name, fx.text);
      });
    }
  }
});

// ---------- signed download responses ----------

describe('fixtures: signed message download responses', () => {
  const fixtures = listFixtures(
    (n) => /^msg_\d+_(received|sent)\.soap\.xml$/.test(n) && !n.includes('dorucenka'),
  );

  it('found all expected download fixtures', () => {
    assert.equal(fixtures.length, 4, 'exactly 4 download soap fixtures');
  });

  for (const fx of fixtures) {
    it(`parses ${fx.name} and round-trips base64 -> .zfo`, () => {
      const result = parseSignedDownloadResponse(fx.text);
      assert.equal(result.status.code, '0000');
      assert.ok(result.signatureB64.length > 0, 'dmSignature has content');

      const zfoPath = fx.path.replace(/\.soap\.xml$/, '.zfo');
      assert.ok(existsSync(zfoPath), `sibling .zfo exists: ${zfoPath}`);
      const zfoBytes = readFileSync(zfoPath);
      const decoded = Buffer.from(result.signatureB64, 'base64');
      assert.equal(
        decoded.compare(zfoBytes),
        0,
        'base64-decoded dmSignature matches .zfo bytes exactly',
      );

      assertNoLeaks(fx.name, fx.text);
    });
  }
});

// ---------- signed dorucenka (delivery info) responses ----------

describe('fixtures: signed dorucenka responses', () => {
  const fixtures = listFixtures((n) =>
    /^msg_\d+_(received|sent)\.dorucenka\.soap\.xml$/.test(n),
  );

  it('found all expected dorucenka fixtures', () => {
    assert.equal(fixtures.length, 4, 'exactly 4 dorucenka soap fixtures');
  });

  for (const fx of fixtures) {
    it(`parses ${fx.name} and round-trips base64 -> .dorucenka.zfo`, () => {
      const result = parseGetSignedDeliveryInfoResponse(fx.text);
      assert.equal(result.status.code, '0000');
      assert.ok(result.signatureB64.length > 0);

      const zfoPath = fx.path.replace(/\.soap\.xml$/, '.zfo');
      assert.ok(existsSync(zfoPath));
      const zfoBytes = readFileSync(zfoPath);
      const decoded = Buffer.from(result.signatureB64, 'base64');
      assert.equal(decoded.compare(zfoBytes), 0);

      assertNoLeaks(fx.name, fx.text);
    });
  }
});

// ---------- cross-file consistency ----------

describe('fixtures: cross-file consistency', () => {
  for (const direction of ['received', 'sent'] as const) {
    it(`every dmID in list_${direction}.xml has all four companion files`, () => {
      const xml = readFileSync(resolve(FIXTURES_DIR, `list_${direction}.xml`), 'utf8');
      const parsed = parseListResponse(xml, direction);
      assert.ok(parsed.messages.length > 0, `list_${direction}.xml has records`);
      for (const m of parsed.messages) {
        for (const suffix of [
          '.soap.xml',
          '.zfo',
          '.dorucenka.soap.xml',
          '.dorucenka.zfo',
        ]) {
          const name = `msg_${m.dmId}_${direction}${suffix}`;
          assert.ok(
            existsSync(resolve(FIXTURES_DIR, name)),
            `missing companion fixture: ${name}`,
          );
        }
      }
    });
  }

  it('.zfo files all contain the placeholder marker', () => {
    for (const fx of listFixtures((n) => n.endsWith('.zfo'))) {
      const body = readFileSync(fx.path, 'utf8');
      assert.match(body, /redacted ZFO placeholder/, `placeholder marker in ${fx.name}`);
      assert.match(body, /<PDF here>/, `PDF marker in ${fx.name}`);
    }
  });
});

// ---------- end-to-end with mocked transport ----------

describe('IsdsClient with mocked fetch, driven by fixtures', () => {
  const endpoints = {
    info: 'https://mock.example.invalid/DS/dx',
    operations: 'https://mock.example.invalid/DS/dz',
  };

  function withStubbedFetch(
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
    body: () => Promise<void>,
  ): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      return Promise.resolve(handler(url, init));
    }) as typeof globalThis.fetch;
    return body().finally(() => {
      globalThis.fetch = original;
    });
  }

  it('listMessages parses list_received.xml via the full client pipeline', async () => {
    const fixture = readFileSync(resolve(FIXTURES_DIR, 'list_received.xml'), 'utf8');
    await withStubbedFetch(
      (url) => {
        assert.equal(url, endpoints.info, 'list call targets the info endpoint');
        return new Response(fixture, {
          status: 200,
          headers: { 'Content-Type': 'text/xml' },
        });
      },
      async () => {
        const client = new IsdsClient(endpoints, 'user', 'pass');
        const messages = await client.listMessages(
          'received',
          '2026-01-01T00:00:00.000',
          '2026-04-17T00:00:00.000',
        );
        assert.equal(messages.length, 2);
        assert.deepEqual(
          messages.map((m) => m.dmId).sort(),
          ['1313131313', '1313131314'],
        );
        for (const m of messages) {
          assert.equal(m.direction, 'received');
          assert.equal(m.dmSender, 'Johnny Appleseed Org');
          assert.equal(m.dmRecipient, 'Jane Doe Ltd');
          assert.equal(m.dmAnnotation, 'Dummy subject');
          assert.equal(m.dbIDRecipient, 'aaa0000');
        }
      },
    );
  });

  it('listMessages parses list_sent.xml and routes to the info endpoint', async () => {
    const fixture = readFileSync(resolve(FIXTURES_DIR, 'list_sent.xml'), 'utf8');
    await withStubbedFetch(
      (url) => {
        assert.equal(url, endpoints.info);
        return new Response(fixture, { status: 200 });
      },
      async () => {
        const client = new IsdsClient(endpoints, 'user', 'pass');
        const messages = await client.listMessages('sent', 'a', 'b');
        assert.deepEqual(
          messages.map((m) => m.dmId).sort(),
          ['1313131315', '1313131316'],
        );
        for (const m of messages) {
          assert.equal(m.direction, 'sent');
          assert.equal(m.dbIDSender, 'aaa0000');
        }
      },
    );
  });

  it('downloadSignedMessage returns the byte-identical .zfo content', async () => {
    const soap = readFileSync(
      resolve(FIXTURES_DIR, 'msg_1313131313_received.soap.xml'),
      'utf8',
    );
    const expected = readFileSync(
      resolve(FIXTURES_DIR, 'msg_1313131313_received.zfo'),
    );
    await withStubbedFetch(
      (url) => {
        assert.equal(url, endpoints.operations, 'download targets operations endpoint');
        return new Response(soap, { status: 200 });
      },
      async () => {
        const client = new IsdsClient(endpoints, 'user', 'pass');
        const zfo = await client.downloadSignedMessage('received', '1313131313');
        assert.equal(zfo.compare(expected), 0);
      },
    );
  });

  it('downloadSignedDeliveryInfo returns the decoded dorucenka bytes', async () => {
    const soap = readFileSync(
      resolve(FIXTURES_DIR, 'msg_1313131313_received.dorucenka.soap.xml'),
      'utf8',
    );
    const expected = readFileSync(
      resolve(FIXTURES_DIR, 'msg_1313131313_received.dorucenka.zfo'),
    );
    await withStubbedFetch(
      (url) => {
        assert.equal(url, endpoints.info, 'dorucenka targets info endpoint');
        return new Response(soap, { status: 200 });
      },
      async () => {
        const client = new IsdsClient(endpoints, 'user', 'pass');
        const zfo = await client.downloadSignedDeliveryInfo('1313131313');
        assert.equal(zfo.compare(expected), 0);
      },
    );
  });

  it('sends Basic auth with the supplied credentials', async () => {
    const fixture = readFileSync(resolve(FIXTURES_DIR, 'list_received.xml'), 'utf8');
    let capturedAuth: string | null = null;
    await withStubbedFetch(
      (_url, init) => {
        const headers = new Headers(init?.headers);
        capturedAuth = headers.get('authorization');
        return new Response(fixture, { status: 200 });
      },
      async () => {
        const client = new IsdsClient(endpoints, 'd2in23', 's3cret');
        await client.listMessages('received', 'a', 'b');
      },
    );
    const expected =
      'Basic ' + Buffer.from('d2in23:s3cret', 'utf8').toString('base64');
    assert.equal(capturedAuth, expected);
  });

  it('surfaces non-zero dmStatusCode as an Error containing the status code', async () => {
    const errorXml = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
<soap:Body>
  <GetListOfReceivedMessagesResponse xmlns="http://isds.czechpoint.cz/v20">
    <dmStatus>
      <dmStatusCode>1212</dmStatusCode>
      <dmStatusMessage>Chyba autentizace</dmStatusMessage>
    </dmStatus>
  </GetListOfReceivedMessagesResponse>
</soap:Body>
</soap:Envelope>`;
    await withStubbedFetch(
      () => new Response(errorXml, { status: 200 }),
      async () => {
        const client = new IsdsClient(endpoints, 'u', 'p');
        await assert.rejects(
          () => client.listMessages('received', 'a', 'b'),
          (err: unknown) => err instanceof Error && err.message.includes('1212'),
        );
      },
    );
  });
});
