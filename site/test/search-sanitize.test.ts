/**
 * Pagefind excerpt sanitization tests.
 *
 * Pagefind builds an excerpt by slicing the RAW indexed page text and wrapping
 * matched words in <mark> — it never escapes the text (see build_excerpt in
 * pagefind.js). Skill bodies legitimately contain HTML-like code samples
 * (<!DOCTYPE html>, <script src=…>, <style>), so injecting the excerpt straight
 * into innerHTML is a live CSS-injection vector and a stored-XSS vector the
 * moment an upstream skill documents an event handler or inline SVG.
 *
 * These tests execute the ACTUAL sanitizer shipped inside Search.astro, which
 * is delimited by sentinel comments so there is exactly one implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const searchAstroPath = path.join(siteRoot, 'src', 'components', 'Search.astro');

const SENTINEL =
  /\/\/ --- sanitize-excerpt:start ---([\s\S]*?)\/\/ --- sanitize-excerpt:end ---/;

function readSearchAstro(): string {
  return fs.readFileSync(searchAstroPath, 'utf8');
}

/**
 * Extracts and instantiates the sanitizer exactly as shipped in Search.astro.
 */
function loadSanitizeExcerpt(): (value: string) => string {
  const match = readSearchAstro().match(SENTINEL);
  assert.ok(
    match,
    'Search.astro must delimit its excerpt sanitizer with "// --- sanitize-excerpt:start/end ---" sentinels',
  );
  const factory = new Function(`${match![1]}\nreturn sanitizeExcerpt;`);
  return factory() as (value: string) => string;
}

/** Strips the allowed <mark> wrappers so the remainder can be tag-checked. */
function withoutMarks(html: string): string {
  return html.replace(/<\/?mark>/g, '');
}

// ─── Dangerous markup in the excerpt ────────────────────────────────

test('S1: sanitizer neutralizes a <style> block (live CSS-injection vector)', () => {
  const sanitize = loadSanitizeExcerpt();
  const out = sanitize('code sample <style>body{display:none}</style> end');

  assert.doesNotMatch(withoutMarks(out), /<style/i, 'no live <style> element may survive');
  assert.match(out, /&lt;style&gt;/, 'the style tag must be rendered as visible text');
  assert.match(out, /body\{display:none\}/, 'excerpt text must still be readable');
});

test('S2: sanitizer neutralizes a <script> tag', () => {
  const sanitize = loadSanitizeExcerpt();
  const out = sanitize('<script src="https://evil.example/x.js"></script>');

  assert.doesNotMatch(withoutMarks(out), /<script/i, 'no live <script> element may survive');
  assert.match(out, /&lt;script/, 'the script tag must be escaped to text');
});

