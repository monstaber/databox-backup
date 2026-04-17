import type { ListedMessage } from './types.js';

const FILENAME_MAX = 200; // chars, including the ".zfo" extension
const DORUCENKA_PREFIX = 'Doručenka: ';

export function formatMessageFilename(
  m: ListedMessage,
  attachmentCount: number | null,
): string {
  return buildFilename(m, attachmentCount, '');
}

export function formatDorucenkaFilename(
  m: ListedMessage,
  attachmentCount: number | null,
): string {
  return buildFilename(m, attachmentCount, DORUCENKA_PREFIX);
}

function buildFilename(
  m: ListedMessage,
  attachmentCount: number | null,
  prefix: string,
): string {
  const ts = formatTimestampPrague(bestTimestamp(m));
  const party = sanitize(counterparty(m));
  const subject = sanitize(subjectOf(m));
  const tag = `(attachments: ${attachmentCount === null ? '?' : String(attachmentCount)})`;
  const assembled = `${prefix}${ts} ${party} - ${subject} ${tag}.zfo`;
  if (assembled.length <= FILENAME_MAX) return assembled;
  // Truncate the subject portion only; everything else is fixed-length.
  const overflow = assembled.length - FILENAME_MAX;
  const newSubjectLen = Math.max(1, subject.length - overflow);
  const newSubject = subject.slice(0, newSubjectLen).replace(/[-\s]+$/, '');
  return `${prefix}${ts} ${party} - ${newSubject} ${tag}.zfo`;
}

function formatTimestampPrague(iso: string): string {
  // 'sv-SE' locale happens to format as "YYYY-MM-DD HH:mm" — saves us any
  // custom zero-padding or month-ordering logic. Stdlib only.
  const dtf = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Prague',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return dtf.format(new Date(iso));
}

function bestTimestamp(m: ListedMessage): string {
  return (
    m.dmDeliveryTime ??
    m.dmAcceptanceTime ??
    m.dmSubmissionTime ??
    new Date().toISOString()
  );
}

function counterparty(m: ListedMessage): string {
  if (m.direction === 'received') {
    return nonEmpty(m.dmSender) ?? 'Unknown sender';
  }
  return nonEmpty(m.dmRecipient) ?? 'Unknown recipient';
}

function subjectOf(m: ListedMessage): string {
  return nonEmpty(m.dmAnnotation) ?? 'Unknown subject';
}

function nonEmpty(s: string | null): string | null {
  if (s === null) return null;
  const trimmed = s.trim();
  return trimmed === '' ? null : trimmed;
}

function sanitize(s: string): string {
  return s
    .replace(/[/\\]/g, '-') // Drive forbids `/`; `\` breaks Windows sync clients
    .replace(/\s+/g, ' ')
    .trim();
}
