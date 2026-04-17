import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildGetListEnvelope,
  buildGetSignedDeliveryInfoEnvelope,
  buildSignedDownloadEnvelope,
  parseGetSignedDeliveryInfoResponse,
  parseListResponse,
  parseSignedDownloadResponse,
} from '../src/isds-xml.js';

describe('buildGetListEnvelope', () => {
  it('emits the correct operation for received and sent', () => {
    const r = buildGetListEnvelope(
      'received',
      '2026-01-01T00:00:00.000',
      '2026-04-17T00:00:00.000',
    );
    assert.match(r, /GetListOfReceivedMessages/);
    assert.match(r, /dmFromTime>2026-01-01T00:00:00\.000<\/p:dmFromTime/);
    assert.match(r, /dmToTime>2026-04-17T00:00:00\.000<\/p:dmToTime/);
    assert.match(r, /xmlns:p="http:\/\/isds\.czechpoint\.cz\/v20"/);

    const s = buildGetListEnvelope(
      'sent',
      '2026-01-01T00:00:00.000',
      '2026-04-17T00:00:00.000',
    );
    assert.match(s, /GetListOfSentMessages/);
  });

  it('uses dmRecipientOrgUnitNum for received and dmSenderOrgUnitNum for sent', () => {
    const r = buildGetListEnvelope('received', 'a', 'b');
    assert.match(r, /<p:dmRecipientOrgUnitNum>/);
    assert.doesNotMatch(r, /<p:dmSenderOrgUnitNum>/);

    const s = buildGetListEnvelope('sent', 'a', 'b');
    assert.match(s, /<p:dmSenderOrgUnitNum>/);
    assert.doesNotMatch(s, /<p:dmRecipientOrgUnitNum>/);
  });

  it('escapes offset/limit as numbers', () => {
    const e = buildGetListEnvelope('received', 'a', 'b', 5, 200);
    assert.match(e, /dmOffset>5<\/p:dmOffset/);
    assert.match(e, /dmLimit>200<\/p:dmLimit/);
  });
});

describe('buildSignedDownloadEnvelope', () => {
  it('received → SignedMessageDownload; sent → SignedSentMessageDownload', () => {
    assert.match(
      buildSignedDownloadEnvelope('received', '12345'),
      /SignedMessageDownload/,
    );
    assert.match(
      buildSignedDownloadEnvelope('sent', '12345'),
      /SignedSentMessageDownload/,
    );
  });

  it('escapes dmID', () => {
    const e = buildSignedDownloadEnvelope('received', "1<'&\">2");
    assert.match(e, /dmID>1&lt;&apos;&amp;&quot;&gt;2<\/p:dmID/);
  });
});

describe('buildGetSignedDeliveryInfoEnvelope', () => {
  it('wraps GetSignedDeliveryInfo', () => {
    const e = buildGetSignedDeliveryInfoEnvelope('777');
    assert.match(e, /GetSignedDeliveryInfo/);
    assert.match(e, /dmID>777</);
  });
});

