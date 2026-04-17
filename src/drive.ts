import { Buffer } from 'node:buffer';
import type { GoogleAuth } from './google-auth.js';
import { log } from './log.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveFileMeta {
  readonly id: string;
  readonly name: string;
  readonly size: number | null;
}

export class Drive {
  // Memoise folder ensure operations at the (parentId, name) granularity so
  // concurrent workers requesting the same path do not race each other into
  // creating duplicate directories. Cache is per Drive instance (per run).
  private readonly folderCache = new Map<string, Promise<string>>();

  constructor(private readonly auth: GoogleAuth) {}

  private async authHeader(): Promise<Record<string, string>> {
    return { Authorization: `Bearer ${await this.auth.getAccessToken()}` };
  }

  async findByNameInParent(name: string, parentId: string): Promise<DriveFileMeta | null> {
    const q = `name = '${escapeQuery(name)}' and '${parentId}' in parents and trashed = false`;
    const params = new URLSearchParams({
      q,
      fields: 'files(id,name,size)',
      pageSize: '2',
      spaces: 'drive',
    });
    const res = await fetch(`${API}/files?${params.toString()}`, {
      headers: await this.authHeader(),
    });
    await assertOk(res, 'find file');
    const json = (await res.json()) as {
      files?: Array<{ id: string; name: string; size?: string }>;
    };
    const files = json.files ?? [];
    if (files.length === 0) return null;
    if (files.length > 1) {
      log.warn('drive: multiple files match name in parent — using first', {
        name,
        parentId,
        count: files.length,
      });
    }
    const [first] = files;
    if (!first) return null;
    return {
      id: first.id,
      name: first.name,
      size: first.size === undefined ? null : Number(first.size),
    };
  }

  async getFileContent(id: string): Promise<Buffer> {
    const res = await fetch(`${API}/files/${encodeURIComponent(id)}?alt=media`, {
      headers: await this.authHeader(),
    });
    await assertOk(res, 'get file content');
    return Buffer.from(await res.arrayBuffer());
  }

  async createFolder(name: string, parentId: string): Promise<string> {
    const body = {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    };
    const res = await fetch(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { ...(await this.authHeader()), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await assertOk(res, 'create folder');
    const json = (await res.json()) as { id: string };
    log.debug('drive: created folder', { name, parentId, id: json.id });
    return json.id;
  }

  async ensureFolderPath(rootId: string, segments: readonly string[]): Promise<string> {
    let currentId = rootId;
    for (const seg of segments) {
      currentId = await this.ensureChild(currentId, seg);
    }
    return currentId;
  }

  // Atomically (within the single-threaded event loop) look up or create a
  // named child folder under a given parent. The cache entry is set
  // synchronously before the first `await` inside the IIFE so no two callers
  // can both miss-then-create the same (parent, name) pair.
  private ensureChild(parentId: string, name: string): Promise<string> {
    const key = `${parentId}/${name}`;
    const existing = this.folderCache.get(key);
    if (existing) return existing;
    const promise = (async (): Promise<string> => {
      const found = await this.findByNameInParent(name, parentId);
      return found ? found.id : await this.createFolder(name, parentId);
    })();
    this.folderCache.set(key, promise);
    return promise;
  }

  async uploadFile(opts: {
    readonly name: string;
    readonly parentId: string;
    readonly content: Buffer;
    readonly mimeType: string;
  }): Promise<string> {
    const boundary = `bnd_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const metadata = {
      name: opts.name,
      parents: [opts.parentId],
      mimeType: opts.mimeType,
    };
    const head = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: ${opts.mimeType}\r\n\r\n`,
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, opts.content, tail]);
    const res = await fetch(`${UPLOAD_API}/files?uploadType=multipart&fields=id,size`, {
      method: 'POST',
      headers: {
        ...(await this.authHeader()),
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    await assertOk(res, 'upload file');
    const json = (await res.json()) as { id: string };
    return json.id;
  }

  async updateFileContent(id: string, content: Buffer, mimeType: string): Promise<void> {
    const res = await fetch(
      `${UPLOAD_API}/files/${encodeURIComponent(id)}?uploadType=media`,
      {
        method: 'PATCH',
        headers: { ...(await this.authHeader()), 'Content-Type': mimeType },
        body: content,
      },
    );
    await assertOk(res, 'update file content');
  }
}

function escapeQuery(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

async function assertOk(res: Response, ctx: string): Promise<void> {
  if (res.ok) return;
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  const snippet = body.length > 300 ? body.slice(0, 297) + '...' : body;
  throw new Error(`drive ${ctx}: ${res.status} ${res.statusText} — ${snippet}`);
}
