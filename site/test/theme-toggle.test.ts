/**
 * theme-toggle.test.ts — source-level guarantees for the tri-state theme
 * control (Light / Dark / System) added to Layout.astro.
 *
 * These assertions pin the behaviour that the E2E suite exercises at runtime:
 * a pre-paint inline script that resolves the theme without FOUC, a persisted
 * user choice under the `skills-theme` key, "System" modelled as the ABSENCE
 * of that key, guarded localStorage access, and a progressively-enhanced
 * toggle button hidden when JavaScript is unavailable.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const layoutPath = path.resolve(__dirname, '../src/layouts/Layout.astro');
const source = fs.readFileSync(layoutPath, 'utf-8');

const headMatch = source.match(/<head>([\s\S]*?)<\/head>/);
const head = headMatch ? headMatch[1] : '';

// The pre-paint script is the is:inline block in <head>.
const inlineScriptMatch = head.match(/<script is:inline>([\s\S]*?)<\/script>/);
const inlineScript = inlineScriptMatch ? inlineScriptMatch[1] : '';

// The interactive control lives in a processed (non is:inline) <script> block.
const controlScriptMatch = source.match(/<script>([\s\S]*?)<\/script>/);
const controlScript = controlScriptMatch ? controlScriptMatch[1] : '';

// ─── Pre-paint / no-FOUC ─────────────────────────────────────────────

test('the theme script is is:inline and inside <head> (pre-paint, no FOUC)', () => {
  assert.ok(headMatch, 'Layout.astro must have a <head> block');
  assert.ok(
    /<script is:inline>/.test(head),
    'the theme resolution script must be is:inline and placed in <head> so it runs before first paint',
  );
  assert.ok(inlineScript.length > 0, 'the is:inline script body must be present');
  assert.match(
    inlineScript,
    /setAttribute\(\s*["']data-theme["']/,
    'the pre-paint script must set the data-theme attribute',
  );
});

// ─── Precedence order ────────────────────────────────────────────────

test('precedence is scoutTheme param, then skills-theme localStorage, then prefers-color-scheme', () => {
  const paramIdx = inlineScript.indexOf('scoutTheme');
  const storedIdx = inlineScript.indexOf('getItem');
  const mediaIdx = inlineScript.indexOf('prefers-color-scheme');

  assert.ok(paramIdx > -1, 'the pre-paint script must read the scoutTheme URL param');
  assert.ok(storedIdx > -1, 'the pre-paint script must read a persisted choice from localStorage');
  assert.ok(mediaIdx > -1, 'the pre-paint script must fall back to prefers-color-scheme');

  assert.match(
    inlineScript,
    /localStorage\.getItem\(\s*(?:STORAGE_KEY|["']skills-theme["'])\s*\)/,
    'the persisted choice must be read from the skills-theme localStorage key',
  );

  // param resolves before the stored value, which resolves before the system query.
  assert.ok(
    paramIdx < storedIdx,
    'the scoutTheme param must take precedence over the persisted localStorage choice',
  );
  assert.ok(
    storedIdx < mediaIdx,
    'the persisted localStorage choice must take precedence over the system preference',
  );
});

test('the pre-paint script only accepts the exact values "light" and "dark" from storage', () => {
  assert.match(
    inlineScript,
    /===\s*["']light["']/,
    'stored value must be validated against the literal "light"',
  );
  assert.match(
    inlineScript,
    /===\s*["']dark["']/,
    'stored value must be validated against the literal "dark"',
  );
});

test('the scoutTheme param is validated: only "light"/"dark" may override', () => {
  // The raw param must be validated the same way as storage — an invalid value
  // (e.g. ?scoutTheme=invalid) must NOT become the theme; it must fall through
  // to the persisted/system preference.
  const rawIdx = inlineScript.search(/get\(\s*["']scoutTheme["']\s*\)/);
  assert.ok(rawIdx > -1, 'the pre-paint script must read the scoutTheme param');
  // The param used in resolution must be gated behind a light/dark equality check,
  // not consumed raw.
  assert.match(
    inlineScript,
    /rawParam\s*===\s*["']light["'][\s\S]*?===\s*["']dark["']/,
    'the scoutTheme param must be validated against "light"/"dark" before it can override',
  );
  // Guard against the original bug: the resolution chain must not start with a
  // bare, unvalidated param variable.
  assert.doesNotMatch(
    inlineScript,
    /const\s+theme\s*=\s*new URLSearchParams/,
    'the theme must not be resolved directly from the raw scoutTheme param',
  );
});

// ─── System = absence of the key ─────────────────────────────────────

test('selecting System removes the localStorage key rather than storing "system"', () => {
  assert.match(
    controlScript,
    /removeItem\(\s*(?:STORAGE_KEY|["']skills-theme["'])\s*\)/,
    'System mode must remove the skills-theme key (absence == system)',
  );
  assert.doesNotMatch(
    controlScript,
    /setItem\([^)]*["']system["']/,
    'the literal string "system" must never be persisted to localStorage',
  );
  assert.doesNotMatch(
    inlineScript,
    /setItem\([^)]*["']system["']/,
    'the pre-paint script must never persist the literal "system"',
  );
});

// ─── localStorage guarded by try/catch ───────────────────────────────

test('localStorage access is guarded by try/catch in both scripts', () => {
  // Pre-paint read guard.
  assert.match(
    inlineScript,
    /try\s*\{[\s\S]*localStorage[\s\S]*\}\s*catch/,
    'the pre-paint script must wrap localStorage access in try/catch',
  );
  // Control script read and write guards.
  const tryBlocks = controlScript.match(/try\s*\{[\s\S]*?\}\s*catch/g) ?? [];
  const guardsLocalStorage = tryBlocks.filter((b) => b.includes('localStorage'));
  assert.ok(
    guardsLocalStorage.length >= 2,
    'the control script must guard both the localStorage read and write with try/catch',
  );
});

// ─── Toggle button + progressive enhancement ─────────────────────────

test('the header renders a theme toggle button with an accessible name', () => {
  assert.match(
    source,
    /<button[^>]*id="theme-toggle"/,
    'a #theme-toggle button must exist in the header',
  );
  assert.match(
    source,
    /id="theme-toggle"[\s\S]*?aria-label="[^"]+"/,
    'the toggle button must have an aria-label reflecting the current state',
  );
  // Visible, non-colour-only indicator (text label + decorative icon).
  assert.match(source, /data-theme-label/, 'the button must expose a visible text label');
  assert.match(
    source,
    /data-theme-icon[^>]*aria-hidden="true"/,
    'the decorative icon must be hidden from assistive technology',
  );
});

test('the toggle cycles Light -> Dark -> System -> Light', () => {
  assert.match(
    controlScript,
    /light:\s*["']dark["']/,
    'from Light the next choice must be Dark',
  );
  assert.match(
    controlScript,
    /dark:\s*["']system["']/,
    'from Dark the next choice must be System',
  );
  assert.match(
    controlScript,
    /system:\s*["']light["']/,
    'from System the next choice must be Light',
  );
});

test('System mode tracks live OS theme changes via a matchMedia change listener', () => {
  assert.match(
    controlScript,
    /matchMedia\(\s*["']\(prefers-color-scheme: dark\)["']\s*\)/,
    'the control script must observe the system colour scheme',
  );
  assert.match(
    controlScript,
    /addEventListener\(\s*["']change["']/,
    'the control script must listen for live OS theme changes',
  );
  // The change handler must only re-apply while in System mode.
  const handler = controlScript.match(/addEventListener\(\s*["']change["'][\s\S]*?\}\s*\)\s*;/);
  assert.ok(handler, 'a matchMedia change handler must exist');
  assert.match(
    handler![0],
    /activeChoice\s*===\s*["']system["']/,
    'the change handler must only re-apply the theme while in System mode (from in-memory state)',
  );
});

test('the control resolves the initial choice as scoutTheme > stored > System', () => {
  // The body control must initialise activeChoice from the SAME precedence
  // resolver as the head script, so a valid ?scoutTheme override drives the
  // initial label/data-choice and click starting point — not just the head's
  // data-theme attribute.
  assert.match(
    controlScript,
    /function readParam\(\)\s*\{[\s\S]*?get\(\s*["']scoutTheme["']\s*\)[\s\S]*?===\s*["']light["'][\s\S]*?===\s*["']dark["'][\s\S]*?\}/,
    'the control must validate the scoutTheme param against "light"/"dark"',
  );
  const initIdx = controlScript.search(/let\s+activeChoice\s*=/);
  const initLine = controlScript.slice(initIdx, initIdx + 120);
  const paramIdx = initLine.indexOf('readParam');
  const storedIdx = initLine.indexOf('readStored');
  const systemIdx = initLine.indexOf('system');
  assert.ok(paramIdx > -1 && storedIdx > -1 && systemIdx > -1, 'all three resolvers must appear');
  assert.ok(
    paramIdx < storedIdx && storedIdx < systemIdx,
    'precedence must be scoutTheme override, then stored, then System',
  );
});

test('the toggle advances an in-memory active choice that survives storage failures', () => {
  assert.match(
    controlScript,
    /let\s+activeChoice\s*=\s*readParam\(\)\s*\|\|\s*readStored\(\)\s*\|\|\s*["']system["']/,
    'the control must keep an in-memory activeChoice resolved as scoutTheme > stored > System',
  );

  const handler = controlScript.match(/addEventListener\(\s*["']click["'][\s\S]*?\}\s*\)\s*;/);
  assert.ok(handler, 'a click handler must exist');
  // The click must mutate activeChoice, then persist it (best-effort) and render.
  assert.match(
    handler![0],
    /activeChoice\s*=\s*NEXT\[\s*activeChoice\s*\]/,
    'the click handler must advance the in-memory activeChoice',
  );
  assert.match(
    handler![0],
    /writeStored\(\s*activeChoice\s*\)/,
    'the click handler must attempt to persist the new choice',
  );
  // render must read the in-memory state, not re-derive from storage.
  const renderFn = controlScript.match(/function render\(\)\s*\{[\s\S]*?\n\s{8}\}/);
  assert.ok(renderFn, 'a render function must exist');
  assert.doesNotMatch(
    renderFn![0],
    /currentChoice\(\)|readStored\(\)/,
    'render must use the in-memory activeChoice, not re-read storage',
  );
});

test('the toggle button is hidden via a <noscript> style block', () => {
  const noscriptContent = source.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? '';
  assert.match(noscriptContent, /<style/, 'noscript must contain a <style> block');
  assert.match(noscriptContent, /\.theme-toggle/, 'noscript style must target .theme-toggle');
  assert.match(
    noscriptContent,
    /display:\s*none\s*!important/,
    'noscript style must hide the toggle with display: none !important',
  );
});
