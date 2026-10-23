/** format.js — dates, numbers and sizes (pure, unit-testable). */

const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
});
const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

export function formatDate(ts) {
  if (!ts) return '—';
  return dateFmt.format(new Date(ts));
}

export function formatDateTime(ts) {
  if (!ts) return '—';
  return dateTimeFmt.format(new Date(ts));
}

/** Compact relative time: "just now", "5m ago", "3d ago", then a date. */
export function formatRelative(ts, now = Date.now()) {
  if (!ts) return 'never';
  const diff = now - ts;
  if (diff < 0) return formatDateTime(ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  if (day < 35) {
    const weeks = Math.floor(day / 7);
    return `${weeks}w ago`;
  }
  return formatDate(ts);
}

/** Due-label for review dates: "overdue by 2d", "today", "in 3d". */
export function formatDue(ts, now = Date.now()) {
  if (!ts) return '';
  const dayMs = 86400000;
  const a = new Date(ts); a.setHours(0, 0, 0, 0);
  const b = new Date(now); b.setHours(0, 0, 0, 0);
  const days = Math.round((a - b) / dayMs);
  if (days === 0) return 'due today';
  if (days < 0) return `overdue by ${Math.abs(days)}d`;
  if (days === 1) return 'due tomorrow';
  return `due in ${days}d`;
}

export function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '0';
  return new Intl.NumberFormat().format(n);
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i += 1; }
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

/** Basic word/character counts for editor status bars. */
export function countWords(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return { words: 0, chars: 0, lines: 0 };
  const words = trimmed.split(/\s+/).length;
  return { words, chars: String(text).length, lines: String(text).split('\n').length };
}

export function pluralize(count, singular, plural = `${singular}s`) {
  return `${formatNumber(count)} ${count === 1 ? singular : plural}`;
}
