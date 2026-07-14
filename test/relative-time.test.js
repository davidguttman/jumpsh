import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatRelativeTime } from '../lib/relative-time.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-07-14T12:00:00Z');

describe('formatRelativeTime', () => {
  it('returns an empty label for missing or invalid timestamps', () => {
    assert.equal(formatRelativeTime(0, NOW), '');
    assert.equal(formatRelativeTime(-5, NOW), '');
    assert.equal(formatRelativeTime(NaN, NOW), '');
    assert.equal(formatRelativeTime(Infinity, NOW), '');
    assert.equal(formatRelativeTime(undefined, NOW), '');
    assert.equal(formatRelativeTime(null, NOW), '');
    assert.equal(formatRelativeTime('2026-07-14', NOW), '');
  });

  it('labels anything under a minute as just now', () => {
    assert.equal(formatRelativeTime(NOW, NOW), 'just now');
    assert.equal(formatRelativeTime(NOW - 59 * 1000, NOW), 'just now');
  });

  it('labels future timestamps from clock skew as just now', () => {
    assert.equal(formatRelativeTime(NOW + 5 * MINUTE, NOW), 'just now');
  });

  it('labels minutes with singular and plural forms', () => {
    assert.equal(formatRelativeTime(NOW - MINUTE, NOW), '1 minute ago');
    assert.equal(formatRelativeTime(NOW - 59 * MINUTE, NOW), '59 minutes ago');
  });

  it('labels hours', () => {
    assert.equal(formatRelativeTime(NOW - HOUR, NOW), '1 hour ago');
    assert.equal(formatRelativeTime(NOW - 5 * HOUR, NOW), '5 hours ago');
    assert.equal(formatRelativeTime(NOW - 23 * HOUR, NOW), '23 hours ago');
  });

  it('labels days, weeks, months, and years', () => {
    assert.equal(formatRelativeTime(NOW - DAY, NOW), '1 day ago');
    assert.equal(formatRelativeTime(NOW - 6 * DAY, NOW), '6 days ago');
    assert.equal(formatRelativeTime(NOW - 7 * DAY, NOW), '1 week ago');
    assert.equal(formatRelativeTime(NOW - 29 * DAY, NOW), '4 weeks ago');
    assert.equal(formatRelativeTime(NOW - 30 * DAY, NOW), '1 month ago');
    assert.equal(formatRelativeTime(NOW - 364 * DAY, NOW), '12 months ago');
    assert.equal(formatRelativeTime(NOW - 365 * DAY, NOW), '1 year ago');
    assert.equal(formatRelativeTime(NOW - 800 * DAY, NOW), '2 years ago');
  });
});
