import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { isdsTimestamp } from '../src/index.js';

describe('isdsTimestamp — Europe/Prague local-time formatting', () => {
  it('renders an instant in Prague summer time (CEST = UTC+2)', () => {
    // 2026-04-28T20:10:30Z is 22:10:30 in Prague during DST.
    const d = new Date('2026-04-28T20:10:30.000Z');
    assert.equal(isdsTimestamp(d), '2026-04-28T22:10:30');
  });

  it('renders an instant in Prague winter time (CET = UTC+1)', () => {
    // 2026-01-15T20:10:30Z is 21:10:30 in Prague outside DST.
    const d = new Date('2026-01-15T20:10:30.000Z');
    assert.equal(isdsTimestamp(d), '2026-01-15T21:10:30');
  });

  it('handles the Prague DST spring-forward boundary (last Sunday of March)', () => {
    // 2026-03-29T01:30:00Z is 03:30 Prague (DST started at 02:00 → 03:00).
    const d = new Date('2026-03-29T01:30:00.000Z');
    assert.equal(isdsTimestamp(d), '2026-03-29T03:30:00');
  });

  it('handles the Prague DST fall-back boundary (last Sunday of October)', () => {
    // 2026-10-25T00:30:00Z is 02:30 Prague (DST hasn't ended yet — CEST).
    const d = new Date('2026-10-25T00:30:00.000Z');
    assert.equal(isdsTimestamp(d), '2026-10-25T02:30:00');
  });

  it('does not append a timezone marker (ISDS expects bare-no-TZ)', () => {
    const out = isdsTimestamp(new Date('2026-04-28T20:10:30.000Z'));
    assert.equal(/[Zz]|[+-]\d{2}:\d{2}$/.test(out), false);
  });
});
