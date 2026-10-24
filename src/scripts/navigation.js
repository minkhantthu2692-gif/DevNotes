/**
 * navigation.js — single source of truth for the app's destinations.
 * Used by the sidebar, the command palette and deep links.
 */

export const NAV_SECTIONS = [
  {
    label: 'Workspace',
    items: [
      { id: 'dashboard', path: '/dashboard', label: 'Dashboard', icon: 'dashboard' },
      { id: 'library', path: '/library', label: 'Programming Library', icon: 'library' },
      { id: 'languages', path: '/languages', label: 'Languages', icon: 'languages' },
      { id: 'categories', path: '/categories', label: 'Categories & Topics', icon: 'folder' },
      { id: 'snippets', path: '/snippets', label: 'Code Snippets', icon: 'snippet' },
      { id: 'favorites', path: '/favorites', label: 'Favorites', icon: 'star' },
      { id: 'review', path: '/review', label: 'Review & Flashcards', icon: 'review', badge: 'reviewDue' },
    ],
  },
  {
    label: 'Intelligence',
    items: [
      { id: 'assistant', path: '/assistant', label: 'AI Assistant', icon: 'sparkles' },
      { id: 'activity', path: '/activity', label: 'Activity & History', icon: 'activity' },
      { id: 'trash', path: '/trash', label: 'Trash', icon: 'trash', badge: 'trash' },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'settings', path: '/settings', label: 'Settings', icon: 'settings' },
      { id: 'account', path: '/account', label: 'Account & Sync', icon: 'user' },
    ],
  },
];

/** Flat view for lookups. */
export const NAV_ITEMS = NAV_SECTIONS.flatMap((section) => section.items);

/** Lazy page module loaders — native dynamic import keeps the shell small. */
export const PAGE_LOADERS = {
  auth: () => import('./pages/auth.js'),
  dashboard: () => import('./pages/dashboard.js'),
  library: () => import('./pages/library.js'),
  languages: () => import('./pages/languages.js'),
  categories: () => import('./pages/categories.js'),
  editor: () => import('./pages/editor.js'),
  snippets: () => import('./pages/snippets.js'),
  favorites: () => import('./pages/favorites.js'),
  review: () => import('./pages/review.js'),
  assistant: () => import('./pages/assistant.js'),
  activity: () => import('./pages/activity.js'),
  trash: () => import('./pages/trash.js'),
  settings: () => import('./pages/settings.js'),
  account: () => import('./pages/account.js'),
  notFound: () => import('./pages/not-found.js'),
};
