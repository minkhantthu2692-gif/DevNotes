import { test, expect } from '@playwright/test';

test.describe('Auth Page', () => {
  test.setTimeout(120000);

  test.beforeEach(async ({ page }) => {
    await page.goto('http://localhost:4173/#/auth');
    // Wait for the app to boot and auth page to render
    await page.waitForSelector('.auth-page__layout', { timeout: 60000 });
    // Wait for the form to be ready
    await page.waitForSelector('.auth-card__title', { timeout: 10000 });
  });

  test('should load auth page with split layout on desktop', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    
    // Check branding panel exists
    const branding = page.locator('.auth-page__branding');
    await expect(branding).toBeVisible();
    
    // Check auth card exists
    const card = page.locator('.auth-page__card');
    await expect(card).toBeVisible();
    
    // Check headline
    await expect(page.locator('.auth-branding__headline')).toHaveText('Better Notes. Bigger Dreams.');
    
    // Check features (now unified strip with 3 items)
    await expect(page.locator('.auth-branding__feature-item')).toHaveCount(3);
  });

  test('should show sign in form by default', async ({ page }) => {
    await expect(page.locator('.auth-card__title')).toHaveText('Welcome back', { timeout: 10000 });
    await expect(page.locator('#auth-email')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#auth-password')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Sign in")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('a.field__link:has-text("Forgot password?")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Create one")')).toBeVisible({ timeout: 10000 });
  });

  test('should switch to create account mode', async ({ page }) => {
    await page.click('button:has-text("Create one")');
    await expect(page.locator('.auth-card__title')).toHaveText('Create your account', { timeout: 10000 });
    await expect(page.locator('#auth-name')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#auth-email')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#auth-password')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('#auth-confirm')).toBeVisible({ timeout: 10000 });
    // Terms agreement is a visible checkbox label (matching the design)
    await expect(page.locator('label.auth-terms:has-text("Terms of Service")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Create account")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Sign in")')).toBeVisible({ timeout: 10000 });
  });

  test('should switch to forgot password mode', async ({ page }) => {
    await page.click('a.field__link:has-text("Forgot password?")');
    await expect(page.locator('.auth-card__title')).toHaveText('Forgot your password?', { timeout: 10000 });
    await expect(page.locator('#auth-email')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Send reset link")')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button:has-text("Back to sign in")')).toBeVisible({ timeout: 10000 });
  });

  test('should show password strength indicator on signup', async ({ page }) => {
    await page.click('button:has-text("Create one")');
    await page.waitForSelector('#auth-password', { timeout: 10000 });
    const passwordInput = page.locator('#auth-password');
    await passwordInput.fill('weak');
    // Segmented meter exposes strength via aria-valuetext (no floating label)
    await expect(page.locator('#password-strength')).toHaveAttribute('aria-valuetext', 'Weak', { timeout: 10000 });
    await passwordInput.fill('StrongPass123!');
    await expect(page.locator('#password-strength')).toHaveAttribute('aria-valuetext', 'Strong', { timeout: 10000 });
    // 5 segments, all filled when strong
    await expect(page.locator('#password-strength .auth-strength__seg.is-on')).toHaveCount(5, { timeout: 10000 });
  });

  test('should not leak controls to the page edge (regression: stray eye/weak)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.click('button:has-text("Create one")');
    await page.waitForSelector('#auth-confirm', { timeout: 10000 });

    // Every password toggle must be inside a positioned .auth-input wrapper,
    // so it can never resolve against the viewport and float to the far edge.
    const escapes = await page.evaluate(() => {
      const bad = [];
      for (const el of document.querySelectorAll('.password-toggle, .auth-strength, .auth-input__icon')) {
        const wrapper = el.closest('.auth-input');
        if (el.classList.contains('password-toggle') || el.classList.contains('auth-input__icon')) {
          if (!wrapper) bad.push(el.className + ': no .auth-input ancestor');
        }
        const r = el.getBoundingClientRect();
        // Anything parked within 8px of the right edge of a 1280px viewport,
        // outside the auth card, is the reported bug.
        if (r.right > window.innerWidth - 8) bad.push(el.className + ': near right edge');
      }
      return bad;
    });
    expect(escapes).toEqual([]);

    // No "weak"/strength text drawn outside the meter
    const stray = await page.evaluate(() => {
      const meter = document.getElementById('password-strength');
      const texts = [];
      for (const el of document.querySelectorAll('body *')) {
        if (!el.children.length && /^(weak|strong|fair)$/i.test(el.textContent.trim()) && !meter.contains(el)) {
          texts.push(el.className || el.tagName);
        }
      }
      return texts;
    });
    expect(stray).toEqual([]);
  });

  test('should not scroll the page on desktop viewports', async ({ page }) => {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1280, height: 768 }, { width: 1440, height: 900 }]) {
      await page.setViewportSize(viewport);
      await page.goto('http://localhost:4173/#/auth');
      await page.waitForSelector('.auth-page__layout', { timeout: 60000 });
      const overflow = await page.evaluate(() => ({
        scrollH: document.documentElement.scrollHeight,
        clientH: document.documentElement.clientHeight,
      }));
      expect(overflow.scrollH, `viewport ${viewport.width}x${viewport.height}`).toBeLessThanOrEqual(overflow.clientH);
    }

    // App chrome must be hidden while the auth route is active
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect(page.locator('.topbar')).toBeHidden();
  });

  test('should toggle password visibility', async ({ page }) => {
    const passwordInput = page.locator('#auth-password');
    const toggle = page.locator('.password-toggle').first();
    
    await expect(passwordInput).toHaveAttribute('type', 'password', { timeout: 10000 });
    await toggle.click();
    await expect(passwordInput).toHaveAttribute('type', 'text', { timeout: 10000 });
    await toggle.click();
    await expect(passwordInput).toHaveAttribute('type', 'password', { timeout: 10000 });
  });

  test('should show OAuth buttons when Supabase is configured', async ({ page }) => {
    await expect(page.locator('button[aria-label="Continue with Google"]')).toBeVisible({ timeout: 10000 });
    await expect(page.locator('button[aria-label="Continue with GitHub"]')).toBeVisible({ timeout: 10000 });
  });

  test('should be responsive on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    await page.reload();
    await page.waitForSelector('.auth-page__layout', { timeout: 60000 });
    await page.waitForSelector('.auth-card__title', { timeout: 10000 });
    
    // Branding panel should be hidden on mobile
    await expect(page.locator('.auth-page__branding')).toBeHidden({ timeout: 10000 });
    
    // Auth card should be full width
    await expect(page.locator('.auth-page__card')).toBeVisible({ timeout: 10000 });
  });
});