describe('parseListResponse', () => {
  it('parses a received-message list with one record', () => {
    const xml = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetListOfReceivedMessagesResponse xmlns="http://isds.czechpoint.cz/v20">
      <dmRecords>
        <dmRecord>
          <dmOrdinal>1</dmOrdinal>
          <dmID>12345</dmID>
          <dmSender>Nějaký soud</dmSender>
          <dmRecipient>Jan Novák</dmRecipient>
          <dmAnnotation>Rozhodnutí č. 42/2026</dmAnnotation>
          <dmMessageStatus>4</dmMessageStatus>
          <dmDeliveryTime>2026-04-15T09:12:00</dmDeliveryTime>
          <dmAcceptanceTime>2026-04-15T09:15:00</dmAcceptanceTime>
        </dmRecord>
      </dmRecords>
      <dmStatus>
        <dmStatusCode>0000</dmStatusCode>
        <dmStatusMessage>OK</dmStatusMessage>
      </dmStatus>
    </GetListOfReceivedMessagesResponse>
  </soap:Body>
</soap:Envelope>`;
    const result = parseListResponse(xml, 'received');
    assert.equal(result.status.code, '0000');
    assert.equal(result.messages.length, 1);
    const m = result.messages[0]!;
    assert.equal(m.dmId, '12345');
    assert.equal(m.dmStatus, 4);
    assert.equal(m.dmAnnotation, 'Rozhodnutí č. 42/2026');
    assert.equal(m.dmSender, 'Nějaký soud');
    assert.equal(m.direction, 'received');
    assert.equal(m.dmDeliveryTime, '2026-04-15T09:12:00');
  });

  it('parses an empty list (no dmRecord at all)', () => {
    const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetListOfSentMessagesResponse xmlns="http://isds.czechpoint.cz/v20">
      <dmRecords/>
      <dmStatus><dmStatusCode>0000</dmStatusCode><dmStatusMessage>OK</dmStatusMessage></dmStatus>
    </GetListOfSentMessagesResponse>
  </soap:Body>
</soap:Envelope>`;
    const result = parseListResponse(xml, 'sent');
    assert.equal(result.status.code, '0000');
    assert.equal(result.messages.length, 0);
  });

  it('parses a multi-record list', () => {
    const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetListOfReceivedMessagesResponse xmlns="http://isds.czechpoint.cz/v20">
      <dmRecords>
        <dmRecord><dmID>1</dmID><dmMessageStatus>1</dmMessageStatus></dmRecord>
        <dmRecord><dmID>2</dmID><dmMessageStatus>4</dmMessageStatus></dmRecord>
        <dmRecord><dmID>3</dmID><dmMessageStatus>5</dmMessageStatus></dmRecord>
      </dmRecords>
      <dmStatus><dmStatusCode>0000</dmStatusCode><dmStatusMessage>OK</dmStatusMessage></dmStatus>
    </GetListOfReceivedMessagesResponse>
  </soap:Body>
</soap:Envelope>`;
    const result = parseListResponse(xml, 'received');
    assert.equal(result.messages.length, 3);
    assert.deepEqual(
      result.messages.map((m) => m.dmId),
      ['1', '2', '3'],
    );
    assert.deepEqual(
      result.messages.map((m) => m.dmStatus),
      [1, 4, 5],
    );
  });

  it('propagates non-zero dmStatusCode to status', () => {
    const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetListOfReceivedMessagesResponse xmlns="http://isds.czechpoint.cz/v20">
      <dmStatus><dmStatusCode>1212</dmStatusCode><dmStatusMessage>Chyba autentizace</dmStatusMessage></dmStatus>
    </GetListOfReceivedMessagesResponse>
  </soap:Body>
</soap:Envelope>`;
    const result = parseListResponse(xml, 'received');
    assert.equal(result.status.code, '1212');
    assert.equal(result.status.message, 'Chyba autentizace');
    assert.equal(result.messages.length, 0);
  });
});

describe('parseSignedDownloadResponse', () => {
  it('extracts base64 signature from received-message response', () => {
    const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SignedMessageDownloadResponse xmlns="http://isds.czechpoint.cz/v20">
      <dmSignature>SGVsbG8gWkZP</dmSignature>
      <dmStatus><dmStatusCode>0000</dmStatusCode><dmStatusMessage>OK</dmStatusMessage></dmStatus>
    </SignedMessageDownloadResponse>
  </soap:Body>
</soap:Envelope>`;
    const r = parseSignedDownloadResponse(xml);
    assert.equal(r.status.code, '0000');
    assert.equal(r.signatureB64, 'SGVsbG8gWkZP');
    assert.equal(Buffer.from(r.signatureB64, 'base64').toString('utf8'), 'Hello ZFO');
  });

  it('also handles sent-message response element name', () => {
    const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <SignedSentMessageDownloadResponse xmlns="http://isds.czechpoint.cz/v20">
      <dmSignature>U2VudA==</dmSignature>
      <dmStatus><dmStatusCode>0000</dmStatusCode></dmStatus>
    </SignedSentMessageDownloadResponse>
  </soap:Body>
</soap:Envelope>`;
    const r = parseSignedDownloadResponse(xml);
    assert.equal(r.signatureB64, 'U2VudA==');
  });
});

describe('parseGetSignedDeliveryInfoResponse', () => {
  it('extracts signature and status', () => {
    const xml = `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetSignedDeliveryInfoResponse xmlns="http://isds.czechpoint.cz/v20">
      <dmSignature>RG9ydWNlbmth</dmSignature>
      <dmStatus><dmStatusCode>0000</dmStatusCode><dmStatusMessage>OK</dmStatusMessage></dmStatus>
    </GetSignedDeliveryInfoResponse>
  </soap:Body>
</soap:Envelope>`;
    const r = parseGetSignedDeliveryInfoResponse(xml);
    assert.equal(r.status.code, '0000');
    assert.equal(Buffer.from(r.signatureB64, 'base64').toString('utf8'), 'Dorucenka');
  });
});
