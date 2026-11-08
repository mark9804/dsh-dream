import assert from 'node:assert/strict';
import test from 'node:test';
import { calendarParts, inRestWindow, localDate, recentDates } from '../dist/scheduler/window.js';

test('the default 05:00–07:00 generation window is left-closed and right-open', () => {
  const options = { timeZone: 'Asia/Tokyo' };
  assert.equal(inRestWindow(new Date('2026-10-26T04:59:59+09:00'), options), false);
  assert.equal(inRestWindow(new Date('2026-10-26T05:00:00+09:00'), options), true);
  assert.equal(inRestWindow(new Date('2026-10-26T06:59:59+09:00'), options), true);
  assert.equal(inRestWindow(new Date('2026-10-26T07:00:00+09:00'), options), false);
});

test('a window crossing midnight includes both sides without including its end', () => {
  const options = { start: '23:00', end: '02:00', timeZone: 'UTC' };
  for (const [time, expected] of [['22:59:59', false], ['23:00:00', true], ['00:00:00', true], ['01:59:59', true], ['02:00:00', false]]) {
    assert.equal(inRestWindow(new Date(`2026-10-26T${time}Z`), options), expected);
  }
});

test('recent days follow the selected local calendar across midnight and year boundaries', () => {
  const instant = new Date('2026-12-31T15:30:00Z');
  assert.equal(localDate(instant, 'Asia/Tokyo'), '2027-01-01');
  assert.deepEqual(recentDates(instant, 'Asia/Tokyo'), ['2027-01-01', '2026-12-31', '2026-12-30']);
  assert.deepEqual(recentDates(instant, 'America/Los_Angeles'), ['2026-12-31', '2026-12-30', '2026-12-29']);
});

test('recent days do calendar arithmetic across both DST transitions', () => {
  assert.deepEqual(recentDates(new Date('2026-03-09T00:30:00-04:00'), 'America/New_York'), ['2026-03-09', '2026-03-08', '2026-03-07']);
  assert.deepEqual(recentDates(new Date('2026-11-01T23:30:00-05:00'), 'America/New_York'), ['2026-11-01', '2026-10-31', '2026-10-30']);
});

test('local timezone is resolved on each call rather than hardcoded or cached', () => {
  const previous = process.env.TZ;
  const instant = new Date('2026-10-25T20:00:00Z');
  try {
    process.env.TZ = 'Asia/Tokyo';
    assert.equal(inRestWindow(instant), true);
    assert.equal(localDate(instant), '2026-10-26');
    assert.equal(calendarParts(instant).hour, '05');
    process.env.TZ = 'America/Los_Angeles';
    assert.equal(inRestWindow(instant), false);
    assert.equal(localDate(instant), '2026-10-25');
    assert.equal(calendarParts(instant).hour, '13');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
