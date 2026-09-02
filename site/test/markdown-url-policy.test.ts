/**
 * Markdown URL policy tests.
 *
 * The Marked renderer already strips raw HTML, but Markdown link and image
 * syntax still produced live `href`/`src` values for `javascript:`, `data:`,
 * `vbscript:`, protocol-relative and entity-obfuscated URLs — and image `alt`
 * text was emitted unescaped. The rendered HTML is injected with `set:html`,
 * so every assertion below inspects the ACTUAL rendered output.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdownBody } from '../src/lib/catalog.ts';
import {
  ALLOWED_URL_SCHEMES,
  escapeHtmlAttribute,
  isSafeUrl,
  normalizeUrlForSchemeCheck,
} from '../src/lib/url-policy.ts';

// ─── Rejected schemes (rendered HTML) ───────────────────────────────

const DANGEROUS_LINKS: [string, string][] = [
  ['javascript', '[x](javascript:alert(1))'],
  ['mixed-case javascript', '[x](JaVaScRiPt:alert(1))'],
  ['vbscript', '[x](vbscript:msgbox(1))'],
  ['data', '[x](data:text/html;base64,PHN2Zy9vbmxvYWQ9YWxlcnQoMSk+)'],
  ['file', '[x](file:///etc/passwd)'],
  ['leading-space javascript', '[x]( javascript:alert(1))'],
  ['angle-bracket javascript', '[x](<javascript:alert(1)>)'],
  ['entity tab in scheme', '[x](java&#9;script:alert(1))'],
  ['hex entity in scheme', '[x](&#x6a;avascript:alert(1))'],
  ['entity colon', '[x](javascript&#58;alert(1))'],
  ['hex entity colon', '[x](javascript&#x3a;alert(1))'],
  ['entity colon without semicolon', '[x](javascript&#58alert(1))'],
  ['autolink', '<javascript:alert(1)>'],
  ['reference-style link', '[x][r]\n\n[r]: javascript:alert(1)'],
  ['protocol-relative', '[x](//evil.example.com/p)'],
];

for (const [label, markdown] of DANGEROUS_LINKS) {
  test(`M1 (${label}): dangerous link renders as text with no anchor`, () => {
    const html = renderMarkdownBody(markdown);

    assert.doesNotMatch(html, /<a\s/i, `a ${label} link must not produce an anchor`);
    assert.doesNotMatch(html, /href=/i, `a ${label} link must not produce an href`);
    assert.match(html, /x|javascript/i, 'the link text must remain visible');
  });
}

const DANGEROUS_IMAGES: [string, string][] = [
  ['javascript', '![alt text](javascript:alert(1))'],
  ['data html', '![alt text](data:text/html;base64,PHN2Zy9vbmxvYWQ9YWxlcnQoMSk+)'],
  ['vbscript', '![alt text](vbscript:msgbox(1))'],
  ['protocol-relative', '![alt text](//evil.example.com/a.png)'],
  ['entity colon', '![alt text](javascript&#58;alert(1))'],
  ['reference-style image', '![alt text][r]\n\n[r]: javascript:alert(1)'],
];

for (const [label, markdown] of DANGEROUS_IMAGES) {
  test(`M2 (${label}): dangerous image renders alt text with no img element`, () => {
    const html = renderMarkdownBody(markdown);

    assert.doesNotMatch(html, /<img/i, `a ${label} image must not produce an img element`);
    assert.doesNotMatch(html, /src=/i, `a ${label} image must not produce a src attribute`);
    assert.match(html, /alt text/, 'the alt text must remain visible');
  });
}

// ─── Attribute escaping ─────────────────────────────────────────────

test('M3: image alt text cannot break out of the alt attribute', () => {
  const html = renderMarkdownBody('!["><script>alert(1)</script>](https://example.com/a.png)');

  assert.doesNotMatch(html, /<script/i, 'alt text must never re-open a script tag');
  assert.match(html, /<img src="https:\/\/example\.com\/a\.png"/, 'the safe image must still render');
  assert.doesNotMatch(html, /alt=""><|alt="[^"]*"[^>]*>[^<]*"/, 'alt must stay inside its quotes');
  assert.match(html, /alt="&quot;&gt;/, 'alt text must be entity-escaped');
});

test('M4: rejected image alt text is escaped, not injected', () => {
  const html = renderMarkdownBody('!["><script>alert(1)</script>](javascript:alert(1))');

  assert.doesNotMatch(html, /<img/i, 'no image element may be produced');
  assert.doesNotMatch(html, /<script/i, 'no script may be produced');
  assert.match(html, /&quot;|&gt;/, 'the alt text must be escaped');
});

test('M5: link title is escaped', () => {
  const html = renderMarkdownBody('[x](https://example.com "a\\"b")');

  assert.match(html, /title="a&quot;b"/, 'titles must be entity-escaped');
});

// ─── Allowed URLs must keep working ─────────────────────────────────

test('M6: https links remain usable', () => {
  const html = renderMarkdownBody('[docs](https://example.com/a/b?x=1)');
  assert.match(html, /<a href="https:\/\/example\.com\/a\/b\?x=1">docs<\/a>/);
});

test('M7: http links remain usable', () => {
  const html = renderMarkdownBody('[docs](http://example.com/)');
  assert.match(html, /<a href="http:\/\/example\.com\/">docs<\/a>/);
});

test('M8: mailto links remain usable', () => {
  const html = renderMarkdownBody('[mail](mailto:someone@example.com)');
  assert.match(html, /<a href="mailto:someone@example\.com">mail<\/a>/);
});

test('M9: relative links remain usable', () => {
  const html = renderMarkdownBody('[notes](./references/notes.md)');
  assert.match(html, /<a href="\.\/references\/notes\.md">notes<\/a>/);
});

test('M10: root-relative links remain usable', () => {
  const html = renderMarkdownBody('[home](/index.html)');
  assert.match(html, /<a href="\/index\.html">home<\/a>/);
});

test('M11: fragment links remain usable', () => {
  const html = renderMarkdownBody('[jump](#section-two)');
  assert.match(html, /<a href="#section-two">jump<\/a>/);
});

test('M12: https autolinks remain usable', () => {
  const html = renderMarkdownBody('<https://example.com/ok>');
  assert.match(html, /<a href="https:\/\/example\.com\/ok">https:\/\/example\.com\/ok<\/a>/);
});

test('M13: safe images keep src, alt and title', () => {
  const html = renderMarkdownBody('![diagram](https://example.com/a.png "Flow")');
  assert.match(html, /<img src="https:\/\/example\.com\/a\.png" alt="diagram" title="Flow">/);
});

test('M14: safe relative images remain usable', () => {
  const html = renderMarkdownBody('![local](./assets/a.png)');
  assert.match(html, /<img src="\.\/assets\/a\.png" alt="local">/);
});

test('M15: ampersands in safe URLs are not double-escaped', () => {
  assert.match(
    renderMarkdownBody('[x](https://example.com/?a=1&b=2)'),
    /href="https:\/\/example\.com\/\?a=1&amp;b=2"/,
    'a bare ampersand must be escaped once',
  );
  assert.match(
    renderMarkdownBody('[x](https://example.com/?a=1&amp;b=2)'),
    /href="https:\/\/example\.com\/\?a=1&amp;b=2"/,
    'an existing entity must not be double-escaped',
  );
});

test('M16: raw HTML is still stripped', () => {
  const html = renderMarkdownBody('# T\n\n<script>alert(1)</script>\n\ntext');
  assert.doesNotMatch(html, /<script/i);
  assert.match(html, /text/);
});

// ─── URL policy helpers ─────────────────────────────────────────────

test('M17: normalizeUrlForSchemeCheck lowercases and strips whitespace, controls and entities', () => {
  assert.equal(normalizeUrlForSchemeCheck(' JaVa\tScRiPt:alert(1)'), 'javascript:alert(1)');
  assert.equal(normalizeUrlForSchemeCheck('java&#9;script:alert(1)'), 'javascript:alert(1)');
  assert.equal(normalizeUrlForSchemeCheck('javascript&#58;alert(1)'), 'javascript:alert(1)');
  assert.equal(normalizeUrlForSchemeCheck('javascript&#x3A;alert(1)'), 'javascript:alert(1)');
  assert.equal(normalizeUrlForSchemeCheck('java\u0000script:x'), 'javascript:x');
});

test('M18: isSafeUrl allows only http, https, mailto, and relative URLs', () => {
  assert.deepEqual([...ALLOWED_URL_SCHEMES].sort(), ['http:', 'https:', 'mailto:']);

  for (const safe of [
    'https://example.com',
    'http://example.com',
    'mailto:a@b.com',
    './a.md',
    '../a.md',
    'a.md',
    '/a.html',
    '#frag',
    '?q=1',
    '',
  ]) {
    assert.equal(isSafeUrl(safe), true, `${safe} must be allowed`);
  }

  for (const unsafe of [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'vbscript:msgbox(1)',
    'data:text/html,x',
    'file:///etc/passwd',
    'ftp://example.com',
    'unknownscheme:whatever',
    '//evil.example.com',
    '\\\\evil.example.com',
  ]) {
    assert.equal(isSafeUrl(unsafe), false, `${unsafe} must be rejected`);
  }
});

test('M19: escapeHtmlAttribute escapes quotes and brackets without double-encoding entities', () => {
  assert.equal(escapeHtmlAttribute('a"b'), 'a&quot;b');
  assert.equal(escapeHtmlAttribute("a'b"), 'a&#39;b');
  assert.equal(escapeHtmlAttribute('a<b>c'), 'a&lt;b&gt;c');
  assert.equal(escapeHtmlAttribute('a&b'), 'a&amp;b');
  assert.equal(escapeHtmlAttribute('a&amp;b'), 'a&amp;b');
});
