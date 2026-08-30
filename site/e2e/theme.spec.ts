/**
 * theme.spec.ts — runtime behaviour of the tri-state theme toggle.
 *
 * Verifies the Light / Dark / System cycle, that the choice persists across a
 * reload and across navigation (a site-wide preference), that System mode is
 * represented by the ABSENCE of the localStorage key, and that the control is
 * keyboard operable and hidden without JavaScript.
 *
 * The OS colour scheme is emulated as `dark` so "System" resolves to a dark
 * data-theme, making it distinguishable from an explicit "light" choice.
 */
import { test, expect, type Page } from '@playwright/test';
import { BASE } from './_helpers';

const STATUS = `${BASE}status/`;

interface ToggleState {
  theme: string | null;
  choice: string | null;
  stored: string | null;
  label: string | null;
}

async function readState(page: Page): Promise<ToggleState> {
  return page.evaluate(() => {
    const btn = document.getElementById('theme-toggle');
    let stored: string | null = null;
    try {
      stored = localStorage.getItem('skills-theme');
    } catch (e) {
      stored = null;
    }
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      choice: btn?.getAttribute('data-theme-choice') ?? null,
      stored,
      label: btn?.getAttribute('aria-label') ?? null,
    };
  });
}

test.describe('Theme toggle', () => {
  test.use({ colorScheme: 'dark' });

  test('button is visible with JavaScript enabled', async ({ page }) => {
    await page.goto(BASE);
    const btn = page.locator('#theme-toggle');
    await expect(btn).toHaveCount(1);
    await expect(btn).toBeVisible();
  });

  test('clicking cycles Light -> Dark -> System and updates data-theme', async ({ page }) => {
    await page.goto(BASE);
    const btn = page.locator('#theme-toggle');
    await expect(btn).toBeVisible();

    // Fresh visitor: no stored key, so System is active and resolves to dark.
    let state = await readState(page);
    expect(state.choice, 'a fresh visitor starts in System mode').toBe('system');
    expect(state.stored, 'System mode stores no key').toBeNull();
    expect(state.theme, 'System resolves to the emulated dark OS scheme').toBe('dark');

    // System -> Light
    await btn.click();
    state = await readState(page);
    expect(state.choice).toBe('light');
    expect(state.stored).toBe('light');
    expect(state.theme).toBe('light');
    expect(state.label).toContain('Light');

    // Light -> Dark
    await btn.click();
    state = await readState(page);
    expect(state.choice).toBe('dark');
    expect(state.stored).toBe('dark');
    expect(state.theme).toBe('dark');
    expect(state.label).toContain('Dark');

    // Dark -> System (key removed; resolves to the OS scheme, i.e. dark)
    await btn.click();
    state = await readState(page);
    expect(state.choice).toBe('system');
    expect(state.stored, 'System mode must remove the localStorage key').toBeNull();
    expect(state.theme).toBe('dark');
    expect(state.label).toContain('System');
  });

  test('the chosen theme persists across a page reload', async ({ page }) => {
    await page.goto(BASE);
    const btn = page.locator('#theme-toggle');
    await expect(btn).toBeVisible();

    // System -> Light -> Dark
    await btn.click();
    await btn.click();
    expect((await readState(page)).stored).toBe('dark');

    await page.reload();
    const state = await readState(page);
    expect(state.stored, 'the stored choice must survive a reload').toBe('dark');
    expect(state.choice).toBe('dark');
    expect(state.theme).toBe('dark');
  });

  test('the chosen theme persists across navigation to another page', async ({ page }) => {
    await page.goto(BASE);
    const btn = page.locator('#theme-toggle');
    await expect(btn).toBeVisible();

    // Cycle to an explicit Light choice.
    await btn.click();
    expect((await readState(page)).stored).toBe('light');

    // Navigate to the Status page — the preference must follow (site-wide).
    await page.goto(STATUS);
    await expect(page.locator('#theme-toggle')).toBeVisible();
    const state = await readState(page);
    expect(state.stored, 'the preference must be site-wide').toBe('light');
    expect(state.choice).toBe('light');
    expect(state.theme).toBe('light');
  });

  test('System mode leaves the localStorage key absent', async ({ page }) => {
    await page.goto(BASE);
    const btn = page.locator('#theme-toggle');
    await expect(btn).toBeVisible();

    // System -> Light -> Dark -> System
    await btn.click();
    await btn.click();
    await btn.click();

    const state = await readState(page);
    expect(state.choice).toBe('system');
    expect(state.stored, 'System must be represented by the absence of the key').toBeNull();
  });

  test('the toggle is keyboard operable', async ({ page }) => {
    await page.goto(BASE);
    const btn = page.locator('#theme-toggle');
    await expect(btn).toBeVisible();

    await btn.focus();
    await expect(btn).toBeFocused();

    const before = await readState(page);
    await page.keyboard.press('Enter');
    const afterEnter = await readState(page);
    expect(afterEnter.choice, 'Enter must activate the toggle').not.toBe(before.choice);

    await page.keyboard.press('Space');
    const afterSpace = await readState(page);
    expect(afterSpace.choice, 'Space must activate the toggle').not.toBe(afterEnter.choice);
  });
});

