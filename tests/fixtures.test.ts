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

// ---------- end-to-end with a mocked IsdsTransport ----------

describe('IsdsClient with mocked transport, driven by fixtures', () => {
  const endpoints = {
    info: 'https://mock.example.invalid/DS/dx',
    operations: 'https://mock.example.invalid/DS/dz',
  };

  // Records each (endpoint, envelope) call and returns whatever the handler
  // produces. The IsdsClient receives an opaque IsdsTransport, so this is
  // the only seam we need to swap in a test.
  function mockTransport(
    handler: (endpoint: string, envelope: string) => string | Promise<string>,
  ): {
    transport: { call: (endpoint: string, envelope: string) => Promise<string> };
    calls: { endpoint: string; envelope: string }[];
  } {
    const calls: { endpoint: string; envelope: string }[] = [];
    return {
      transport: {
        call: (endpoint: string, envelope: string): Promise<string> => {
          calls.push({ endpoint, envelope });
          return Promise.resolve(handler(endpoint, envelope));
        },
      },
      calls,
    };
  }

  it('listMessages parses list_received.xml via the full client pipeline', async () => {
    const fixture = readFileSync(resolve(FIXTURES_DIR, 'list_received.xml'), 'utf8');
    const { transport, calls } = mockTransport((endpoint) => {
      assert.equal(endpoint, endpoints.info, 'list call targets the info endpoint');
      return fixture;
    });
    const client = new IsdsClient(endpoints, transport);
    const messages = await client.listMessages(
      'received',
      '2026-01-01T00:00:00.000',
      '2026-04-17T00:00:00.000',
    );
    assert.equal(calls.length, 1);
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
  });

  it('listMessages parses list_sent.xml and routes to the info endpoint', async () => {
    const fixture = readFileSync(resolve(FIXTURES_DIR, 'list_sent.xml'), 'utf8');
    const { transport } = mockTransport((endpoint) => {
      assert.equal(endpoint, endpoints.info);
      return fixture;
    });
    const client = new IsdsClient(endpoints, transport);
    const messages = await client.listMessages('sent', 'a', 'b');
    assert.deepEqual(
      messages.map((m) => m.dmId).sort(),
      ['1313131315', '1313131316'],
    );
    for (const m of messages) {
      assert.equal(m.direction, 'sent');
      assert.equal(m.dbIDSender, 'aaa0000');
    }
  });

  it('downloadSignedMessage returns the byte-identical .zfo content', async () => {
    const soap = readFileSync(
      resolve(FIXTURES_DIR, 'msg_1313131313_received.soap.xml'),
      'utf8',
    );
    const expected = readFileSync(
      resolve(FIXTURES_DIR, 'msg_1313131313_received.zfo'),
    );
    const { transport } = mockTransport((endpoint) => {
      assert.equal(endpoint, endpoints.operations, 'download targets operations endpoint');
      return soap;
    });
    const client = new IsdsClient(endpoints, transport);
    const zfo = await client.downloadSignedMessage('received', '1313131313');
    assert.equal(zfo.compare(expected), 0);
  });

  it('downloadSignedDeliveryInfo returns the decoded dorucenka bytes', async () => {
    const soap = readFileSync(
      resolve(FIXTURES_DIR, 'msg_1313131313_received.dorucenka.soap.xml'),
      'utf8',
    );
    const expected = readFileSync(
      resolve(FIXTURES_DIR, 'msg_1313131313_received.dorucenka.zfo'),
    );
    const { transport } = mockTransport((endpoint) => {
      assert.equal(endpoint, endpoints.info, 'dorucenka targets info endpoint');
      return soap;
    });
    const client = new IsdsClient(endpoints, transport);
    const zfo = await client.downloadSignedDeliveryInfo('1313131313');
    assert.equal(zfo.compare(expected), 0);
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
    const { transport } = mockTransport(() => errorXml);
    const client = new IsdsClient(endpoints, transport);
    await assert.rejects(
      () => client.listMessages('received', 'a', 'b'),
      (err: unknown) => err instanceof Error && err.message.includes('1212'),
    );
  });
});
