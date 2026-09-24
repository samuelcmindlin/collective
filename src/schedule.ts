import type { Settings } from './types.js';

export function localParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short', hour: 'numeric', minute: 'numeric', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
  return { weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday')), hour: Number(get('hour')), minute: Number(get('minute')), day: `${get('year')}-${get('month')}-${get('day')}` };
}
export function isOpen(date: Date, settings: Settings) {
  const local = localParts(date, settings.timezone);
  return settings.weekdays.includes(local.weekday) && local.hour >= settings.startHour && local.hour < settings.endHour;
}
export function nextOpen(date: Date, settings: Settings) {
  if (isOpen(date, settings)) return date.toISOString();
  // Walk actual UTC minutes, so ambiguous/missing wall times and DST shifts are handled.
  let cursor = new Date(Math.floor(date.getTime() / 60000) * 60000 + 60000);
  for (let i = 0; i < 8 * 24 * 60; i++, cursor = new Date(cursor.getTime() + 60000)) if (isOpen(cursor, settings)) return cursor.toISOString();
  return undefined;
}