// ── Progressive enhancement ───────────────────────────────────────────

test.describe('Theme toggle — no JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('the toggle button is hidden without JavaScript', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForLoadState('load');

    // The button is server-rendered unconditionally; the <noscript> <style>
    // block is what hides it. Assert existence FIRST so a missing element can
    // never masquerade as "hidden".
    const btn = page.locator('#theme-toggle');
    await expect(btn).toHaveCount(1);
    await expect(btn).toBeHidden();
  });
});

// ── scoutTheme param validation ───────────────────────────────────────

test.describe('scoutTheme param validation', () => {
  test.use({ colorScheme: 'light' });

  test('an invalid ?scoutTheme value falls back to the saved choice', async ({ page }) => {
    // Seed a persisted "dark" choice before the page scripts run.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('skills-theme', 'dark');
      } catch (e) { /* ignore */ }
    });

    await page.goto(`${BASE}?scoutTheme=invalid`);
    await expect(page.locator('#theme-toggle')).toBeVisible();

    const state = await readState(page);
    // Invalid param must not become the theme; the saved "dark" choice wins over
    // the emulated light system scheme.
    expect(state.theme, 'invalid scoutTheme must not override the saved choice').toBe('dark');
    expect(state.choice).toBe('dark');
    expect(state.stored).toBe('dark');
  });

  test('a valid ?scoutTheme value still overrides (behaviour preserved)', async ({ page }) => {
    await page.goto(`${BASE}?scoutTheme=dark`);
    await expect(page.locator('#theme-toggle')).toBeVisible();
    // No saved choice, system is light, but the valid param forces dark.
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
  });
});

test.describe('scoutTheme param validation — no saved choice', () => {
  test.use({ colorScheme: 'dark' });

  test('an invalid ?scoutTheme value falls back to the system preference', async ({ page }) => {
    await page.goto(`${BASE}?scoutTheme=nonsense`);
    await expect(page.locator('#theme-toggle')).toBeVisible();

    const state = await readState(page);
    expect(state.theme, 'invalid scoutTheme must fall back to the system scheme').toBe('dark');
    expect(state.choice).toBe('system');
    expect(state.stored).toBeNull();
  });
});

// ── Valid scoutTheme override drives the control ──────────────────────

