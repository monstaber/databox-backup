import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { sha256Hex } from './crypto.js';
import { Drive } from './drive.js';
import { GoogleAuth } from './google-auth.js';
import { IsdsClient } from './isds.js';
import { log, setVerbose } from './log.js';
import { formatDorucenkaFilename, formatMessageFilename } from './naming.js';
import { loadStateStore, saveStateStore, type StateStore } from './state.js';
import {
  isTerminalStatus,
  type IndexEntry,
  type ListedMessage,
  type RunSummary,
} from './types.js';
import { countAttachmentsInZfo } from './zfo.js';

interface ArchiveTask {
  readonly message: ListedMessage;
  readonly kind: 'new' | 'refresh';
}

async function main(): Promise<number> {
  const startedAt = Date.now();
  const cfg = loadConfig();
  setVerbose(cfg.run.verbose);

  const auth = new GoogleAuth(
    cfg.google.clientId,
    cfg.google.clientSecret,
    cfg.google.refreshToken,
  );
  const drive = new Drive(auth);
  const isds = new IsdsClient(cfg.isds.endpoints, cfg.isds.username, cfg.isds.password);

  log.info('starting run', { dbId: cfg.isds.dbId });

  const store = await loadStateStore(drive, cfg.drive.rootFolderId, cfg.isds.dbId);

  const to = new Date();
  const from = new Date(to.getTime() - cfg.run.lookbackDays * 86_400_000);
  const fromISO = isdsTimestamp(from);
  const toISO = isdsTimestamp(to);

  const [received, sent] = await Promise.all([
    isds.listMessages('received', fromISO, toISO),
    isds.listMessages('sent', fromISO, toISO),
  ]);
  const listed = [...received, ...sent];
  log.info('isds: total listed', {
    received: received.length,
    sent: sent.length,
  });

  warnIfDbIdMismatch(listed, cfg.isds.dbId);

  const tasks = buildTasks(listed, store.index.messages);
  const summary: RunSummary = {
    started: listed.length,
    archived: 0,
    refreshed: 0,
    skipped: listed.length - tasks.length,
    errors: 0,
  };
  log.info('plan', {
    total: listed.length,
    new: tasks.filter((t) => t.kind === 'new').length,
    refresh: tasks.filter((t) => t.kind === 'refresh').length,
    skipped: summary.skipped,
  });

  await processWithConcurrency(tasks, cfg.run.concurrency, async (task) => {
    try {
      if (task.kind === 'new') {
        await archiveNew(
          task.message,
          drive,
          isds,
          store,
          cfg.drive.rootFolderId,
          cfg.isds.dbId,
        );
        summary.archived += 1;
      } else {
        const changed = await refreshDorucenka(task.message, drive, isds, store);
        if (changed) summary.refreshed += 1;
        else summary.skipped += 1;
      }
    } catch (err) {
      summary.errors += 1;
      log.error('task failed', {
        dmId: task.message.dmId,
        error: errMsg(err),
      });
    }
  });

  await saveStateStore(drive, store);

  const durationS = Math.round((Date.now() - startedAt) / 100) / 10;
  log.info('done', {
    archived: summary.archived,
    refreshed: summary.refreshed,
    skipped: summary.skipped,
    errors: summary.errors,
    duration_s: durationS,
  });

  return summary.errors > 0 ? 1 : 0;
}

function buildTasks(
  listed: readonly ListedMessage[],
  indexMessages: Record<string, IndexEntry>,
): ArchiveTask[] {
  const tasks: ArchiveTask[] = [];
  for (const m of listed) {
    const entry = indexMessages[m.dmId];
    if (!entry) {
      tasks.push({ message: m, kind: 'new' });
      continue;
    }
    if (entry.terminal) continue;
    if (entry.dmStatus !== m.dmStatus) {
      tasks.push({ message: m, kind: 'refresh' });
    }
    // unchanged non-terminal — skip silently
  }
  return tasks;
}

