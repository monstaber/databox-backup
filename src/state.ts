import { Buffer } from 'node:buffer';
import type { Drive } from './drive.js';
import { log } from './log.js';
import type { StateIndex } from './types.js';

const STATE_FOLDER_NAME = '_state';
const STATE_FILE_NAME = 'index.json';

export interface StateStore {
  index: StateIndex;
  stateFileId: string | null;
  readonly stateFolderId: string;
}

export async function loadStateStore(
  drive: Drive,
  rootId: string,
  dbId: string,
): Promise<StateStore> {
  // Each schránka gets its own subtree under the root folder so running a
  // second archiver for a different schránka later will not collide.
  const stateFolderId = await drive.ensureFolderPath(rootId, [dbId, STATE_FOLDER_NAME]);
  const existing = await drive.findByNameInParent(STATE_FILE_NAME, stateFolderId);
  if (!existing) {
    log.info('state: no existing index.json — starting fresh');
    return {
      stateFolderId,
      stateFileId: null,
      index: emptyIndex(),
    };
  }
  const buf = await drive.getFileContent(existing.id);
  const parsed: unknown = JSON.parse(buf.toString('utf8'));
  const index = coerceIndex(parsed);
  log.info('state: loaded index', { entries: Object.keys(index.messages).length });
  return {
    stateFolderId,
    stateFileId: existing.id,
    index,
  };
}

export async function saveStateStore(drive: Drive, store: StateStore): Promise<string> {
  store.index.lastRunISO = new Date().toISOString();
  const content = Buffer.from(JSON.stringify(store.index, null, 2), 'utf8');
  if (store.stateFileId) {
    await drive.updateFileContent(store.stateFileId, content, 'application/json');
    return store.stateFileId;
  }
  const id = await drive.uploadFile({
    name: STATE_FILE_NAME,
    parentId: store.stateFolderId,
    content,
    mimeType: 'application/json',
  });
  store.stateFileId = id;
  return id;
}

function emptyIndex(): StateIndex {
  return {
    schemaVersion: 1,
    lastRunISO: new Date().toISOString(),
    messages: {},
  };
}

export function coerceIndex(data: unknown): StateIndex {
  if (
    data !== null &&
    typeof data === 'object' &&
    'schemaVersion' in data &&
    (data as { schemaVersion: unknown }).schemaVersion === 1 &&
    'messages' in data &&
    typeof (data as { messages: unknown }).messages === 'object' &&
    (data as { messages: unknown }).messages !== null
  ) {
    return data as StateIndex;
  }
  throw new Error('state: index.json has unexpected schema');
}
