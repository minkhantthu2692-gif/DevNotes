/**
 * auth.js — production-quality authentication page.
 *
 * Split-screen layout on desktop, single-column on mobile.
 * Supports Sign In, Create Account, and Forgot Password flows.
 * Uses existing auth-service.js, dialog, toast, and design system.
 */

import { h, clear } from '../utils/dom.js';
import { icon } from '../utils/icons.js';
import { navigate } from '../router.js';
import { bus } from '../utils/bus.js';
import { toast } from '../components/toast.js';
import { openDialog, promptDialog } from '../components/dialog.js';
import { authStore } from '../state.js';
import {
  signIn, signUp, signInWithOAuth, sendPasswordReset, isAuthConfigured,
} from '../services/auth-service.js';
import { SUPABASE } from '../config.js';

const BRAND_SVG = `<svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <rect width="32" height="32" rx="8" fill="currentColor"/>
  <path d="M8 12h16M8 16h12M8 20h8" stroke="white" stroke-width="2.5" stroke-linecap="round"/>
</svg>`;

const FEATURES = [
  {
    icon: 'book',
    title: 'Structured Learning',
    description: 'Step-by-step courses and lessons.',
  },
  {
    icon: 'snippet',
    title: 'Save Your Notes',
    description: 'Markdown, code snippets, and images.',
  },
  {
    icon: 'activity',
    title: 'Track Progress',
    description: 'See your growth and stay motivated.',
  },
];

const ILLUSTRATION_SVG = `<svg viewBox="0 0 440 340" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <!-- decorative dots + arc -->
  <circle cx="150" cy="60" r="3" fill="var(--color-accent)" opacity="0.7"/>
  <circle cx="410" cy="120" r="3" fill="var(--color-accent)" opacity="0.5"/>
  <circle cx="70" cy="230" r="2.5" fill="var(--color-accent)" opacity="0.6"/>
  <path d="M150 78 A120 120 0 0 1 300 60" stroke="var(--color-accent-border)" stroke-width="1.5" stroke-dasharray="4 6" opacity="0.6"/>
  <!-- Code editor window -->
  <rect x="110" y="78" width="250" height="150" rx="12" fill="var(--color-surface-2)" stroke="var(--color-border)"/>
  <rect x="110" y="78" width="250" height="30" rx="12" fill="var(--color-surface-3)" stroke="var(--color-border)"/>
  <rect x="110" y="96" width="250" height="12" fill="var(--color-surface-3)"/>
  <circle cx="128" cy="93" r="4" fill="var(--color-danger)"/>
  <circle cx="144" cy="93" r="4" fill="var(--color-warning)"/>
  <circle cx="160" cy="93" r="4" fill="var(--color-success)"/>
  <!-- code lines -->
  <path d="M130 126h150" stroke="var(--color-text-faint)" stroke-width="2" stroke-linecap="round" opacity="0.5"/>
  <path d="M142 146h120" stroke="var(--color-accent)" stroke-width="3" stroke-linecap="round"/>
  <path d="M142 166h150" stroke="var(--color-text-faint)" stroke-width="2" stroke-linecap="round" opacity="0.4"/>
  <path d="M156 186h96" stroke="var(--color-text-muted)" stroke-width="2" stroke-linecap="round"/>
  <path d="M130 206h130" stroke="var(--color-text-faint)" stroke-width="2" stroke-linecap="round" opacity="0.45"/>
  <!-- Floating </> badge -->
  <rect x="356" y="52" width="60" height="60" rx="14" fill="var(--color-surface-2)" stroke="var(--color-border)"/>
  <path d="M378 72l-8 10 8 10M394 72l8 10-8 10" stroke="var(--color-text)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  <!-- Floating note card (accent) -->
  <rect x="52" y="196" width="64" height="80" rx="10" fill="var(--color-accent-soft)" stroke="var(--color-accent-border)"/>
  <path d="M66 216h36M66 230h36M66 244h24" stroke="var(--color-accent)" stroke-width="2.5" stroke-linecap="round"/>
  <!-- Floating list card -->
  <rect x="352" y="196" width="64" height="64" rx="12" fill="var(--color-surface-2)" stroke="var(--color-border)"/>
  <path d="M366 216h36M366 228h36M366 240h24" stroke="var(--color-text-muted)" stroke-width="2" stroke-linecap="round"/>
</svg>`;