test.describe('scoutTheme override — control precedence', () => {
  test.use({ colorScheme: 'dark' });

  test('a valid URL override beats a stored opposite value in label and data-theme', async ({ page }) => {
    // Persist the OPPOSITE choice, then override it via a valid URL param.
    await page.addInitScript(() => {
      try {
        localStorage.setItem('skills-theme', 'dark');
      } catch (e) { /* ignore */ }
    });

    await page.goto(`${BASE}?scoutTheme=light`);
    await expect(page.locator('#theme-toggle')).toBeVisible();

    const state = await readState(page);
    // The rendered theme AND the button state must both reflect the override,
    // not the stored "dark" (regression: rendered light but labelled Dark).
    expect(state.theme, 'valid override must win over stored').toBe('light');
    expect(state.choice).toBe('light');
    expect(state.label).toContain('Theme: Light. Switch to Dark.');
    // Storage is untouched by mere resolution.
    expect(state.stored).toBe('dark');
  });

  test('clicking under an override takes control and advances from the override', async ({ page }) => {
    await page.goto(`${BASE}?scoutTheme=light`);
    const btn = page.locator('#theme-toggle');
    await expect(btn).toBeVisible();

    // Override is Light, so the next click must go Light -> Dark.
    await btn.click();
    const state = await readState(page);
    expect(state.choice, 'click must advance from the override start point').toBe('dark');
    expect(state.theme).toBe('dark');
    expect(state.stored, 'the explicit user action is persisted best-effort').toBe('dark');
  });
});

test.describe('scoutTheme override — media changes do not overwrite it', () => {
  test.use({ colorScheme: 'light' });

  test('live OS changes never overwrite a valid URL override', async ({ page }) => {
    // Override to dark while the emulated system scheme is light.
    await page.goto(`${BASE}?scoutTheme=dark`);
    await expect(page.locator('#theme-toggle')).toBeVisible();

    let state = await readState(page);
    expect(state.theme).toBe('dark');
    expect(state.choice, 'a valid override is an explicit choice, not System').toBe('dark');

    // Toggle the OS scheme back and forth. Because activeChoice is explicit dark,
    // the matchMedia change handler (System-only) must not touch data-theme.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.emulateMedia({ colorScheme: 'light' });

    state = await readState(page);
    expect(state.theme, 'OS changes must not overwrite an explicit URL override').toBe('dark');
    expect(state.choice).toBe('dark');
  });
});

// ── Storage failure resilience ────────────────────────────────────────

test.describe('Theme toggle — localStorage throws', () => {
  test.use({ colorScheme: 'dark' });

  test('the control still cycles Light -> Dark -> System when storage is unavailable', async ({ page }) => {
    // Make every Storage operation throw before any page script runs, emulating
    // privacy modes that expose localStorage but reject access.
    await page.addInitScript(() => {
      const blow = () => {
        throw new Error('storage blocked');
      };
      Object.defineProperty(Storage.prototype, 'getItem', { configurable: true, value: blow });
      Object.defineProperty(Storage.prototype, 'setItem', { configurable: true, value: blow });
      Object.defineProperty(Storage.prototype, 'removeItem', { configurable: true, value: blow });
    });

    await page.goto(BASE);
    const btn = page.locator('#theme-toggle');
    await expect(btn).toBeVisible();

    // Storage read threw, so the in-memory choice starts at System (resolves dark).
    let state = await readState(page);
    expect(state.choice).toBe('system');
    expect(state.theme).toBe('dark');
    expect(state.label).toContain('Theme: System. Switch to Light.');

    // System -> Light: the in-memory state must advance even though setItem throws.
    await btn.click();
    state = await readState(page);
    expect(state.choice, 'must advance past System even when storage throws').toBe('light');
    expect(state.theme).toBe('light');
    expect(state.label).toContain('Theme: Light. Switch to Dark.');

    // Light -> Dark
    await btn.click();
    state = await readState(page);
    expect(state.choice).toBe('dark');
    expect(state.theme).toBe('dark');
    expect(state.label).toContain('Theme: Dark. Switch to System.');

    // Dark -> System (removeItem throws, but in-memory state still returns to System)
    await btn.click();
    state = await readState(page);
    expect(state.choice).toBe('system');
    expect(state.theme).toBe('dark');
    expect(state.label).toContain('Theme: System. Switch to Light.');
  });
});
