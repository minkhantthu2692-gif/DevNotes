AGENTS.md — DevNotes Engineering Rules

1. Project Mission

DevNotes is a maintainable, offline-first programming knowledge library built primarily with HTML, CSS, and vanilla JavaScript.

The objective is a genuinely usable application, not a static mockup.

Prioritize data integrity, security, usability, maintainability, and minimal setup complexity.

Read this file before making changes. Inspect the existing implementation before modifying it.

2. Technology Boundaries

Required

- HTML5
- CSS3
- Vanilla JavaScript
- Native ES modules where supported
- IndexedDB for local persistence
- Supabase for authentication, PostgreSQL, and optional file storage
- Groq API for optional AI functionality

Prohibited as mandatory runtime requirements

- React, Vue, Angular, Svelte, or another frontend framework
- Python runtime
- Node.js application server
- Mandatory local development server
- Mandatory frontend compilation or bundling
- Firebase
- Unnecessary backend infrastructure

Use third-party libraries when they meaningfully improve functionality, security, accessibility, or maintainability.

Do not reject a useful JavaScript library merely because the application is framework-free.

Prefer libraries that work with native browser modules or static hosting.

Pin compatible dependency versions and document their purpose.

Do not introduce a dependency without understanding its maintenance status, licensing, size, security implications, and offline behavior.

3. Code Organization

Keep responsibilities separated.

- "pages/": page-level composition and navigation.
- "components/": reusable UI components.
- "features/": domain-specific functionality.
- "services/": external service integrations.
- "db/": local database and repository implementation.
- "sync/": synchronization and conflict handling.
- "utils/": small reusable utilities.
- "styles/": design tokens, themes, typography, layout, and components.

Adapt the structure when necessary, but avoid mixing UI, database operations, and remote API requests in the same large module.

Avoid monolithic JavaScript files.

Do not create abstractions that add complexity without providing meaningful value.

Use descriptive names and explicit dependencies.

4. HTML Rules

Use semantic HTML.

Prefer accessible native elements over unnecessary custom elements.

Every input must have an accessible label.

Every interactive control must have an appropriate role and keyboard behavior.

Use buttons for actions and links for navigation.

Avoid duplicate IDs.

Use valid markup and meaningful document structure.

Do not rely on browser alert(), confirm(), or prompt() for normal application workflows.

Native file pickers and other necessary browser capabilities may be used when appropriate.

5. CSS and Design Tokens

Use CSS custom properties for shared design values.

Centralize:

- Color tokens
- Accent colors
- Typography
- Spacing
- Border radii
- Shadows
- Layout dimensions
- Animation preferences
- Theme-specific values

Use rem-based scales for typography, padding, margin, gaps, and normal component spacing.

Use grid, flexbox, percentages, minmax(), max-width, and viewport-relative units when appropriate.

Avoid arbitrary pixel values scattered across stylesheets.

A small number of pixel values may be used for optical details such as thin borders, but must not replace the shared spacing system.

Never duplicate a design value across components when an existing token expresses the same purpose.

Support light, dark, and system themes.

Support user-selected accent colors without requiring stylesheet edits.

Maintain sufficient contrast.

Respect "prefers-reduced-motion".

Do not use blur, transparency, shadows, or animation at the expense of readability or performance.

Use responsive layouts rather than fixed desktop dimensions.

Never allow ordinary content to cause unintended horizontal page overflow.

6. Typography and Font Management

Never hard-code one font family throughout the application.

Use centralized font tokens and fallback stacks.

Keep developer-bundled fonts in "src/fonts/".

Maintain a font manifest describing bundled fonts, styles, weights, and available language coverage where known.

Use "@font-face" definitions or a font-loading service.

Support user-imported font files through IndexedDB.

Do not attempt to write user-imported files directly into the application's source directory.

Revoke temporary object URLs when no longer required.

Handle font loading errors and use fallbacks.

Keep interface fonts and code fonts independently configurable.

Do not bundle fonts without appropriate licensing.

7. JavaScript Quality

Use readable, modern JavaScript.

Prefer small functions with clear responsibilities.

Use "const" by default and "let" when reassignment is necessary.

Avoid global variables and unnecessary global event handlers.

Use event listeners and clean them up when appropriate.

Avoid unnecessary DOM reconstruction.

Do not use "eval()" or the "Function" constructor to execute user content.

Do not automatically execute saved code snippets.

Avoid unsafe HTML insertion. Use "textContent" for plain text and an appropriately configured sanitizer for intentionally rendered HTML.