test('S3: sanitizer neutralizes <img onerror> (executes via innerHTML)', () => {
  const sanitize = loadSanitizeExcerpt();
  const out = sanitize('<img src=x onerror="alert(1)">');

  assert.doesNotMatch(withoutMarks(out), /<img/i, 'no live <img> element may survive');
  assert.doesNotMatch(withoutMarks(out), /onerror\s*=\s*"/i, 'no live event-handler attribute may survive');
  assert.match(out, /&lt;img/, 'the img tag must be escaped to text');
});

test('S4: sanitizer neutralizes <svg onload>', () => {
  const sanitize = loadSanitizeExcerpt();
  const out = sanitize('<svg onload=alert(1)></svg>');

  assert.doesNotMatch(withoutMarks(out), /<svg/i, 'no live <svg> element may survive');
  assert.match(out, /&lt;svg/, 'the svg tag must be escaped to text');
});

test('S5: sanitizer escapes ampersands and quotes without decoding entities', () => {
  const sanitize = loadSanitizeExcerpt();
  const out = sanitize('a & b &lt;script&gt; "q" \'s\'');

  assert.match(out, /a &amp; b/, 'bare ampersands must be escaped');
  assert.match(out, /&amp;lt;script&amp;gt;/, 'pre-existing entity text must not be re-interpreted as a tag');
  assert.doesNotMatch(withoutMarks(out), /<script/i, 'entity-obfuscated markup must not become live');
});

test('S6: sanitizer leaves no unescaped angle bracket outside <mark>', () => {
  const sanitize = loadSanitizeExcerpt();
  const out = sanitize('<!DOCTYPE html><html><head><style>x{}</style></head>');

  assert.equal(withoutMarks(out).includes('<'), false, 'no raw "<" may survive sanitization');
  assert.equal(withoutMarks(out).includes('>'), false, 'no raw ">" may survive sanitization');
});

// ─── Pagefind highlighting must survive ─────────────────────────────

test('S7: sanitizer preserves Pagefind <mark> highlighting', () => {
  const sanitize = loadSanitizeExcerpt();
  const out = sanitize('deploy the <mark>azure</mark> skill');

  assert.match(out, /deploy the <mark>azure<\/mark> skill/, '<mark> highlighting must be preserved verbatim');
});

test('S8: sanitizer preserves uppercase <MARK> highlighting', () => {
  const sanitize = loadSanitizeExcerpt();
  const out = sanitize('<MARK>hit</MARK>');

  assert.match(out, /<mark>hit<\/mark>|<MARK>hit<\/MARK>/, 'mark restoration may be case-insensitive');
});

test('S9: sanitizer refuses <mark> with attributes', () => {
  const sanitize = loadSanitizeExcerpt();
  const out = sanitize('<mark onmouseover="alert(1)">hit</mark>');

  assert.doesNotMatch(out, /<mark[^>]+>/i, 'only a bare <mark> tag may be restored');
  assert.doesNotMatch(out, /onmouseover\s*=\s*"/i, 'attributes must never be restored');
  assert.match(out, /&lt;mark onmouseover/, 'the attributed tag must remain visible text');
});

test('S10: sanitizer handles a highlighted dangerous excerpt end to end', () => {
  const sanitize = loadSanitizeExcerpt();
  const out = sanitize('<mark>style</mark> demo: <style onload="alert(1)">a{}</style>');

  assert.match(out, /<mark>style<\/mark>/, 'the highlight must survive');
  assert.equal(withoutMarks(out).includes('<'), false, 'the dangerous markup must be fully escaped');
});

// ─── Wiring: the component must actually use the sanitizer ──────────

test('S11: Search.astro never concatenates a raw excerpt into innerHTML', () => {
  const template = readSearchAstro();

  assert.doesNotMatch(
    template,
    /\+\s*item\.excerpt\s*\+/,
    'raw item.excerpt must never be concatenated into the result HTML',
  );
  assert.match(
    template,
    /sanitizeExcerpt\(\s*item\.excerpt\s*\)/,
    'the excerpt must be routed through sanitizeExcerpt before innerHTML insertion',
  );
});

test('S12: Search.astro still renders every result and keeps the excerpt element', () => {
  const template = readSearchAstro();

  assert.match(template, /data\.map\(/, 'all results must still be mapped into the list');
  assert.match(template, /search-result-excerpt/, 'the excerpt element must be kept');
});

// ─── Built output evidence ──────────────────────────────────────────

const distDir = path.join(siteRoot, 'dist');
const distExists = fs.existsSync(distDir);

test('S13: built index.html ships the sanitizer and no raw excerpt concatenation', {
  skip: !distExists && 'dist/ not found (run npm run build first)',
}, () => {
  const html = fs.readFileSync(path.join(distDir, 'index.html'), 'utf8');

  assert.match(html, /sanitizeExcerpt/, 'the built page must include the excerpt sanitizer');
  assert.doesNotMatch(
    html,
    /\+\s*item\.excerpt\s*\+/,
    'the built page must not concatenate a raw excerpt into innerHTML',
  );
});
