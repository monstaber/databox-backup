import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  formatDorucenkaFilename,
  formatMessageFilename,
} from '../src/naming.js';
import type { ListedMessage } from '../src/types.js';

function msg(overrides: Partial<ListedMessage> = {}): ListedMessage {
  return {
    dmId: '9999999999',
    direction: 'received',
    dmStatus: 4,
    dmDeliveryTime: '2026-04-16T14:45:18+02:00',
    dmAcceptanceTime: null,
    dmSubmissionTime: null,
    dmAnnotation: 'Dummy subject',
    dmSender: 'Johnny Appleseed Org',
    dmRecipient: 'Jane Doe Ltd',
    dbIDSender: 'src0001',
    dbIDRecipient: 'dst0001',
    ...overrides,
  };
}

describe('formatMessageFilename - happy paths', () => {
  it('received uses dmSender and dmAnnotation with Prague-local timestamp', () => {
    const name = formatMessageFilename(msg(), 2);
    assert.equal(
      name,
      '2026-04-16 14:45 Johnny Appleseed Org - Dummy subject (attachments: 2).zfo',
    );
  });

  it('sent uses dmRecipient and includes attachment count 0 explicitly', () => {
    const name = formatMessageFilename(msg({ direction: 'sent' }), 0);
    assert.equal(
      name,
      '2026-04-16 14:45 Jane Doe Ltd - Dummy subject (attachments: 0).zfo',
    );
  });

  it('preserves Czech diacritics in party and subject', () => {
    const name = formatMessageFilename(
      msg({
        dmSender: 'Městský soud v Brně',
        dmAnnotation: 'Rozhodnutí č. 42/2026 - doložka právní moci',
      }),
      1,
    );
    assert.match(name, /Městský soud v Brně/);
    assert.match(name, /Rozhodnutí č. 42-2026 - doložka právní moci/);
  });
});

describe('formatMessageFilename - fallbacks', () => {
  it('uses "Unknown sender" for received with null dmSender', () => {
    const name = formatMessageFilename(msg({ dmSender: null }), 1);
    assert.match(name, /Unknown sender/);
  });

  it('uses "Unknown sender" for received with empty dmSender', () => {
    const name = formatMessageFilename(msg({ dmSender: '   ' }), 1);
    assert.match(name, /Unknown sender/);
  });

  it('uses "Unknown recipient" for sent with null dmRecipient', () => {
    const name = formatMessageFilename(
      msg({ direction: 'sent', dmRecipient: null }),
      1,
    );
    assert.match(name, /Unknown recipient/);
  });

  it('uses "Unknown subject" for null or empty dmAnnotation', () => {
    assert.match(formatMessageFilename(msg({ dmAnnotation: null }), 1), /Unknown subject/);
    assert.match(formatMessageFilename(msg({ dmAnnotation: '' }), 1), /Unknown subject/);
  });

  it('renders null attachment count as "?"', () => {
    const name = formatMessageFilename(msg(), null);
    assert.match(name, /\(attachments: \?\)/);
  });
});

describe('formatMessageFilename - sanitisation', () => {
  it('replaces forward slashes with dashes', () => {
    const name = formatMessageFilename(
      msg({ dmAnnotation: 'Case 12/2026/A - ref 5/B' }),
      1,
    );
    assert.doesNotMatch(name, /\//);
    assert.match(name, /Case 12-2026-A - ref 5-B/);
  });

  it('replaces backslashes with dashes', () => {
    const name = formatMessageFilename(
      msg({ dmAnnotation: 'something\\weird' }),
      1,
    );
    assert.doesNotMatch(name, /\\/);
    assert.match(name, /something-weird/);
  });

  it('collapses runs of whitespace', () => {
    const name = formatMessageFilename(
      msg({ dmSender: 'Lots    of   spaces' }),
      1,
    );
    assert.match(name, /Lots of spaces/);
  });
});

describe('formatMessageFilename - length cap', () => {
  it('keeps filenames at 200 chars or fewer, truncating only the subject', () => {
    const longSubject = 'X'.repeat(500);
    const name = formatMessageFilename(
      msg({ dmAnnotation: longSubject }),
      1,
    );
    assert.ok(name.length <= 200, `length=${name.length.toString()}`);
    // Timestamp and counterparty and attachment tag must all still be present.
    assert.match(name, /^2026-04-16 14:45 Johnny Appleseed Org - X+/);
    assert.match(name, /\(attachments: 1\)\.zfo$/);
  });

  it('leaves short filenames untouched', () => {
    const name = formatMessageFilename(msg(), 2);
    assert.ok(name.length < 200);
  });
});

describe('formatMessageFilename - timestamp source', () => {
  it('falls back to dmAcceptanceTime when dmDeliveryTime is null', () => {
    const name = formatMessageFilename(
      msg({
        dmDeliveryTime: null,
        dmAcceptanceTime: '2026-05-01T09:00:00+02:00',
      }),
      1,
    );
    assert.match(name, /^2026-05-01 09:00/);
  });

  it('falls back to dmSubmissionTime when both delivery and acceptance are null', () => {
    const name = formatMessageFilename(
      msg({
        dmDeliveryTime: null,
        dmAcceptanceTime: null,
        dmSubmissionTime: '2026-05-01T09:00:00+02:00',
      }),
      1,
    );
    assert.match(name, /^2026-05-01 09:00/);
  });
});

describe('formatMessageFilename - timezone', () => {
  it('renders CEST (summer) correctly in Europe/Prague', () => {
    // 2026-07-01 12:00 UTC = 14:00 Europe/Prague (CEST, UTC+2)
    const name = formatMessageFilename(
      msg({ dmDeliveryTime: '2026-07-01T12:00:00Z' }),
      1,
    );
    assert.match(name, /^2026-07-01 14:00/);
  });

  it('renders CET (winter) correctly in Europe/Prague', () => {
    // 2026-01-15 12:00 UTC = 13:00 Europe/Prague (CET, UTC+1)
    const name = formatMessageFilename(
      msg({ dmDeliveryTime: '2026-01-15T12:00:00Z' }),
      1,
    );
    assert.match(name, /^2026-01-15 13:00/);
  });
});

describe('formatDorucenkaFilename', () => {
  it('prefixes with "Doručenka: " and otherwise matches the message filename', () => {
    const msgName = formatMessageFilename(msg(), 2);
    const dorName = formatDorucenkaFilename(msg(), 2);
    assert.equal(dorName, `Doručenka: ${msgName}`);
  });

  it('still caps length at 200 including the prefix', () => {
    const longSubject = 'Y'.repeat(500);
    const name = formatDorucenkaFilename(
      msg({ dmAnnotation: longSubject }),
      1,
    );
    assert.ok(name.length <= 200, `length=${name.length.toString()}`);
    assert.ok(name.startsWith('Doručenka: '));
    assert.match(name, /\(attachments: 1\)\.zfo$/);
  });

  it('applies the unknown-field fallbacks to doručenka too', () => {
    const name = formatDorucenkaFilename(
      msg({
        direction: 'sent',
        dmRecipient: null,
        dmAnnotation: null,
      }),
      null,
    );
    assert.ok(name.startsWith('Doručenka: '));
    assert.match(name, /Unknown recipient/);
    assert.match(name, /Unknown subject/);
    assert.match(name, /\(attachments: \?\)/);
  });
});