Validate external input and imported data.

Use explicit error handling for asynchronous operations.

Do not silently swallow errors.

Avoid unnecessary nested conditionals and excessively complicated regular expressions.

Comments should explain non-obvious reasoning, security assumptions, synchronization behavior, and browser limitations.

Do not add comments that merely repeat what the code already says.

8. Dependency and Library Policy

Choose the smallest practical set of maintained libraries.

Possible dependencies include:

- "idb" for IndexedDB ergonomics
- Highlight.js or Prism.js for syntax highlighting
- A maintained Markdown parser
- A maintained HTML sanitizer such as DOMPurify
- Supabase JavaScript client
- A lightweight ZIP library if ZIP export is implemented
- A lightweight test runner for development tests

These are options, not an instruction to install every library.

Select one primary syntax-highlighting library and one primary Markdown parser unless a concrete requirement justifies alternatives.

Pin versions.

Avoid loading libraries from arbitrary CDNs at runtime.

Prefer locally bundled or version-pinned assets with appropriate integrity and fallback strategies.

Document third-party licenses.

Do not write a custom Markdown parser or sanitizer when a suitable maintained library can safely handle the task.

9. UI Components and Accessibility

Use consistent custom components for:

- Dialogs
- Toasts
- Progress
- Dropdowns
- Tooltips
- Search
- Navigation
- Command palette
- Loading skeletons
- Empty states
- Error states
- Status messages

Do not create controls that only look functional.

Every visible action must work or be clearly disabled with an explanation.

Dialogs must support appropriate focus management, Escape handling, and focus restoration.

Avoid excessive toast notifications.

Use inline errors for form validation.

Use confirmation dialogs for destructive operations.

Show meaningful progress only when it can be measured.

Support keyboard navigation and visible focus indicators.

Use ARIA attributes where necessary, not as a substitute for semantic HTML.

10. Data Access and IndexedDB

UI components must not directly implement database persistence.

Use repositories or a clearly defined data access layer.

Treat IndexedDB as the authoritative local store for offline-first user data.

Use stable identifiers.

Handle schema upgrades through versioned migrations.

Use transactions where multiple local changes must succeed together.

Keep database operations recoverable.

Never assume local storage or browser cache is a reliable substitute for a proper database.

Use localStorage only for small, non-sensitive preferences or simple bootstrap values when appropriate.

Do not store large files or complete note libraries in localStorage.

11. Supabase and Database Security

Use the Supabase publishable key in the frontend where appropriate.

Never expose:

- Supabase service-role keys
- Secret API keys
- Shared Groq production credentials
- Private signing credentials

Enable Row Level Security on every user-owned table.

Write and test ownership policies for SELECT, INSERT, UPDATE, and DELETE as appropriate.

Use authenticated user identity as the ownership boundary.

Never trust a client-provided user ID without server-side policy enforcement.

Use explicit foreign-key constraints and deliberate deletion behavior.

Do not rely on hiding records in the UI for security.

Keep SQL migrations in version control.

Do not change production schema assumptions without updating migrations and documentation.

Treat Storage as private by default.

Validate file access policies and ownership independently of frontend checks.

OAuth providers require external configuration. Never simulate successful authentication when credentials or redirect URLs are missing.

12. Local-First Synchronization

Local writes must not depend on an immediate successful cloud request.

Persist local changes and their synchronization metadata reliably.

Use a persistent queue with stable operation IDs.

Synchronization operations must be idempotent.

Avoid processing the same queue item concurrently.

Classify errors as retryable or permanent.

Use bounded exponential backoff with jitter.

Provide manual retry for failed operations.

Do not assume "navigator.onLine" guarantees API availability.

Do not silently discard queued operations.

Do not clear a queue item until its operation is acknowledged or safely reconciled.

Handle offline deletions explicitly.

Never use timestamps alone as a complete conflict-resolution mechanism.

Use revision or base-version tracking.

If concurrent edits conflict, preserve the relevant versions and offer an explicit resolution process.

Do not automatically overwrite newer remote content with stale local data.

Document how the sync engine recovers after refresh, browser restart, authentication changes, and network failure.

13. AI Integration

AI is optional.

Core note management must work without an AI key or network access.

Use configurable Groq model IDs.

Do not assume a model will always remain available or have unchanged limits.

Handle authentication errors, invalid models, rate limits, timeouts, network failures, and empty responses.

Never hard-code a real API key.

In personal BYOK mode, clearly explain that browser-side keys are not fully protected from users who can access the application environment.

