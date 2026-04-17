import { XMLParser } from 'fast-xml-parser';
import type { ListedMessage, MessageDirection } from './types.js';

export const ISDS_NS = 'http://isds.czechpoint.cz/v20';

const parser = new XMLParser({
  ignoreAttributes: true,
  removeNSPrefix: true,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: true,
});

// Per dmBaseTypes.xsd tStatus: dmStatusCode (e.g. "0000" for success) and
// dmStatusMessage. dmInfoWebService and dmOperationsWebService responses use
// this shape. (The db_* services use a separate tDbReqStatus with
// dbStatusCode/Message/RefNumber — we do not call any of those.)
export interface DmStatus {
  readonly code: string;
  readonly message: string;
}

export interface ListResponse {
  readonly status: DmStatus;
  readonly messages: readonly ListedMessage[];
}

export interface SignedBlobResponse {
  readonly status: DmStatus;
  readonly signatureB64: string;
}

export function buildGetListEnvelope(
  direction: MessageDirection,
  fromISO: string,
  toISO: string,
  offset = 1,
  limit = 1000,
): string {
  // Per dmBaseTypes.xsd, tListOfSentInput uses dmSenderOrgUnitNum while
  // tListOfFReceivedInput uses dmRecipientOrgUnitNum — the schema mirrors the
  // caller's side of each conversation. Getting this wrong triggers server
  // error 2004 ("Missing GetListOfSentMessages end, found eventType=1, ...").
  const op = direction === 'received' ? 'GetListOfReceivedMessages' : 'GetListOfSentMessages';
  const orgUnitField = direction === 'received' ? 'dmRecipientOrgUnitNum' : 'dmSenderOrgUnitNum';
  return soapWrap(
    `<p:${op} xmlns:p="${ISDS_NS}">` +
      `<p:dmFromTime>${fromISO}</p:dmFromTime>` +
      `<p:dmToTime>${toISO}</p:dmToTime>` +
      `<p:${orgUnitField}>0</p:${orgUnitField}>` +
      `<p:dmStatusFilter>-1</p:dmStatusFilter>` +
      `<p:dmOffset>${offset}</p:dmOffset>` +
      `<p:dmLimit>${limit}</p:dmLimit>` +
      `</p:${op}>`,
  );
}

export function buildSignedDownloadEnvelope(
  direction: MessageDirection,
  dmId: string,
): string {
  const op = direction === 'received' ? 'SignedMessageDownload' : 'SignedSentMessageDownload';
  return soapWrap(
    `<p:${op} xmlns:p="${ISDS_NS}">` +
      `<p:dmID>${escapeXml(dmId)}</p:dmID>` +
      `</p:${op}>`,
  );
}

export function buildGetSignedDeliveryInfoEnvelope(dmId: string): string {
  return soapWrap(
    `<p:GetSignedDeliveryInfo xmlns:p="${ISDS_NS}">` +
      `<p:dmID>${escapeXml(dmId)}</p:dmID>` +
      `</p:GetSignedDeliveryInfo>`,
  );
}

export function parseListResponse(
  xml: string,
  direction: MessageDirection,
): ListResponse {
  const root = parser.parse(xml) as Record<string, unknown>;
  const body = getField(getField(root, 'Envelope'), 'Body');
  const expectedTag =
    direction === 'received'
      ? 'GetListOfReceivedMessagesResponse'
      : 'GetListOfSentMessagesResponse';
  const resp = getField(body, expectedTag);
  if (!resp) throw new Error(`ISDS: missing ${expectedTag} in response`);
  const status = parseDmStatus(getField(resp, 'dmStatus'));
  const rows = toArray(getField(getField(resp, 'dmRecords'), 'dmRecord'));
  const messages = rows.map((r): ListedMessage => parseDmRecord(r, direction));
  return { status, messages };
}

export function parseSignedDownloadResponse(xml: string): SignedBlobResponse {
  const root = parser.parse(xml) as Record<string, unknown>;
  const body = getField(getField(root, 'Envelope'), 'Body');
  const resp =
    getField(body, 'SignedMessageDownloadResponse') ??
    getField(body, 'SignedSentMessageDownloadResponse');
  if (!resp) throw new Error('ISDS: missing SignedMessage(Sent)DownloadResponse');
  return {
    status: parseDmStatus(getField(resp, 'dmStatus')),
    signatureB64: asString(getField(resp, 'dmSignature')),
  };
}

export function parseGetSignedDeliveryInfoResponse(xml: string): SignedBlobResponse {
  const root = parser.parse(xml) as Record<string, unknown>;
  const body = getField(getField(root, 'Envelope'), 'Body');
  const resp = getField(body, 'GetSignedDeliveryInfoResponse');
  if (!resp) throw new Error('ISDS: missing GetSignedDeliveryInfoResponse');
  return {
    status: parseDmStatus(getField(resp, 'dmStatus')),
    signatureB64: asString(getField(resp, 'dmSignature')),
  };
}

function parseDmRecord(r: unknown, direction: MessageDirection): ListedMessage {
  const dmId = asString(getField(r, 'dmID'));
  if (dmId === '') {
    throw new Error('ISDS: dmRecord missing dmID');
  }
  return {
    dmId,
    direction,
    dmStatus: Number(asString(getField(r, 'dmMessageStatus')) || '0'),
    dmDeliveryTime: strOrNull(getField(r, 'dmDeliveryTime')),
    dmAcceptanceTime: strOrNull(getField(r, 'dmAcceptanceTime')),
    dmAnnotation: strOrNull(getField(r, 'dmAnnotation')),
    dmSender: strOrNull(getField(r, 'dmSender')),
    dmRecipient: strOrNull(getField(r, 'dmRecipient')),
    dmSubmissionTime: strOrNull(getField(r, 'dmSubmissionTime')),
    dbIDSender: strOrNull(getField(r, 'dbIDSender')),
    dbIDRecipient: strOrNull(getField(r, 'dbIDRecipient')),
  };
}

function parseDmStatus(node: unknown): DmStatus {
  if (!node) return { code: 'UNKNOWN', message: 'missing dmStatus' };
  return {
    code: asString(getField(node, 'dmStatusCode')) || 'UNKNOWN',
    message: asString(getField(node, 'dmStatusMessage')),
  };
}

function soapWrap(bodyContent: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<soap:Body>${bodyContent}</soap:Body>` +
    `</soap:Envelope>`
  );
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getField(obj: unknown, name: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[name];
}

// Coerce an XML node value (possibly string, number, boolean, or a nested
// element object when the tag had children) to a plain string. Nested objects
// are NOT stringified with the default `[object Object]` path — they return
// empty, because ISDS envelope nodes we consume here should all be leaf-text.
function asString(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
    return String(v);
  }
  return '';
}

function strOrNull(v: unknown): string | null {
  const s = asString(v);
  return s === '' ? null : s;
}

function toArray<T>(v: T | T[] | undefined | null): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}
