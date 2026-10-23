/**
 * icons.js — inline SVG icon set (24×24, stroke = currentColor).
 * All markup here is static and application-authored; `icon()` is therefore
 * safe to use with innerHTML (no user or remote content ever passes through).
 */

const P = {
  dashboard: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="4.5" rx="1.5"/><rect x="13.5" y="10.5" width="7.5" height="10.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
  library: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 16.5z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h4.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
  code: '<path d="M8.5 7 4 12l4.5 5M15.5 7l4.5 5-4.5 5M13.5 4l-3 16"/>',
  folder: '<path d="M4 7a2 2 0 0 1 2-2h3.6a2 2 0 0 1 1.4.6L12.5 7H18a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>',
  edit: '<path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z"/><path d="M14.5 6.5l3 3"/>',
  snippet: '<path d="M8 4H6a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h2M16 4h2a2 2 0 0 1 2 2v3a2 2 0 0 0 2 2 2 2 0 0 0-2 2v3a2 2 0 0 1-2 2h-2"/>',
  star: '<path d="m12 4 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 9.7l5.4-.8z"/>',
  review: '<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H8l-4 3z"/><path d="M8.5 10.5h7M8.5 13.5h4"/>',
  sparkles: '<path d="m12 3 1.7 4.3L18 9l-4.3 1.7L12 15l-1.7-4.3L6 9l4.3-1.7z"/><path d="m18.5 15 .9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/><path d="m5.5 3 .7 1.6 1.6.7-1.6.7-.7 1.6-.7-1.6-1.6-.7 1.6-.7z"/>',
  activity: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
  trash: '<path d="M5 7h14M10 7V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2M6.5 7l.8 11a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7M10 11v5M14 11v5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 14.5a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/>',
  user: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-3.8-3.8"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  chevronRight: '<path d="m9.5 6 6 6-6 6"/>',
  chevronDown: '<path d="m6 9.5 6 6 6-6"/>',
  chevronLeft: '<path d="m14.5 6-6 6 6 6"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  more: '<circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4"/>',
  moon: '<path d="M19 14.5A8 8 0 0 1 9.5 5 8.2 8.2 0 1 0 19 14.5"/>',
  monitor: '<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20h6M12 16.5V20"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4.5A1.5 1.5 0 0 1 3 13.5V5.5A1.5 1.5 0 0 1 4.5 4h8A1.5 1.5 0 0 1 14 5.5V6"/>',
  duplicate: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 14a2 2 0 0 1-1-1.7V6a2 2 0 0 1 2-2h6.3A2 2 0 0 1 12 5"/>',
  download: '<path d="M12 4v10M8 10.5l4 4 4-4M5 19h14"/>',
  upload: '<path d="M12 15V5M8 8.5l4-4 4 4M5 19h14"/>',
  pin: '<path d="M9 3.5h6l-.7 5.2 2.7 2.8H7l2.7-2.8zM12 11.5V21"/>',
  archive: '<rect x="3.5" y="4.5" width="17" height="4.5" rx="1.5"/><path d="M5 9v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9M10 13.5h4"/>',
  restore: '<path d="M4 10a8 8 0 1 1 2.3 6.4"/><path d="M4 5v5h5"/>',
  filter: '<path d="M4 6h16l-6 7v5l-4 2v-7z"/>',
  sort: '<path d="M7 4v13M7 17l-3-3M7 17l3-3M17 20V7M17 7l-3 3M17 7l3 3"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.4-8A5.5 5.5 0 0 1 17.3 10 3.9 3.9 0 0 1 17 18z"/>',
  cloudOff: '<path d="M7 18a4 4 0 0 1-.4-8 5.5 5.5 0 0 1 8.6-2.6M18.7 9.4A3.9 3.9 0 0 1 17 18h-6M4 4l16 16"/>',
  alert: '<path d="M12 4 3 19h18z"/><path d="M12 10v4M12 16.5v.5"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8v.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-13.7-5.2L4 8M4 4v4h4M4 13a8 8 0 0 0 13.7 5.2L20 16M20 20v-4h-4"/>',
  external: '<path d="M14 5h5v5M19 5l-7.5 7.5"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12"/><circle cx="12" cy="12" r="3"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  maximize: '<path d="M8 4H4v4M16 4h4v4M8 20H4v-4M16 20h4v-4"/>',
  minimize: '<path d="M4 8h4V4M20 8h-4V4M4 16h4v4M20 16h-4v4"/>',
  command: '<path d="M9 6a2.5 2.5 0 1 0-2.5 2.5H9zm0 0v12m0-12h6M15 6a2.5 2.5 0 1 1 2.5 2.5H15zm0 0v12m0 0a2.5 2.5 0 1 0 2.5-2.5H15zm-6 0a2.5 2.5 0 1 1-2.5-2.5H9z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  tag: '<path d="M4 11V5.5A1.5 1.5 0 0 1 5.5 4H11l8.5 8.5a1.5 1.5 0 0 1 0 2.1l-4.9 4.9a1.5 1.5 0 0 1-2.1 0z"/><circle cx="8" cy="8" r="1.2"/>',
  book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5z"/><path d="M5 19.5A1.5 1.5 0 0 1 6.5 18H19v3H6.5A1.5 1.5 0 0 1 5 19.5z"/>',
  flag: '<path d="M6 21V4M6 4h11l-2 3.5L17 11H6"/>',
  key: '<circle cx="8" cy="14" r="4"/><path d="m11 11 8-8M16 6l2 2M14 8l2 2"/>',
  keyboard: '<rect x="3" y="6.5" width="18" height="11" rx="2"/><path d="M7 10h.5M11 10h.5M15 10h.5M7 14h10"/>',
  languages: '<path d="M4 6h9M8.5 4v2M11 6c0 4-3 8-7 9M6.5 11c1.5 2.5 3.5 4 6 4.5M13 20l4-10 4 10M14.5 16.5h5"/>',
  wrapText: '<path d="M4 6h16M4 12h12.5a3.5 3.5 0 0 1 0 7H14M4 18h3.5M14 15l-2.5 2.5L14 20"/>',
  lineNumbers: '<path d="M4 6h2M4 12h2M4 18h2M9 6h11M9 12h11M9 18h11"/>',
  preview: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/>',
  logout: '<path d="M14 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2"/><path d="M9 12h11M17 9l3 3-3 3"/>',
  play: '<path d="M8 5.5v13l11-6.5z"/>',
};

/**
 * Build an icon element.
 * @param {string} name key of the icon set
 * @param {string} [className] extra classes for sizing/coloring
 */
export function icon(name, className = '') {
  const span = document.createElement('span');
  span.className = `icon${className ? ` ${className}` : ''}`;
  span.setAttribute('aria-hidden', 'true');
  span.style.display = 'inline-flex';
  span.style.flex = 'none';
  const path = P[name] || P.info;
  span.innerHTML =
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" ` +
    `stroke-linecap="round" stroke-linejoin="round" width="100%" height="100%">${path}</svg>`;
  return span;
}

export function iconMarkup(name) {
  return P[name] || P.info;
}

export const iconNames = Object.keys(P);
