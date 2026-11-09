const paths = {
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M5 16H3V3h13v2"/>',
  chevron: '<path d="m5 9 7 7 7-7"/>',
  earAlert:
    '<path d="M4 8.5a5 5 0 0 1 10 0c0 3.5-3 4.5-3 7.5a3 3 0 0 1-5.6 1.5M7 9a2 2 0 0 1 4 0M20 5v7M20 16v.5"/>',
  tabOff:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18M9 12l6 5M15 12l-6 5M6 6.5h2"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  play: '<path d="M7 4l14 8-14 8z"/>',
  eye: '<path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v.5"/>',
  dots: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  keyboard:
    '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M7 16h10"/>',
  caption:
    '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 10h10M7 14h7"/>',
  puzzle:
    '<path d="M4 4h6a3 3 0 1 1 6 0h4v6a3 3 0 1 0 0 6v4H4v-6a3 3 0 1 0 0-6z"/>',
  ear: '<path d="M6 8.5a6 6 0 0 1 12 0c0 3.5-3 4.5-3 7.5a3 3 0 0 1-5.6 1.5M9 9a3 3 0 0 1 6 0"/>',
  talk: '<path d="M4 8h7v8H4zM15 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14M4 12h7"/>',
  speaker:
    '<path d="M11 5L6 9H3v6h3l5 4V5zM15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"/>',
  micOff:
    '<path d="M2 2l20 20M9 9v3a3 3 0 0 0 5 2M9 5V4a3 3 0 0 1 6 0v6M5 10v2a7 7 0 0 0 12 5M19 10v2M12 19v3M8 22h8"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  cross: '<path d="M6 6l12 12M18 6L6 18"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  spinner: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="m10 2 4 0 .7 3 2 .9 2.8-1 2 3.5-2.2 2v3.2l2.2 2-2 3.5-2.8-1-2 .9-.7 3h-4l-.7-3-2-.9-2.8 1-2-3.5 2.2-2v-3.2l-2.2-2 2-3.5 2.8 1 2-.9z"/>',
  intro:
    '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12zM10 9v4M13 8v5M8 12v1a4 4 0 0 0 8 0v-2"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M3 6l1 1 3-3M3 12l1 1 3-3"/><circle cx="5" cy="18" r="1"/>',
  arrow: '<path d="M12 4v16M5 13l7 7 7-7"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  edit: '<path d="M4 16L16 4l4 4L8 20H4v-4M13 7l4 4"/>',
  warn: '<path d="M12 3L2 21h20L12 3zM12 9v5M12 17v.5"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M4 16v5h16v-5"/>',
  empty: '<path d="M4 5h16v12H9l-5 4V5zM8 9h8M8 13h5"/>',
};
export const icon = (name, size = 20) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.empty}</svg>`;
