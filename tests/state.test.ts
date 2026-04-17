import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { sha256Hex } from '../src/crypto.js';
import { buildTasks } from '../src/index.js';
import { coerceIndex } from '../src/state.js';
import { isTerminalStatus, type IndexEntry, type ListedMessage } from '../src/types.js';

// ---- coerceIndex ----

describe('coerceIndex', () => {
  it('accepts a valid v1 index', () => {
    const valid = { schemaVersion: 1, lastRunISO: '2026-04-17T00:00:00Z', messages: {} };
    assert.deepEqual(coerceIndex(valid), valid);
  });

  it('rejects null/undefined/arrays/wrong schema', () => {
    assert.throws(() => coerceIndex(null));
    assert.throws(() => coerceIndex(undefined));
    assert.throws(() => coerceIndex([]));
    assert.throws(() => coerceIndex({ schemaVersion: 2, messages: {} }));
    assert.throws(() => coerceIndex({ schemaVersion: 1, messages: null }));
  });
});

// ---- sha256Hex ----

describe('sha256Hex', () => {
  it('is deterministic', () => {
    const a = sha256Hex('hello');
    const b = sha256Hex('hello');
    assert.equal(a, b);
  });

  it('differs for different inputs', () => {
    assert.notEqual(sha256Hex('a'), sha256Hex('b'));
  });

  it('matches a known value', () => {
    // sha256("abc") has a well-known digest
    assert.equal(
      sha256Hex('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

// ---- isTerminalStatus ----

describe('isTerminalStatus', () => {
  it('marks 1, 2 as non-terminal; 3+ as terminal', () => {
    assert.equal(isTerminalStatus(1), false);
    assert.equal(isTerminalStatus(2), false);
    assert.equal(isTerminalStatus(3), true);
    assert.equal(isTerminalStatus(4), true);
    assert.equal(isTerminalStatus(5), true);
    assert.equal(isTerminalStatus(10), true);
  });
});

// ---- buildTasks ----

function msg(id: string, dmStatus: number): ListedMessage {
  return {
    dmId: id,
    direction: 'received',
    dmStatus,
    dmDeliveryTime: null,
    dmAcceptanceTime: null,
    dmAnnotation: null,
    dmSender: null,
    dmRecipient: null,
    dmSubmissionTime: null,
    dbIDSender: null,
    dbIDRecipient: null,
  };
}

function entry(dmStatus: number, terminal: boolean): IndexEntry {
  return {
    direction: 'received',
    dmStatus,
    dmDeliveryTime: null,
    annotation: null,
    zfoDriveId: 'z',
    dorucenkaDriveId: 'd',
    dorucenkaSha256: 'h',
    lastRefreshedISO: '2026-04-17T00:00:00Z',
    terminal,
  };
}

describe('buildTasks', () => {
  it('classifies a brand-new message as new', () => {
    const tasks = buildTasks([msg('1', 2)], {});
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.kind, 'new');
    assert.equal(tasks[0]!.message.dmId, '1');
  });

  it('skips existing terminal entries regardless of incoming status', () => {
    const tasks = buildTasks([msg('1', 4)], { '1': entry(4, true) });
    assert.equal(tasks.length, 0);
  });

  it('skips non-terminal entries whose dmStatus did not change', () => {
    const tasks = buildTasks([msg('1', 2)], { '1': entry(2, false) });
    assert.equal(tasks.length, 0);
  });

  it('refreshes non-terminal entries whose dmStatus changed', () => {
    const tasks = buildTasks([msg('1', 4)], { '1': entry(2, false) });
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]!.kind, 'refresh');
  });

  it('handles a mixed batch correctly', () => {
    const tasks = buildTasks(
      [msg('new', 1), msg('term', 4), msg('same', 2), msg('changed', 4)],
      {
        term: entry(4, true),
        same: entry(2, false),
        changed: entry(2, false),
      },
    );
    const byId = new Map(tasks.map((t) => [t.message.dmId, t.kind]));
    assert.equal(byId.get('new'), 'new');
    assert.equal(byId.get('term'), undefined);
    assert.equal(byId.get('same'), undefined);
    assert.equal(byId.get('changed'), 'refresh');
    assert.equal(tasks.length, 2);
  });
});