For shared production credentials, use an authenticated server-side proxy such as a Supabase Edge Function with server-side secrets and abuse protection.

Do not claim that a frontend-only application can securely hide a shared API key.

Do not send the entire library to AI by default.

Send only relevant, user-selected context.

AI output is untrusted content.

Render Markdown safely, disable raw HTML by default, and sanitize any intentionally rendered HTML.

Never automatically replace existing notes with AI-generated content.

Require explicit user confirmation before applying suggested changes.

14. Import, Export, and Recovery

Validate imported JSON before writing records.

Use a versioned backup format.

Handle duplicate IDs, malformed records, missing fields, unsupported versions, and oversized files.

Show a preview before import.

Provide explicit merge and replace behavior.

Require confirmation before replacing existing data.

Use transactions or staging so failed imports do not leave partially corrupted data.

Preserve existing records when validation fails.

Do not automatically upload local files to cloud storage.

Make backup and restore understandable to non-expert users.

15. Loading, Errors, and Status

Every asynchronous workflow must communicate its state.

Use consistent states such as:

- Idle
- Loading
- Saving locally
- Sync pending
- Syncing
- Synced
- Retry required
- Error

Provide understandable error messages and recovery actions.

Avoid infinite spinners.

Do not show fabricated progress percentages.

Do not mark a record as synchronized before its remote operation is confirmed.

Never claim a request succeeded before receiving a successful result.

Do not hide failures in the console alone.

Keep logs free of API keys, authentication tokens, and unnecessary private content.

16. Offline and Static Hosting

The app must remain useful offline after its assets and data have been cached or stored.

Use a service worker when deployed in a compatible environment.

Cache the application shell and approved static dependencies.

Do not cache private API responses indiscriminately.

Keep local data independent of service-worker cache eviction.

Do not assume file:// supports ES modules, OAuth, or service workers consistently.

Document the limitations of opening the HTML file directly.

Static HTTPS hosting is the primary deployment target.

Do not make a local server mandatory merely to avoid implementing a proper static deployment.

17. Testing and Verification

Test important behaviors rather than only visual appearance.

At minimum, verify:

- Local CRUD
- Persistence after reload
- Search and filtering
- Autosave
- Code copying
- Import/export
- Theme and preference persistence
- Offline operation
- Queue persistence
- Retry behavior
- Conflict detection
- Authentication and session handling
- RLS ownership boundaries
- Storage policies
- AI failure handling
- Keyboard navigation
- Responsive layouts

Use development-only testing tools when useful.

Do not require a permanent test server for normal app use.

Never report tests as passing unless they were actually executed.

Document tests that cannot be completed without external credentials.

18. Comments and Documentation

Write comments for:

- Non-obvious algorithms
- Database migrations
- Sync and conflict-resolution logic
- Security-sensitive decisions
- Browser-specific limitations
- Complex error recovery
- Unusual architectural trade-offs

Use concise, accurate comments.

Keep README instructions synchronized with the actual implementation.

Explain where to configure Supabase, OAuth providers, Storage policies, and Groq.

Document mandatory versus optional setup.

Do not leave misleading TODO comments describing unfinished features as complete.

19. Git and Configuration

Do not commit real credentials, private API keys, user data, or exported backups.

Keep ".gitignore" updated.

Provide ".env.example" with placeholders only where applicable.

Remember that static frontend environment values are public after deployment.

Never assume an environment-variable placeholder protects a secret if its value is embedded in frontend JavaScript.

Use separate configuration for development and production when needed.

Do not overwrite existing project files without inspecting their contents.

20. Change Management

Before changing code:

1. Inspect relevant files.
2. Understand the current implementation.
3. Identify dependent modules.
4. Make the smallest coherent change.
5. Verify affected behavior.
6. Update tests and documentation where needed.

Avoid unrelated rewrites.

Do not remove working features without a clear reason.

Do not introduce speculative abstractions or unnecessary dependencies.

When a requirement is technically impossible under the current deployment model, explain the limitation and implement the closest reliable alternative.

21. Definition of Done

A feature is complete only when:

- Its behavior is implemented.
- Its UI states are complete.
- Errors are handled.
- Data remains consistent.
- Relevant security boundaries are enforced.
- Keyboard and responsive behavior are considered.
- Tests or a documented manual verification procedure exist.
- The documentation reflects actual behavior.

Prioritize a small number of fully working, reliable features over a large collection of incomplete features.

Always preserve user data and explain meaningful trade-offs.