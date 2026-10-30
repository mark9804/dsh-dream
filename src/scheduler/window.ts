/** Resolve local time on each call so a system timezone change takes effect. */
export function calendarParts(date: Date, timeZone = 'local') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    ...(timeZone === 'local' ? {} : { timeZone }),
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
}

export function localDate(date: Date, timeZone = 'local') {
  const p = calendarParts(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

export function inRestWindow(date: Date, { start = '05:00', end = '07:00', timeZone = 'local' } = {}) {
  const p = calendarParts(date, timeZone);
  const current = `${p.hour}:${p.minute}`;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

/** Calendar arithmetic avoids treating a DST day as exactly 24 elapsed hours. */
export function recentDates(date: Date, timeZone = 'local', count = 3) {
  const p = calendarParts(date, timeZone);
  const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  return Array.from({ length: count }, (_, i) => {
    const d = new Date(day);
    d.setUTCDate(d.getUTCDate() - i);
    return d.toISOString().slice(0, 10);
  });
}
