/**
 * categories.js — Categories & Topics page.
 *
 * Hosts two factory-built taxonomy pages (categories + courses) behind a
 * segmented control on one route. Each section keeps its own URL params via
 * query prefixes ('c' for categories, 'k' for courses) so their search and
 * trashed filters never collide, and both stay mounted so switching sections
 * never loses DOM state.
 */

import { h } from '../utils/dom.js';
import { createTaxonomyPage } from '../features/taxonomy/taxonomy-page.js';
import { categoriesRepo, coursesRepo } from '../db/repositories/index.js';

const categoriesSection = createTaxonomyPage({
  kind: 'category',
  repo: categoriesRepo,
  title: 'Categories',
  subtitle: 'Topics and courses that organize your library.',
  plural: 'categories',
  icon: 'folder',
  emptyTitle: 'No categories yet',
  emptyText: 'Group your lessons into topics to make the library easier to browse.',
  descriptionPlaceholder: 'e.g. Algorithms and data structures',
  queryPrefix: 'c',
  embedded: true,
});

const coursesSection = createTaxonomyPage({
  kind: 'course',
  repo: coursesRepo,
  title: 'Courses',
  subtitle: 'Courses that organize your library.',
  plural: 'courses',
  icon: 'book',
  emptyTitle: 'No courses yet',
  emptyText: 'Track the courses, books or series your lessons come from.',
  descriptionPlaceholder: 'e.g. Advanced Algorithms (university course)',
  queryPrefix: 'k',
  embedded: true,
});

export default {
  id: 'categories',
  title: () => 'Categories & Topics',

  mount(container, ctx) {
    ctx.setBreadcrumbs?.([{ label: 'Categories & Topics', path: '/categories' }]);

    let section = ctx.query.section === 'courses' ? 'courses' : 'categories';

    const radios = new Map();
    const segmented = h('div', {
      class: 'segmented',
      attrs: { role: 'radiogroup', 'aria-label': 'Taxonomy section' },
    }, [
      ['categories', 'Categories'],
      ['courses', 'Courses'],
    ].map(([value, label]) => {
      const radio = h('input', {
        type: 'radio',
        name: 'taxonomy-section',
        value,
        attrs: section === value ? { checked: '' } : {},
        on: {
          change: () => {
            // URL stays the source of truth; the router hands the change
            // back through onQuery, which performs the actual switch.
            ctx.setQuery({ section: value === 'categories' ? null : value });
          },
        },
      });
      radios.set(value, radio);
      return h('label', { class: 'segmented__option' }, [radio, h('span', { text: label })]);
    }));

    const header = h('header', { class: 'page-header' }, [
      h('div', { class: 'page-header__title' }, [
        h('h1', { text: 'Categories & Topics' }),
        h('p', { class: 'page-header__subtitle', text: 'Topics and courses that organize your library.' }),
      ]),
      h('div', { class: 'page-header__actions' }, [segmented]),
    ]);

    const categoriesHost = h('div', { class: 'stack' });
    const coursesHost = h('div', { class: 'stack', hidden: true });
    const root = h('div', { class: 'stack stack--lg' }, [header, categoriesHost, coursesHost]);
    container.appendChild(root);

    // Both children are mounted once and kept alive; prefixed query keys keep
    // their filters independent while sharing the same ctx.setQuery.
    const controllers = {
      categories: categoriesSection.mount(categoriesHost, ctx),
      courses: coursesSection.mount(coursesHost, ctx),
    };

    function switchTo(value) {
      section = value;
      categoriesHost.hidden = value !== 'categories';
      coursesHost.hidden = value !== 'courses';
      for (const [key, radio] of radios) radio.checked = key === value;
      controllers[value].onShow();
    }

    return {
      onQuery(next) {
        switchTo(next.section === 'courses' ? 'courses' : 'categories');
        controllers.categories.onQuery(next);
        controllers.courses.onQuery(next);
      },
      onShow() { controllers[section].onShow(); },
      destroy() {
        controllers.categories.destroy();
        controllers.courses.destroy();
      },
    };
  },
};
