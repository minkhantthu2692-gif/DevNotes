/**
 * languages.js — Languages page (thin wrapper over the shared taxonomy factory).
 */

import { createTaxonomyPage } from '../features/taxonomy/taxonomy-page.js';
import { languagesRepo } from '../db/repositories/index.js';

export default createTaxonomyPage({
  kind: 'language',
  repo: languagesRepo,
  title: 'Languages',
  subtitle: 'Languages, frameworks and libraries used in your lessons.',
  plural: 'languages',
  icon: 'languages',
  emptyTitle: 'No languages yet',
  emptyText: 'Add the technologies you study — they become filters across the library.',
  descriptionPlaceholder: 'e.g. The default language for most of my lessons',
  queryPrefix: '',
});
