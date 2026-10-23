/**
 * dashboard.js — library overview: statistics, continue-learning, review due
 * and recent activity. Everything is computed from IndexedDB; no network.
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate } from '../router.js';
import { bus } from '../utils/bus.js';
import { debounce } from '../utils/debounce.js';
import { emptyState, skeleton, progressBar } from '../components/feedback.js';
import { getStats, lessonsRepo, activityLog, flashcardsRepo } from '../db/repositories/index.js';
import { formatRelative, formatDue, formatNumber, formatBytes, pluralize } from '../utils/format.js';

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function statCard(label, value, hint, accent = false) {
  return h('div', { class: `stat${accent ? ' stat--accent' : ''}` }, [
    h('div', { class: 'stat__label', text: label }),
    h('div', { class: 'stat__value', text: formatNumber(value) }),
    hint ? h('div', { class: 'stat__hint', text: hint }) : null,
  ]);
}

function quickTile(label, iconName, path) {
  return h('a', {
    class: 'quick-tile',
    href: `#${path}`,
    on: { click: (event) => { event.preventDefault(); navigate(path); } },
  }, [icon(iconName), h('span', { text: label })]);
}

function miniRow({ title, meta, onClick }) {
  return h('button', { class: 'mini-row', type: 'button', on: { click: onClick } }, [
    h('span', { class: 'mini-row__title', text: title }),
    meta ? h('span', { class: 'mini-row__meta', text: meta }) : null,
  ]);
}

function section(title, hint, content) {
  return h('section', { class: 'section' }, [
    h('div', { class: 'section__header' }, [
      h('h2', { class: 'section__title', text: title }),
      hint ? h('span', { class: 'section__hint', text: hint }) : null,
    ]),
    content,
  ]);
}

export default {
  id: 'dashboard',
  title: () => 'Dashboard',
  breadcrumbs: () => [{ label: 'Dashboard', path: '/dashboard' }],

  mount(container, ctx) {
    ctx.setBreadcrumbs?.([{ label: 'Dashboard', path: '/dashboard' }]);

    const root = h('div', { class: 'stack stack--lg' });
    container.appendChild(root);
    root.appendChild(skeleton({ count: 4, variant: 'title' }));

    let disposed = false;

    async function render() {
      if (disposed) return;
      try {
        const [stats, lessons, dueLessons, dueCards, activity] = await Promise.all([
          getStats(),
          lessonsRepo.getAll(),
          lessonsRepo.getReviewDue(),
          flashcardsRepo.getDue ? flashcardsRepo.getDue() : flashcardsRepo.getAll(),
          activityLog.list({ limit: 8 }),
        ]);
        if (disposed) return;

        const now = Date.now();
        const recent = lessons
          .filter((lesson) => lesson.lastOpenedAt || lesson.updatedAt)
          .sort((a, b) => (b.lastOpenedAt || b.updatedAt) - (a.lastOpenedAt || a.updatedAt))
          .slice(0, 5);

        const totalCards = stats.lessons + stats.snippets + stats.cards;
        clear(root);

        root.appendChild(
          h('header', { class: 'page-header' }, [
            h('div', { class: 'page-header__title' }, [
              h('h1', { text: greeting() }),
              h('p', {
                class: 'page-header__subtitle',
                text: new Date().toLocaleDateString(undefined, {
                  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
                }),
              }),
            ]),
            h('div', { class: 'page-header__actions' }, [
              h('button', {
                class: 'btn btn--primary',
                type: 'button',
                on: { click: () => navigate('/lesson/new') },
              }, [icon('plus'), 'New lesson']),
              h('button', {
                class: 'btn',
                type: 'button',
                on: { click: () => navigate('/settings?section=data') },
              }, [icon('upload'), 'Import']),
            ]),
          ]),
        );

        if (totalCards === 0 && stats.languages === 0) {
          root.appendChild(
            emptyState({
              iconName: 'library',
              title: 'Your knowledge library starts here',
              text: 'Write your first lesson, save a code snippet, or import an existing backup. Everything stays in this browser unless you turn on sync.',
              actions: [
                { label: 'Create your first lesson', variant: 'primary', onClick: () => navigate('/lesson/new') },
                { label: 'Import a backup', onClick: () => navigate('/settings?section=data') },
              ],
            }),
          );
          return;
        }

        root.appendChild(
          h('div', { class: 'grid grid--stats' }, [
            statCard('Lessons', stats.lessons, `${stats.byStatus.learned} learned · ${stats.byStatus.learning} learning`),
            statCard('Snippets', stats.snippets, `${stats.favorites} favorites overall`),
            statCard('Flashcards', stats.cards, stats.cardsPendingApproval ? `${stats.cardsPendingApproval} awaiting approval` : 'all approved'),
            statCard('Languages', stats.languages, `${stats.categories} topics`),
            statCard('Due for review', stats.reviewDue, stats.reviewDue ? 'ready when you are' : 'nothing due', stats.reviewDue > 0),
            statCard('Archived', stats.archived, 'hidden from lists'),
          ]),
        );

        const dash = h('div', { class: 'dash-grid' });
        const main = h('div', { class: 'stack stack--lg' });
        const side = h('div', { class: 'stack stack--lg' });

        main.appendChild(
          section('Quick actions', null, h('div', { class: 'dash-quick' }, [
            quickTile('New lesson', 'edit', '/lesson/new'),
            quickTile('New snippet', 'snippet', '/snippets?new=1'),
            quickTile('New flashcard', 'review', '/review?new=1'),
            quickTile('Ask the assistant', 'sparkles', '/assistant'),
            quickTile('Browse library', 'library', '/library'),
            quickTile('Review now', 'play', '/review'),
          ])),
        );

        main.appendChild(
          section('Continue learning', recent.length ? 'last opened' : null,
            recent.length
              ? h('div', { class: 'mini-list' }, recent.map((lesson) =>
                  miniRow({
                    title: lesson.title,
                    meta: `${lesson.status.replace('-', ' ')} · ${formatRelative(lesson.lastOpenedAt || lesson.updatedAt)}`,
                    onClick: () => navigate(`/lesson/${encodeURIComponent(lesson.id)}`),
                  }),
                ))
              : h('p', { class: 'text-muted', text: 'Nothing opened yet — lessons you read will appear here.' }),
          ),
        );

        const dueItems = [
          ...dueLessons.map((lesson) => ({
            kind: 'lesson',
            id: lesson.id,
            title: lesson.title,
            meta: `lesson · ${formatDue(lesson.reviewAt, now)}`,
          })),
          ...dueCards.slice(0, 6).map((card) => ({
            kind: 'card',
            id: card.id,
            title: card.front,
            meta: `card · ${formatDue(card.dueAt, now)}`,
          })),
        ].slice(0, 6);

        main.appendChild(
          section('Due for review', dueItems.length ? `${stats.reviewDue} total` : null,
            dueItems.length
              ? h('div', { class: 'mini-list' }, dueItems.map((item) =>
                  miniRow({
                    title: item.title,
                    meta: item.meta,
                    onClick: () => navigate(item.kind === 'lesson' ? `/lesson/${encodeURIComponent(item.id)}` : '/review'),
                  }),
                ))
              : h('p', { class: 'text-muted', text: 'Nothing is due. Review scheduling appears here once you add cards.' }),
          ),
        );

        main.appendChild(
          section('Recent activity', null,
            activity.length
              ? h('div', { class: 'mini-list' }, activity.map((row) =>
                  miniRow({
                    title: `${row.action} · ${row.label}`,
                    meta: formatRelative(row.at),
                    onClick: () => navigate('/activity'),
                  }),
                ))
              : h('p', { class: 'text-muted', text: 'No activity recorded yet.' }),
          ),
        );

        // --- side column -----------------------------------------------------
        const learnedPct = stats.lessons ? Math.round((stats.byStatus.learned / stats.lessons) * 100) : 0;
        side.appendChild(
          section('Progress', `${stats.lessons} ${pluralize(stats.lessons, 'lesson')}`, [
            stats.lessons
              ? progressBar({ value: stats.byStatus.learned, max: stats.lessons, label: 'Lessons learned' })
              : progressBar({ label: 'No lessons yet' }),
            h('div', { class: 'meta-line mt-2' }, [
              h('span', { text: `${learnedPct}% learned` }),
              h('span', { text: `${stats.byStatus.learning} in progress` }),
            ]),
          ]),
        );

        side.appendChild(
          section('Storage', null, [
            h('div', { class: 'stack stack--sm' }, [
              h('div', { class: 'meta-line' }, [
                h('span', { text: `${stats.lessons + stats.snippets + stats.cards} records` }),
              ]),
              h('div', { class: 'meta-line' }, [
                h('span', {
                  text: stats.storage?.usage != null
                    ? `${formatBytes(stats.storage.usage)} used${stats.storage.quota ? ` of ${formatBytes(stats.storage.quota)}` : ''}`
                    : 'Storage estimate unavailable',
                }),
              ]),
              h('button', {
                class: 'btn btn--sm',
                type: 'button',
                on: { click: () => navigate('/activity') },
              }, [icon('activity'), 'View history']),
            ]),
          ]),
        );

        dash.append(main, side);
        root.appendChild(dash);
      } catch (err) {
        if (disposed) return;
        console.error('[dashboard] render failed:', err);
        clear(root);
        root.appendChild(emptyState({
          iconName: 'alert',
          title: 'Dashboard could not load',
          text: String(err?.message || err),
          actions: [{ label: 'Reload', variant: 'primary', onClick: () => location.reload() }],
        }));
      }
    }

    const reload = debounce(render, 300);
    const offData = bus.on('data:changed', reload);
    render();

    return {
      destroy() {
        disposed = true;
        offData();
        reload.cancel?.();
      },
      onShow() { render(); },
    };
  },
};
