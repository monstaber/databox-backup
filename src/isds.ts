import { Buffer } from 'node:buffer';
import type { IsdsEndpoints } from './config.js';
import { log } from './log.js';
import {
  buildGetListEnvelope,
  buildGetSignedDeliveryInfoEnvelope,
  buildSignedDownloadEnvelope,
  parseGetSignedDeliveryInfoResponse,
  parseListResponse,
  parseSignedDownloadResponse,
  type DmStatus,
} from './isds-xml.js';
import type { ListedMessage, MessageDirection } from './types.js';

type IsdsService = 'info' | 'operations';

export class IsdsClient {
  private readonly authHeader: string;

  constructor(
    private readonly endpoints: IsdsEndpoints,
    username: string,
    password: string,
  ) {
    this.authHeader =
      'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  }

  private async call(service: IsdsService, envelope: string): Promise<string> {
    const endpoint = this.endpoints[service];
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: '""',
        Authorization: this.authHeader,
        Accept: 'text/xml',
      },
      body: envelope,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `ISDS HTTP ${res.status.toString()} ${res.statusText} — ${truncate(text)}`,
      );
    }
    return text;
  }

  async listMessages(
    direction: MessageDirection,
    fromISO: string,
    toISO: string,
  ): Promise<ListedMessage[]> {
    const all: ListedMessage[] = [];
    let offset = 1;
    const pageLimit = 1000;
    for (;;) {
      const envelope = buildGetListEnvelope(direction, fromISO, toISO, offset, pageLimit);
      const xml = await this.call('info', envelope);
      const { status, messages } = parseListResponse(xml, direction);
      assertSuccess(status, `list ${direction}`);
      all.push(...messages);
      if (messages.length < pageLimit) break;
      offset += pageLimit;
    }
    log.info('isds: listed messages', { direction, count: all.length });
    return all;
  }

  async downloadSignedMessage(
    direction: MessageDirection,
    dmId: string,
  ): Promise<Buffer> {
    const envelope = buildSignedDownloadEnvelope(direction, dmId);
    const xml = await this.call('operations', envelope);
    const { status, signatureB64 } = parseSignedDownloadResponse(xml);
    assertSuccess(status, `download ${direction} ${dmId}`);
    if (!signatureB64) throw new Error(`ISDS: empty dmSignature for ${direction} ${dmId}`);
    return Buffer.from(signatureB64, 'base64');
  }

  async downloadSignedDeliveryInfo(dmId: string): Promise<Buffer> {
    const envelope = buildGetSignedDeliveryInfoEnvelope(dmId);
    const xml = await this.call('info', envelope);
    const { status, signatureB64 } = parseGetSignedDeliveryInfoResponse(xml);
    assertSuccess(status, `delivery info ${dmId}`);
    if (!signatureB64) {
      throw new Error(`ISDS: empty dmSignature (delivery info) for ${dmId}`);
    }
    return Buffer.from(signatureB64, 'base64');
  }
}

function assertSuccess(status: DmStatus, ctx: string): void {
  if (status.code !== '0000') {
    throw new Error(`ISDS ${ctx} failed: [${status.code}] ${status.message}`);
  }
}

function truncate(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}
