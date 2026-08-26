import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const docsRoot = path.join(repoRoot, 'docs');
const locales = ['en', 'zh-TW'];
const expectedPages = [
  'README.md',
  'architecture.md',
  'configuration.md',
  'contributing.md',
  'installation.md',
  'skill-management.md',
  'sync-and-releases.md',
  'troubleshooting.md',
  'usage.md',
  'website.md',
];

function localizedPath(locale, page) {
  return path.join(docsRoot, locale, page);
}

async function readRequired(file, message) {
  assert.ok(existsSync(file), message);
  return readFile(file, 'utf8');
}

function removeGeneratedBlocks(readme) {
  return readme
    .replace(/<!-- CATALOG:START -->[\s\S]*?<!-- CATALOG:END -->/g, '')
    .replace(/<!-- INSTALL:START -->[\s\S]*?<!-- INSTALL:END -->/g, '');
}

function linesOutsideFences(markdown) {
  const visibleLines = [];
  let fence = null;

  for (const line of markdown.split(/\r?\n/)) {
    const match = /^\s*(`{3,}|~{3,})/.exec(line);

    if (match) {
      const marker = match[1];
      if (fence === null) {
        fence = { character: marker[0], length: marker.length };
      } else if (
        marker[0] === fence.character &&
        marker.length >= fence.length
      ) {
        fence = null;
      }
      visibleLines.push('');
      continue;
    }

    visibleLines.push(fence === null ? line : '');
  }

  return visibleLines;
}

function markdownLinks(markdown) {
  const links = [];
  const pattern = /(!?)\[[^\]]*]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  const visibleMarkdown = linesOutsideFences(markdown).join('\n');

  for (const match of visibleMarkdown.matchAll(pattern)) {
    if (match[1] === '!') continue;
    links.push(match[2].replace(/^<|>$/g, ''));
  }

  return links;
}

// Returns the slice of a document between its H1 title and the first H2 (or
// end of document if there is no H2). This is the page "header area" where a
// language-switch line is expected to live, as opposed to anywhere later in
// the body (for example inside a "See also" section that happens to link to
// the same two locale files).
function getHeaderRegion(markdown) {
  const lines = linesOutsideFences(markdown);
  const h1Index = lines.findIndex((line) => /^#\s+/.test(line));
  if (h1Index === -1) return '';

  let h2Index = lines.length;
  for (let i = h1Index + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      h2Index = i;
      break;
    }
  }

  return lines.slice(h1Index + 1, h2Index).join('\n');
}

// Deterministic GitHub-style heading slugger: strips common inline Markdown
// (images, links, inline code, emphasis), strips punctuation (ASCII and
// full-width/CJK) while keeping Unicode letters/numbers/underscore/hyphen,
// lowercases, and collapses whitespace to hyphens.
function slugifyHeadingText(rawText) {
  let text = rawText;
  text = text.replace(/!\[[^\]]*]\([^)]*\)/g, ''); // images: drop entirely
  text = text.replace(/\[([^\]]*)]\([^)]*\)/g, '$1'); // links: keep text
  text = text.replace(/`([^`]*)`/g, '$1'); // inline code: keep content
  text = text.replace(/\*\*([^*]*)\*\*/g, '$1'); // bold
  text = text.replace(/\*([^*]*)\*/g, '$1'); // italics (asterisk form)
  text = text.replace(/__([^_]*)__/g, '$1'); // bold (underscore form)
  text = text.replace(/_([^_]*)_/g, '$1'); // italics (underscore form)
  text = text.toLowerCase();
  // Strip punctuation (ASCII and full-width/CJK), keep letters, numbers,
  // underscore, hyphen, and whitespace (which is collapsed below).
  text = text.replace(/[^\p{L}\p{N}_\-\s]/gu, '');
  text = text.trim();
  text = text.replace(/\s/g, '-');
  return text;
}

// Walks a Markdown document's ATX headings (# .. ######) outside fenced code
// blocks and returns their GitHub-style slugs in document order, applying
// GitHub's duplicate-heading suffix rule (-1, -2, ... on repeats).
function collectHeadingSlugs(markdown) {
  const lines = linesOutsideFences(markdown);
  const counts = new Map();
  const slugs = [];

  for (const line of lines) {
    const match = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!match) continue;

    const slugBase = slugifyHeadingText(match[2].trim());
    const seenCount = counts.get(slugBase) ?? 0;
    counts.set(slugBase, seenCount + 1);
    slugs.push(seenCount === 0 ? slugBase : `${slugBase}-${seenCount}`);
  }

  return slugs;
}

test('HEADER-REGION helper: locates content between the H1 title and the first H2', () => {
  const wellFormed = [
    '# Sample Page',
    '',
    '[English](../en/sample.md) | [繁體中文](../zh-TW/sample.md) | [Documentation home](README.md)',
    '',
    '## First section',
    '',
    'Body text mentioning [English](../en/sample.md) again later in the page.',
  ].join('\n');

  const region = getHeaderRegion(wellFormed);
  assert.match(region, /\[English]\(\.\.\/en\/sample\.md\)/);
  assert.doesNotMatch(region, /Body text mentioning/);
});

test('HEADER-REGION helper: rejects a language-switch line that appears after the first H2', () => {
  const misplaced = [
    '# Sample Page',
    '',
    '## First section',
    '',
    'Body text.',
    '',
    '[English](../en/sample.md) | [繁體中文](../zh-TW/sample.md) | [Documentation home](README.md)',
  ].join('\n');

  const region = getHeaderRegion(misplaced);
  assert.doesNotMatch(
    region,
    /\[English]\(\.\.\/en\/sample\.md\)/,
    'a language-switch line placed after the first H2 must not be considered part of the header region',
  );
});

test('HEADER-REGION helper: ignores H2-like text inside fenced code blocks', () => {
  const withFencedHeading = [
    '# Sample Page',
    '',
    '````markdown',
    '## Example heading',
    '```',
    'Nested shorter fence does not close the outer fence.',
    '````',
    '',
    '[English](../en/sample.md) | [繁體中文](../zh-TW/sample.md) | [Documentation home](README.md)',
    '',
    '## First section',
  ].join('\n');

  const region = getHeaderRegion(withFencedHeading);
  assert.match(region, /\[English]\(\.\.\/en\/sample\.md\)/);
});

test('MARKDOWN-LINK helper: ignores links inside fenced examples', () => {
  const markdown = [
    '[Real link](real.md)',
    '',
    '```markdown',
    '[Example only](missing.md)',
    '```',
  ].join('\n');

  assert.deepEqual(markdownLinks(markdown), ['real.md']);
});

test('HEADING-SLUG helper: matches GitHub-style slugs for English and Chinese headings, including duplicates', () => {
  const markdown = [
    '# Doc',
    '',
    '## Why generated outputs cannot be edited independently',
    '## Transaction safety: journal, rollback, crash recovery',
    '## `E2E_PORT`',
    '## `RELEASE_PUBLISHED` is not operator-configured',
    '## 交易安全性：日誌、回溯與當機復原',
    '## 每日與手動 workflow 順序',
    '## 文件 / Documentation',
    '## Repeated heading',
    '## Repeated heading',
  ].join('\n');

  const slugs = collectHeadingSlugs(markdown);

  assert.deepEqual(slugs, [
    'doc',
    'why-generated-outputs-cannot-be-edited-independently',
    'transaction-safety-journal-rollback-crash-recovery',
    'e2e_port',
    'release_published-is-not-operator-configured',
    '交易安全性日誌回溯與當機復原',
    '每日與手動-workflow-順序',
    '文件--documentation',
    'repeated-heading',
    'repeated-heading-1',
  ]);
});

test('DOC1: English and Traditional Chinese trees contain the complete page set', async () => {
  for (const locale of locales) {
    const localeRoot = path.join(docsRoot, locale);
    assert.ok(
      existsSync(localeRoot),
      `missing documentation locale directory: docs/${locale}`,
    );

    const pages = (await readdir(localeRoot, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .sort();

    assert.deepEqual(
      pages,
      expectedPages,
      `docs/${locale} must contain exactly the bilingual documentation page set`,
    );
  }
});

test('DOC2: every localized page links to both languages and its local home in the page header', async () => {
  for (const locale of locales) {
    for (const page of expectedPages) {
      const document = await readRequired(
        localizedPath(locale, page),
        `missing localized page docs/${locale}/${page}`,
      );

      const header = getHeaderRegion(document);
      assert.notEqual(
        header,
        '',
        `docs/${locale}/${page} must have an H1 title before its language-switch line`,
      );

      assert.match(
        header,
        new RegExp(`\\]\\(\\.\\./en/${page.replace(/\./g, '\\.')}\\)`),
        `docs/${locale}/${page} must link to its English counterpart in the page header ` +
          '(between the H1 title and the first H2)',
      );
      assert.match(
        header,
        new RegExp(`\\]\\(\\.\\./zh-TW/${page.replace(/\./g, '\\.')}\\)`),
        `docs/${locale}/${page} must link to its Traditional Chinese counterpart in the ` +
          'page header (between the H1 title and the first H2)',
      );
      const traditionalChineseIndex = header.indexOf('../zh-TW/');
      const englishIndex = header.indexOf('../en/');
      assert.ok(
        traditionalChineseIndex < englishIndex,
        `docs/${locale}/${page} must present Traditional Chinese before English`,
      );

      if (locale === 'en') {
        assert.match(
          header,
          new RegExp(`\\[\\*\\*English\\*\\*]\\(\\.\\./en/${page.replace(/\./g, '\\.')}\\)`),
          `docs/en/${page} must mark its English self-link as current`,
        );
      } else {
        assert.match(
          header,
          new RegExp(`\\[\\*\\*繁體中文\\*\\*]\\(\\.\\./zh-TW/${page.replace(/\./g, '\\.')}\\)`),
          `docs/zh-TW/${page} must mark its Traditional Chinese self-link as current`,
        );
      }
      assert.equal(
        (header.match(/\[\*\*(?:English|繁體中文)\*\*]/g) ?? []).length,
        1,
        `docs/${locale}/${page} must mark exactly one current language`,
      );

      const homeTarget = page === 'README.md' ? '../README.md' : 'README.md';
      assert.ok(
        markdownLinks(header).includes(homeTarget),
        `docs/${locale}/${page} must link to ${
          page === 'README.md' ? 'the bilingual documentation index' : 'its localized home'
        } in the page header`,
      );
    }
  }
});

function isExternalLink(target) {
  return /^(?:https?:|mailto:)/i.test(target);
}

test('DOC3: all relative Markdown links in docs resolve, including fragments', async () => {
  const documents = [path.join(docsRoot, 'README.md')];

  for (const locale of locales) {
    for (const page of expectedPages) {
      documents.push(localizedPath(locale, page));
    }
  }

  const headingSlugCache = new Map();
  async function slugsFor(filePath) {
    if (!headingSlugCache.has(filePath)) {
      const content = await readFile(filePath, 'utf8');
      headingSlugCache.set(filePath, collectHeadingSlugs(content));
    }
    return headingSlugCache.get(filePath);
  }

  for (const documentPath of documents) {
    const relativeDocument = path.relative(repoRoot, documentPath).replace(/\\/g, '/');
    const document = await readRequired(
      documentPath,
      `missing documentation file: ${relativeDocument}`,
    );

    for (const rawTarget of markdownLinks(document)) {
      if (isExternalLink(rawTarget)) continue;

      const hashIndex = rawTarget.indexOf('#');
      const rawPath = hashIndex === -1 ? rawTarget : rawTarget.slice(0, hashIndex);
      const rawFragment = hashIndex === -1 ? null : rawTarget.slice(hashIndex + 1);
      const targetPath = rawPath ? decodeURIComponent(rawPath.split('?', 1)[0]) : '';

      // A same-page anchor (e.g. "#restricted-content") has no path component,
      // so the fragment is validated against the current document itself.
      let resolvedDoc = documentPath;

      if (targetPath) {
        resolvedDoc = path.resolve(path.dirname(documentPath), targetPath);
        assert.ok(
          existsSync(resolvedDoc),
          `${relativeDocument} has a broken relative link: ${rawTarget}`,
        );

        const info = await stat(resolvedDoc);
        assert.ok(
          info.isFile() || info.isDirectory(),
          `${relativeDocument} link target is neither a file nor directory: ${rawTarget}`,
        );
      }

      if (rawFragment === null || rawFragment === '') continue;

      const fragment = decodeURIComponent(rawFragment);
      const isMarkdownFile =
        resolvedDoc.toLowerCase().endsWith('.md') &&
        existsSync(resolvedDoc) &&
        (await stat(resolvedDoc)).isFile();

      if (!isMarkdownFile) continue;

      const slugs = await slugsFor(resolvedDoc);
      const relativeTarget = path.relative(repoRoot, resolvedDoc).replace(/\\/g, '/');
      assert.ok(
        slugs.includes(fragment),
        `${relativeDocument} has a broken fragment "#${fragment}" (target: ` +
          `${relativeTarget}; raw link: ${rawTarget}; available headings: ${slugs.join(', ')})`,
      );
    }
  }
});

test('DOC4: neutral and repository landing pages expose the documentation', async () => {
  const landing = await readRequired(
    path.join(docsRoot, 'README.md'),
    'missing bilingual documentation landing page: docs/README.md',
  );
  const visibleLanding = linesOutsideFences(landing).join('\n');
  assert.match(visibleLanding, /\]\(en\/README\.md\)/, 'docs landing must link to English');
  assert.match(
    visibleLanding,
    /\]\(zh-TW\/README\.md\)/,
    'docs landing must link to Traditional Chinese',
  );
  assert.ok(
    visibleLanding.indexOf('zh-TW/README.md') < visibleLanding.indexOf('en/README.md'),
    'docs landing must present Traditional Chinese before English',
  );

  for (const page of expectedPages) {
    const escapedPage = page.replace(/\./g, '\\.');
    assert.match(
      visibleLanding,
      new RegExp(`\\]\\(zh-TW/${escapedPage}\\)`),
      `docs landing must link to the Traditional Chinese ${page}`,
    );
    assert.match(
      visibleLanding,
      new RegExp(`\\]\\(en/${escapedPage}\\)`),
      `docs landing must link to the English ${page}`,
    );

    const topicRow = visibleLanding
      .split('\n')
      .find(
        (line) =>
          line.includes(`](zh-TW/${page})`) &&
          line.includes(`](en/${page})`),
      );
    assert.ok(topicRow, `docs landing must list both locales for ${page} in one row`);
    assert.ok(
      topicRow.indexOf(`](zh-TW/${page})`) < topicRow.indexOf(`](en/${page})`),
      `docs landing must present Traditional Chinese before English for ${page}`,
    );
  }

  for (const locale of locales) {
    const localizedHome = await readFile(localizedPath(locale, 'README.md'), 'utf8');
    const visibleLocalizedHome = linesOutsideFences(localizedHome).join('\n');
    for (const page of expectedPages.filter((entry) => entry !== 'README.md')) {
      assert.match(
        visibleLocalizedHome,
        new RegExp(`\\]\\(${page.replace(/\./g, '\\.')}\\)`),
        `docs/${locale}/README.md must expose ${page}`,
      );
    }
  }

  const rootReadme = await readFile(path.join(repoRoot, 'README.md'), 'utf8');
  assert.match(
    removeGeneratedBlocks(rootReadme),
    /\[文件 \/ Documentation]\(docs\/README\.md\)/,
    'root README must expose a Traditional-Chinese-first docs link outside generated blocks',
  );
});
