/**
 * not-found.js — unknown route fallback.
 */

import { h } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate } from '../router.js';

export default {
  id: 'notFound',
  title: () => 'Not found',

  mount(container, ctx) {
    const wanted = ctx.params?.path || location.hash.replace(/^#/, '') || '/';

    container.appendChild(
      h('div', { class: 'notfound' }, [
        h('div', { class: 'notfound__code', text: '404' }),
        h('h1', { text: 'This page does not exist' }),
        h('p', { class: 'text-muted', text: `No DevNotes screen matches “${wanted}”.` }),
        h('div', { class: 'row', style: { justifyContent: 'center' } }, [
          h('button', {
            class: 'btn btn--primary',
            type: 'button',
            on: { click: () => navigate('/dashboard') },
          }, [icon('dashboard'), 'Go to dashboard']),
          h('button', {
            class: 'btn',
            type: 'button',
            on: { click: () => navigate('/library') },
          }, [icon('library'), 'Open library']),
        ]),
      ]),
    );

    return {};
  },
};
