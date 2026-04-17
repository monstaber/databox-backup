export type MessageDirection = 'received' | 'sent';
export type DmId = string;

export interface ListedMessage {
  readonly dmId: DmId;
  readonly direction: MessageDirection;
  readonly dmStatus: number;
  readonly dmDeliveryTime: string | null;
  readonly dmAcceptanceTime: string | null;
  readonly dmAnnotation: string | null;
  readonly dmSender: string | null;
  readonly dmRecipient: string | null;
  readonly dmSubmissionTime: string | null;
  // Schránka IDs (dbIDs) of sender and recipient. Distinct from username —
  // the dbID is the schránka identifier that also appears on the outside of
  // the envelope. For a received message dbIDRecipient should equal your
  // configured ISDS_DBID; for a sent message dbIDSender should.
  readonly dbIDSender: string | null;
  readonly dbIDRecipient: string | null;
}

export interface IndexEntry {
  direction: MessageDirection;
  dmStatus: number;
  dmDeliveryTime: string | null;
  annotation: string | null;
  zfoDriveId: string;
  dorucenkaDriveId: string;
  dorucenkaSha256: string;
  lastRefreshedISO: string;
  terminal: boolean;
}

export interface StateIndex {
  schemaVersion: 1;
  lastRunISO: string;
  messages: Record<DmId, IndexEntry>;
}

export interface RunSummary {
  archived: number;
  refreshed: number;
  skipped: number;
  errors: number;
  started: number;
}

// ISDS dmStatus taxonomy (numeric per ISDS Provozní řád):
//   1 = Podaná       (submitted to ISDS by sender)
//   2 = Dodaná do DS (queued in recipient's DS, not yet delivered)
//   3 = Doručená fikcí         (legal delivery by 10-day fiction)
//   4 = Doručená přihlášením   (legal delivery by recipient login)
//   5+ = Post-delivery states (read / vault / deleted / etc.)
// Once dmStatus >= 3 the signed doručenka text is considered stable; further
// changes are rare and will still be caught by the SHA-256 backstop.
export const TERMINAL_STATUS_MIN = 3;

export function isTerminalStatus(status: number): boolean {
  return status >= TERMINAL_STATUS_MIN;
}
