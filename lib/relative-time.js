const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

// Beyond this, new Date(ms).toISOString() throws (max ECMAScript Date value)
export const MAX_TIMESTAMP_MS = 8640000000000000;

const UNITS = [
  { ms: 365 * DAY_MS, name: 'year' },
  { ms: 30 * DAY_MS, name: 'month' },
  { ms: 7 * DAY_MS, name: 'week' },
  { ms: DAY_MS, name: 'day' },
  { ms: HOUR_MS, name: 'hour' },
  { ms: MINUTE_MS, name: 'minute' },
];

export function formatRelativeTime(timestampMs, nowMs = Date.now()) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0 || timestampMs > MAX_TIMESTAMP_MS) return '';

  const elapsedMs = nowMs - timestampMs;
  for (const unit of UNITS) {
    if (elapsedMs >= unit.ms) {
      const count = Math.floor(elapsedMs / unit.ms);
      return `${count} ${unit.name}${count === 1 ? '' : 's'} ago`;
    }
  }

  // Covers anything under a minute, including future timestamps from clock skew
  return 'just now';
}
