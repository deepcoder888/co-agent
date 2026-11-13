// v0.53: dates, daily counts and the daily concept's day follow the computer's own time zone, not a fixed one.
// This file runs as a computer in UTC; the modules are loaded after the time zone is set.
process.env.TZ = 'UTC';
const test = (await import('node:test')).default;
const assert = (await import('node:assert/strict')).default;
const { localTime } = await import('../src/concepts/index.mjs');
const { formatLocal } = await import('../src/stats/index.mjs');
const { formatDate } = await import('../public/display.js');

test('v0535 a computer in UTC sees UTC days and times', () => {
  assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC');
  // 16:00 UTC is already the next day in UTC+8; here it is still the same day, 960 minutes in.
  assert.deepEqual(localTime(new Date('2026-10-07T16:00:00Z')), { day: '2026-10-07', minutes: 960 });
  assert.equal(formatLocal('2026-10-07T16:00:00Z'), '2026-10-07 16:00:00');
  assert.equal(formatDate('2026-10-07T16:00:00Z'), '2026-10-07 16:00:00');
});