/* Leading/trailing adornments for the auth inputs (static, app-authored markup). */
const MAIL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m3.5 6.5 8.5 6 8.5-6"/></svg>`;
const LOCK_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/></svg>`;
const ARROW_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;

const GOOGLE_SVG = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`;

const GITHUB_SVG = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>`;

export default {
  id: 'auth',
  title: (params) => {
    const mode = params?.mode || 'signin';
    return mode === 'signup' ? 'Create Account' : mode === 'forgot' ? 'Forgot Password' : 'Sign In';
  },
  breadcrumbs: () => [{ label: 'Authentication', path: '/auth' }],

  mount(container, ctx) {
    let disposed = false;
    const root = h('div', { class: 'auth-page' });
    container.appendChild(root);

    // The auth route is a standalone, full-bleed screen: while this attribute
    // is present the shell hides sidebar/topbar so the split layout fills the
    // viewport and desktop needs no page scrolling. destroy() always removes it.
    document.documentElement.setAttribute('data-auth', 'true');

    const offAuth = bus.on('auth:changed', () => { if (!disposed) void render(); });

    let currentMode = ctx.query?.mode || 'signin'; // 'signin' | 'signup' | 'forgot'
    let busy = false;
    let notice = null; // { tone, text }

    // Form state
    const formState = {
      signin: { email: '', password: '', remember: false, errors: {} },
      signup: { name: '', email: '', password: '', confirm: '', acceptTerms: false, errors: {} },
      forgot: { email: '', errors: {}, submitted: false },
    };

    function showNotice(tone, text) {
      notice = { tone, text };
      void render();
    }

    function clearNotice() {
      notice = null;
    }

    function setBusy(next) {
      busy = next;
      void render();
    }

    function validateEmail(email) {
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }

    function validatePassword(password, mode = 'signup') {
      const errors = [];
      if (password.length < 8) errors.push('At least 8 characters');
      if (!/[A-Z]/.test(password)) errors.push('One uppercase letter');
      if (!/[a-z]/.test(password)) errors.push('One lowercase letter');
      if (!/[0-9]/.test(password)) errors.push('One number');
      if (mode === 'signup' && !/[^A-Za-z0-9]/.test(password)) errors.push('One special character');
      return errors;
    }

    function getPasswordStrength(password) {
      let score = 0;
      if (password.length >= 8) score++;
      if (password.length >= 12) score++;
      if (/[A-Z]/.test(password)) score++;
      if (/[a-z]/.test(password)) score++;
      if (/[0-9]/.test(password)) score++;
      if (/[^A-Za-z0-9]/.test(password)) score++;
      // `segments` drives the segmented meter (5 slots, matching the design).
      if (score <= 2) return { level: 'weak', label: 'Weak', color: 'var(--color-danger)', segments: password ? 1 : 0 };
      if (score <= 4) return { level: 'fair', label: 'Fair', color: 'var(--color-warning)', segments: 3 };
      return { level: 'strong', label: 'Strong', color: 'var(--color-success)', segments: 5 };
    }

    /* --- Field builders ------------------------------------------------------
       Every input adornment (leading icon, visibility toggle) lives inside an
       `.auth-input` wrapper. That wrapper is the positioning context: controls
       used to be appended directly to `.field`, which is static, so their
       absolutely-positioned children resolved against the page and escaped to
       the far right edge of the screen. */

    function leadIcon(kind) {
      if (kind === 'user') return h('span', { class: 'auth-input__icon' }, [icon('user')]);
      return h('span', { class: 'auth-input__icon', html: kind === 'mail' ? MAIL_SVG : LOCK_SVG });
    }

    function eyeToggle({ shown, onToggle }) {
      return h('button', {
        type: 'button',
        class: 'password-toggle',
        attrs: { 'aria-label': shown ? 'Hide password' : 'Show password', 'aria-pressed': shown ? 'true' : 'false' },
        on: { click: onToggle },
      }, [icon('eye')]);
    }

    function inputControl({ id, type, autocomplete, placeholder, value, invalid, describedBy, lead, trail, onInput, onBlur }) {
      return h('div', {
        class: 'auth-input' + (lead ? ' auth-input--lead' : '') + (trail ? ' auth-input--trail' : ''),
      }, [
        lead || null,
        h('input', {
          class: 'input', type, id, autocomplete,
          attrs: {
            placeholder,
            'aria-invalid': invalid ? 'true' : 'false',
            ...(describedBy ? { 'aria-describedby': describedBy } : {}),
          },
          value,
          on: { input: onInput, blur: onBlur },
        }),
        trail || null,
      ]);
    }

    // Segmented strength meter. The old implementation floated a "Weak" label
    // with position:absolute against an unpositioned parent, which is what
    // pushed it to the page edge; the label is now exposed through
    // aria-valuetext instead of being drawn outside the meter.
    function strengthMeter(password) {
      const s = getPasswordStrength(password);
      const total = 5;
      const segs = [];
      for (let i = 0; i < total; i += 1) {
        segs.push(h('span', {
          class: 'auth-strength__seg' + (i < s.segments ? ' is-on' : ''),
          style: i < s.segments ? { background: s.color } : null,
        }));
      }
      return h('div', {
        class: 'auth-strength', id: 'password-strength',
        attrs: {
          role: 'progressbar', 'aria-label': 'Password strength',
          'aria-valuemin': '0', 'aria-valuemax': String(total),
          'aria-valuenow': String(s.segments),
          'aria-valuetext': password ? s.label : 'Empty',
        },
      }, [h('div', { class: 'auth-strength__track' }, segs)]);
    }

    async function handleSignIn() {
      const state = formState.signin;
      state.errors = {};
      clearNotice();

      if (!state.email.trim()) state.errors.email = 'Email is required';
      else if (!validateEmail(state.email.trim())) state.errors.email = 'Enter a valid email';

      if (!state.password) state.errors.password = 'Password is required';

      if (Object.keys(state.errors).length) { void render(); return; }

      setBusy(true);
      try {
        await signIn({ email: state.email.trim(), password: state.password });
        toast('Welcome back!', { tone: 'success' });
        navigate('/dashboard', { replace: true });
      } catch (err) {
        showNotice('danger', String(err?.message || err));
      } finally {
        setBusy(false);
      }
    }

    async function handleSignUp() {
      const state = formState.signup;
      state.errors = {};
      clearNotice();

      if (!state.name.trim()) state.errors.name = 'Full name is required';
      else if (state.name.trim().length < 2) state.errors.name = 'Name must be at least 2 characters';

      if (!state.email.trim()) state.errors.email = 'Email is required';
      else if (!validateEmail(state.email.trim())) state.errors.email = 'Enter a valid email';

      const pwdErrors = validatePassword(state.password);
      if (pwdErrors.length) state.errors.password = pwdErrors.join(', ');

      if (state.password !== state.confirm) state.errors.confirm = 'Passwords do not match';

      if (!state.acceptTerms) state.errors.acceptTerms = 'You must accept the Terms and Privacy Policy';

      if (Object.keys(state.errors).length) { void render(); return; }

      setBusy(true);
      try {
        const result = await signUp({
          email: state.email.trim(),
          password: state.password,
          fullName: state.name.trim(),
        });
        if (result.needsConfirmation) {
          currentMode = 'signin';
          formState.signin.email = state.email.trim();
          formState.signin.password = '';
          showNotice('success', 'Account created! Check your email for the confirmation link, then sign in.');
        } else {
          toast('Account created!', { tone: 'success' });
          navigate('/dashboard', { replace: true });
        }
      } catch (err) {
        showNotice('danger', String(err?.message || err));
      } finally {
        setBusy(false);
      }
    }

    async function handleForgot() {
      const state = formState.forgot;
      state.errors = {};
      clearNotice();

      if (!state.email.trim()) state.errors.email = 'Email is required';
      else if (!validateEmail(state.email.trim())) state.errors.email = 'Enter a valid email';

      if (Object.keys(state.errors).length) { void render(); return; }

      setBusy(true);
      try {
        await sendPasswordReset(state.email.trim());
        state.submitted = true;
        showNotice('success', 'If an account exists, a reset link has been sent.');
      } catch (err) {
        showNotice('danger', String(err?.message || err));
      } finally {
        setBusy(false);
      }
    }

    async function handleOAuth(provider) {
      clearNotice();
      setBusy(true);
      try {
        await signInWithOAuth(provider);
        // Browser navigates away; if we return, redirect URL is misconfigured
        showNotice('danger', `${provider} sign-in could not start — the provider redirect URL is not configured in this Supabase project.`);
      } catch (err) {
        showNotice('danger', String(err?.message || err));
      } finally {
        setBusy(false);
      }
    }

    function switchMode(mode) {
      currentMode = mode;
      clearNotice();
      // Update URL without full remount; omit default mode for cleaner URLs
      ctx.setQuery(mode === 'signin' ? { mode: '' } : { mode }, { replace: true });
      void render();
    }

    function renderBrandingPanel() {
      return h('div', { class: 'auth-page__branding' }, [
        h('div', { class: 'auth-branding' }, [
          h('div', { class: 'auth-branding__header' }, [
            h('a', { class: 'auth-branding__logo', href: '/', attrs: { 'aria-label': 'DevNotes home' } }, [
              h('span', { class: 'auth-branding__icon', html: BRAND_SVG }),
              h('span', { class: 'auth-branding__name', text: 'DevNotes' }),
            ]),
          ]),

          // Headline + description beside the illustration
          h('div', { class: 'auth-branding__hero' }, [
            h('div', { class: 'auth-branding__intro' }, [
              h('h1', {
                class: 'auth-branding__headline',
                html: '<span class="auth-branding__headline-line">Better Notes.</span> <span class="auth-branding__headline-line">Bigger <span class="auth-branding__accent">Dreams.</span></span>',
              }),
              h('p', { class: 'auth-branding__description', text: 'Learn programming, organize your notes, and build your future — all in one place.' }),
            ]),
            h('div', { class: 'auth-branding__illustration', html: ILLUSTRATION_SVG }),
          ]),

          // One cohesive feature card with three divided columns
          h('div', { class: 'auth-branding__features', attrs: { role: 'list' } }, FEATURES.map((feature) =>
            h('div', { class: 'auth-branding__feature-item', attrs: { role: 'listitem' } }, [
              h('div', { class: 'auth-branding__feature-icon' }, [icon(feature.icon)]),
              h('div', { class: 'auth-branding__feature-text' }, [
                h('h3', { class: 'auth-branding__feature-title', text: feature.title }),
                h('p', { class: 'auth-branding__feature-description', text: feature.description }),
              ]),
            ])
          )),

          h('p', { class: 'auth-branding__tagline', text: 'Learn. Note. Grow.' }),
        ]),
      ]);
    }

    function renderAuthCard() {
      const isSignIn = currentMode === 'signin';
      const isSignUp = currentMode === 'signup';
      const isForgot = currentMode === 'forgot';
      const state = formState[currentMode];

      const fields = [];

      const emailField = () => h('div', { class: 'field' }, [
        h('label', { class: 'field__label', attrs: { for: 'auth-email' }, text: 'Email address' }),
        inputControl({
          id: 'auth-email', type: 'email', autocomplete: 'email',
          placeholder: 'you@example.com', value: state.email,
          invalid: state.errors.email, lead: leadIcon('mail'),
          onInput: (e) => { state.email = e.target.value; if (state.errors.email) { state.errors.email = ''; void render(); } },
          onBlur: () => { if (state.email && !validateEmail(state.email.trim())) { state.errors.email = 'Enter a valid email'; void render(); } },
        }),
        state.errors.email ? h('div', { class: 'field__error', text: state.errors.email }) : null,
      ]);

      if (isSignIn) {
        fields.push(emailField());

        fields.push(
          h('div', { class: 'field' }, [
            h('div', { class: 'row row--between' }, [
              h('label', { class: 'field__label', attrs: { for: 'auth-password' }, text: 'Password' }),
              h('a', { class: 'field__link', href: '#', text: 'Forgot password?', on: { click: (e) => { e.preventDefault(); switchMode('forgot'); } } }),
            ]),
            inputControl({
              id: 'auth-password', type: state.showPassword ? 'text' : 'password', autocomplete: 'current-password',
              placeholder: '••••••••', value: state.password,
              invalid: state.errors.password, lead: leadIcon('lock'),
              trail: eyeToggle({ shown: !!state.showPassword, onToggle: () => { state.showPassword = !state.showPassword; void render(); } }),
              onInput: (e) => { state.password = e.target.value; if (state.errors.password) { state.errors.password = ''; void render(); } },
            }),
            state.errors.password ? h('div', { class: 'field__error', text: state.errors.password }) : null,
          ])
        );

        fields.push(
          h('div', { class: 'field field--inline row row--between' }, [
            h('label', { class: 'switch' }, [
              h('input', {
                type: 'checkbox', attrs: { id: 'auth-remember' },
                checked: state.remember,
                on: { change: (e) => { state.remember = e.target.checked; } },
              }),
              h('span', { class: 'switch__track' }),
              h('span', { class: 'switch__label', text: 'Remember me' }),
            ]),
          ])
        );
      } else if (isSignUp) {
        fields.push(
          h('div', { class: 'field' }, [
            h('label', { class: 'field__label', attrs: { for: 'auth-name' }, text: 'Full name' }),
            inputControl({
              id: 'auth-name', type: 'text', autocomplete: 'name',
              placeholder: 'Your name', value: state.name,
              invalid: state.errors.name, lead: leadIcon('user'),
              onInput: (e) => { state.name = e.target.value; if (state.errors.name) { state.errors.name = ''; void render(); } },
            }),
            state.errors.name ? h('div', { class: 'field__error', text: state.errors.name }) : null,
          ])
        );

        fields.push(emailField());

        fields.push(
          h('div', { class: 'field' }, [
            h('label', { class: 'field__label', attrs: { for: 'auth-password' }, text: 'Password' }),
            inputControl({
              id: 'auth-password', type: state.showPassword ? 'text' : 'password', autocomplete: 'new-password',
              placeholder: 'Create a password', value: state.password,
              invalid: state.errors.password, describedBy: 'password-hint password-strength',
              lead: leadIcon('lock'),
              trail: eyeToggle({ shown: !!state.showPassword, onToggle: () => { state.showPassword = !state.showPassword; void render(); } }),
              onInput: (e) => {
                state.password = e.target.value;
                if (state.errors.password) { state.errors.password = ''; }
                if (state.confirm && state.password !== state.confirm) { state.errors.confirm = 'Passwords do not match'; }
                else if (state.errors.confirm === 'Passwords do not match') { delete state.errors.confirm; }
                void render();
              },
            }),
            state.errors.password ? h('div', { class: 'field__error', text: state.errors.password }) : null,
            strengthMeter(state.password),
            h('div', { class: 'field__hint', id: 'password-hint', text: 'At least 8 characters, upper, lower, number, and special character.' }),
          ])
        );

        fields.push(
          h('div', { class: 'field' }, [
            h('label', { class: 'field__label', attrs: { for: 'auth-confirm' }, text: 'Confirm password' }),
            // Wrapped in `.auth-input` like every other password field: its eye
            // toggle used to sit directly under `.field` (static), so the
            // absolute button escaped to the page edge instead of the input.
            inputControl({
              id: 'auth-confirm', type: state.showConfirmPassword ? 'text' : 'password', autocomplete: 'new-password',
              placeholder: 'Confirm password', value: state.confirm,
              invalid: state.errors.confirm, lead: leadIcon('lock'),
              trail: eyeToggle({ shown: !!state.showConfirmPassword, onToggle: () => { state.showConfirmPassword = !state.showConfirmPassword; void render(); } }),
              onInput: (e) => {
                state.confirm = e.target.value;
                if (state.password !== state.confirm) { state.errors.confirm = 'Passwords do not match'; }
                else { delete state.errors.confirm; }
                void render();
              },
            }),
            state.errors.confirm ? h('div', { class: 'field__error', text: state.errors.confirm }) : null,
          ])
        );

        fields.push(
          h('div', { class: 'field' }, [
            h('label', { class: 'auth-terms' }, [
              h('input', {
                class: 'checkbox', type: 'checkbox', checked: state.acceptTerms,
                on: { change: (e) => { state.acceptTerms = e.target.checked; if (state.errors.acceptTerms) { delete state.errors.acceptTerms; void render(); } } },
              }),
              h('span', { class: 'auth-terms__text' }, [
                'I agree to the ',
                h('a', { href: '/terms.html', target: '_blank', rel: 'noopener', text: 'Terms of Service' }),
                ' and ',
                h('a', { href: '/privacy.html', target: '_blank', rel: 'noopener', text: 'Privacy Policy' }),
              ]),
            ]),
            state.errors.acceptTerms ? h('div', { class: 'field__error', text: state.errors.acceptTerms }) : null,
          ])
        );
      } else if (isForgot) {
        if (state.submitted) {
          fields.push(
            h('div', { class: 'auth-success' }, [
              h('div', { class: 'auth-success__icon' }, [icon('check')]),
              h('h3', { class: 'auth-success__title', text: 'Check your email' }),
              h('p', { class: 'auth-success__text', text: 'If an account exists for that address, you\'ll receive a password reset link shortly.' }),
              h('button', {
                class: 'btn btn--primary', type: 'button', text: 'Back to sign in',
                on: { click: () => switchMode('signin') },
              }),
            ])
          );
        } else {
          fields.push(
            h('p', { class: 'auth-page__description', text: 'Enter your email address and we\'ll send you instructions to reset your password.' }),
            emailField()
          );
        }
      }

      const submitLabel = isSignIn ? 'Sign in' : isSignUp ? 'Create account' : 'Send reset link';
      const submitAction = isSignIn ? handleSignIn : isSignUp ? handleSignUp : handleForgot;

      const footerLinks = isSignIn
        ? h('p', { class: 'auth-page__footer' }, [
            'Don\'t have an account? ',
            h('button', {
              class: 'btn btn--ghost btn--link', type: 'button', text: 'Create one',
              on: { click: () => switchMode('signup') },
            }),
          ])
        : isSignUp
        ? h('p', { class: 'auth-page__footer' }, [
            'Already have an account? ',
            h('button', {
              class: 'btn btn--ghost btn--link', type: 'button', text: 'Sign in',
              on: { click: () => switchMode('signin') },
            }),
          ])
        : h('p', { class: 'auth-page__footer' }, [
            h('button', {
              class: 'btn btn--ghost btn--link', type: 'button', text: 'Back to sign in',
              on: { click: () => switchMode('signin') },
            }),
          ]);

      return h('div', { class: 'auth-page__card' }, [
        h('div', { class: 'auth-card' }, [
          // Logo
          h('div', { class: 'auth-card__logo' }, [
            h('a', { class: 'auth-branding__logo', href: '/', attrs: { 'aria-label': 'DevNotes home' } }, [
              h('span', { class: 'auth-branding__icon', html: BRAND_SVG }),
              h('span', { class: 'auth-branding__name', text: 'DevNotes' }),
            ]),
          ]),

          // Heading
          h('div', { class: 'auth-card__header' }, [
            h('h1', { class: 'auth-card__title', text: isSignIn ? 'Welcome back' : isSignUp ? 'Create your account' : 'Forgot your password?' }),
            h('p', { class: 'auth-page__description', text: isSignIn ? 'Sign in to your DevNotes account to continue.' : isSignUp ? 'Start your journey with DevNotes.' : '' }),
          ]),

          // Notice
          notice ? h('div', { class: `inline-note inline-note--${notice.tone}`, attrs: { role: 'alert' }, text: notice.text }) : null,

          // Form
          h('form', { class: 'auth-card__form', attrs: { novalidate: '' }, on: { submit: (e) => { e.preventDefault(); submitAction(); } } }, [
            ...fields,
            h('button', {
              class: 'btn btn--primary btn--block btn--lg auth-submit', type: 'submit', disabled: busy,
              text: busy ? (isSignIn ? 'Signing in…' : isSignUp ? 'Creating account…' : 'Sending…') : submitLabel,
            }, [h('span', { class: 'auth-submit__icon', html: ARROW_SVG })]),

            SUPABASE.enabled() && !isForgot ? [
              h('div', { class: 'auth-divider' }, [
                h('span', { text: 'or continue with' }),
              ]),
              h('div', { class: 'auth-social' }, [
                h('button', {
                  class: 'btn btn--social', type: 'button', disabled: busy,
                  attrs: { 'aria-label': 'Continue with Google', title: 'Continue with Google' },
                  on: { click: () => handleOAuth('google') },
                }, [
                  h('span', { class: 'auth-social__icon', html: GOOGLE_SVG }),
                  h('span', { class: 'auth-social__label', text: 'Continue with Google' }),
                ]),
                h('button', {
                  class: 'btn btn--social', type: 'button', disabled: busy,
                  attrs: { 'aria-label': 'Continue with GitHub', title: 'Continue with GitHub' },
                  on: { click: () => handleOAuth('github') },
                }, [
                  h('span', { class: 'auth-social__icon', html: GITHUB_SVG }),
                  h('span', { class: 'auth-social__label', text: 'Continue with GitHub' }),
                ]),
              ]),
            ] : null,

            footerLinks,
          ]),
        ]),
      ]);
    }

    async function render() {
      if (disposed) return;

      const { status } = authStore.get();

      // If already signed in, redirect to dashboard
      if (status === 'signed-in') {
        navigate('/dashboard', { replace: true });
        return;
      }

      // Preserve focus + caret across the full re-render (the strength meter
      // and inline validation refresh on every keystroke, and rebuilding the
      // tree would otherwise drop the user out of the field mid-word).
      const active = document.activeElement;
      const focusId = active && root.contains(active) ? active.id : null;
      const selStart = focusId && active.selectionStart != null ? active.selectionStart : null;
      const selEnd = focusId && active.selectionEnd != null ? active.selectionEnd : null;

      clear(root);

      // Split-screen layout
      root.appendChild(
        h('div', { class: 'auth-page__layout' }, [
          // Left side - Branding (hidden on mobile)
          renderBrandingPanel(),
          // Right side - Auth card
          h('div', { class: 'auth-page__form-wrapper' }, [
            renderAuthCard(),
          ]),
        ])
      );

      if (focusId) {
        const next = root.querySelector(`#${CSS.escape(focusId)}`);
        if (next) {
          next.focus({ preventScroll: true });
          if (selStart != null && typeof next.setSelectionRange === 'function') {
            try { next.setSelectionRange(selStart, selEnd); } catch { /* type without selection support */ }
          }
        }
      }
    }

    // Initial render
    void render();

    return {
      onShow() { void render(); },
      onQuery(query) {
        currentMode = query?.mode || 'signin';
        clearNotice();
        void render();
      },
      destroy() {
        disposed = true;
        offAuth();
        document.documentElement.removeAttribute('data-auth');
      },
    };
  },
};