async function archiveNew(
  m: ListedMessage,
  drive: Drive,
  isds: IsdsClient,
  store: StateStore,
  rootId: string,
  dbId: string,
): Promise<void> {
  const [zfo, dorucenka] = await Promise.all([
    isds.downloadSignedMessage(m.direction, m.dmId),
    isds.downloadSignedDeliveryInfo(m.dmId),
  ]);
  const attachmentCount = await countAttachmentsInZfo(zfo);
  const parent = await drive.ensureFolderPath(rootId, folderSegments(dbId, m));

  const [zfoId, dorId] = await Promise.all([
    drive.uploadFile({
      name: formatMessageFilename(m, attachmentCount),
      parentId: parent,
      content: zfo,
      mimeType: 'application/octet-stream',
    }),
    drive.uploadFile({
      name: formatDorucenkaFilename(m, attachmentCount),
      parentId: parent,
      content: dorucenka,
      mimeType: 'application/octet-stream',
    }),
  ]);

  store.index.messages[m.dmId] = {
    direction: m.direction,
    dmStatus: m.dmStatus,
    dmDeliveryTime: m.dmDeliveryTime,
    annotation: m.dmAnnotation,
    zfoDriveId: zfoId,
    dorucenkaDriveId: dorId,
    dorucenkaSha256: sha256Hex(dorucenka),
    lastRefreshedISO: new Date().toISOString(),
    terminal: isTerminalStatus(m.dmStatus),
  };

  log.info('archived', {
    dmId: m.dmId,
    direction: m.direction,
    status: m.dmStatus,
  });
}

async function refreshDorucenka(
  m: ListedMessage,
  drive: Drive,
  isds: IsdsClient,
  store: StateStore,
): Promise<boolean> {
  const entry = store.index.messages[m.dmId];
  if (!entry) throw new Error(`unreachable: refresh without entry for ${m.dmId}`);

  const blob = await isds.downloadSignedDeliveryInfo(m.dmId);
  const newHash = sha256Hex(blob);
  if (newHash === entry.dorucenkaSha256) {
    entry.dmStatus = m.dmStatus;
    entry.terminal = isTerminalStatus(m.dmStatus);
    entry.lastRefreshedISO = new Date().toISOString();
    log.debug('refresh: hash unchanged — metadata-only update', { dmId: m.dmId });
    return false;
  }

  await drive.updateFileContent(
    entry.dorucenkaDriveId,
    blob,
    'application/octet-stream',
  );

  entry.dmStatus = m.dmStatus;
  entry.dmDeliveryTime = m.dmDeliveryTime;
  entry.dorucenkaSha256 = newHash;
  entry.lastRefreshedISO = new Date().toISOString();
  entry.terminal = isTerminalStatus(m.dmStatus);

  log.info('refreshed dorucenka', { dmId: m.dmId, status: m.dmStatus });
  return true;
}

function folderSegments(dbId: string, m: ListedMessage): string[] {
  // Flat layout: descriptive filenames remove the need for YYYY/MM subfolders.
  return [dbId, m.direction];
}

// Soft warning — if we listed messages and none were addressed to / sent from
// the expected dbId, the ISDS_DBID env var probably doesn't match the
// credentials. Doesn't fail the run (could be a brand-new empty schránka).
function warnIfDbIdMismatch(listed: readonly ListedMessage[], expected: string): void {
  if (listed.length === 0) return;
  const hasMatch = listed.some((m) =>
    m.direction === 'received' ? m.dbIDRecipient === expected : m.dbIDSender === expected,
  );
  if (hasMatch) return;
  const sample = listed[0];
  log.warn('ISDS_DBID does not match any listed message', {
    expected,
    sampleDirection: sample?.direction ?? null,
    sampleDbIDSender: sample?.dbIDSender ?? null,
    sampleDbIDRecipient: sample?.dbIDRecipient ?? null,
  });
}

function isdsTimestamp(d: Date): string {
  // ISDS expects ISO-like timestamps without 'Z' suffix.
  return d.toISOString().replace('Z', '');
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

async function processWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (t: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const queue: T[] = [...items];
  const runners = Math.max(1, Math.min(limit, items.length));
  const active: Promise<void>[] = [];
  const runOne = async (): Promise<void> => {
    for (;;) {
      const next = queue.shift();
      if (next === undefined) return;
      await worker(next);
    }
  };
  for (let i = 0; i < runners; i += 1) active.push(runOne());
  await Promise.all(active);
}

export { buildTasks, main };

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((e: unknown) => {
      log.error('fatal', { error: errMsg(e) });
      process.exit(2);
    });
}
