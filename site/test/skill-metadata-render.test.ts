import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadCatalog } from '../src/lib/catalog.ts';
import {
  formatChangelogDate,
  loadSkillChangelog,
} from '../src/lib/enrichment.ts';
import { SUPPORTED_LOCALES, t } from '../src/i18n/index.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(siteRoot, '..');
const distRoot = path.join(siteRoot, 'dist');
const distExists = fs.existsSync(path.join(distRoot, 'pagefind', 'pagefind.js'));

function source(name: string): string {
  return fs.readFileSync(
    path.join(siteRoot, 'src', 'components', 'pages', name),
    'utf8',
  );
}

function componentSource(name: string): string {
  return fs.readFileSync(
    path.join(siteRoot, 'src', 'components', name),
    'utf8',
  );
}

function htmlPath(locale: string, ...segments: string[]): string {
  return path.join(distRoot, locale, ...segments, 'index.html');
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function containingElement(
  html: string,
  identity: string,
  openingTag: string,
  closingTag: string,
): string {
  const identityIndex = html.indexOf(identity);
  assert.ok(identityIndex >= 0, `missing ${identity}`);
  const start = html.lastIndexOf(openingTag, identityIndex);
  const end = html.indexOf(closingTag, identityIndex);
  assert.ok(start >= 0 && end >= 0, `could not isolate ${identity}`);
  return html.slice(start, end + closingTag.length);
}

test('detail, card, and source templates share one latest-change renderer and skip restricted fixtures', () => {
  const home = source('HomePage.astro');
  const detail = source('SkillPage.astro');
  const sourcePage = source('SourcePage.astro');
  const component = componentSource('LatestIncludedChange.astro');

  for (const template of [home, detail, sourcePage]) {
    assert.match(template, /LatestIncludedChange/);
    assert.match(template, /loadSkillChangelog/);
    assert.match(
      template,
      /!skill\.isRestricted/,
      'restricted fixtures must not load or render upstream metadata',
    );
  }
  assert.match(component, /data-latest-included-change=\{value\.reason\}/);
  assert.match(component, /data-pagefind-ignore/);
  assert.match(component, /<time[\s\S]*datetime=\{value\.date\}/);
  assert.match(component, /class="visually-hidden"/);
  assert.match(component, /latestIncludedChangeClarification/);
  assert.match(component, /aria-describedby=\{descriptionId\}/);
  assert.doesNotMatch(
    component,
    /<\/time>\s*<span class="visually-hidden">[\s\S]*latestIncludedChangeClarification/,
    'repeated metadata must not inject the same clarification into every link or table cell',
  );
  for (const template of [home, detail, sourcePage]) {
    assert.equal(
      (template.match(/id="latest-included-change-description"/g) ?? []).length,
      1,
      'each page must expose one shared screen-reader clarification',
    );
    assert.match(
      template,
      /id="latest-included-change-description" class="visually-hidden" data-pagefind-ignore/,
      'the shared clarification must stay outside Pagefind ranking terms',
    );
    assert.match(template, /descriptionId="latest-included-change-description"/);
  }
  assert.match(component, /noVerifiedUpstreamHistory/);
  assert.match(component, /upstreamChangeMetadataUnavailable/);
  assert.equal((home.match(/id="skill-grid"/g) ?? []).length, 1);
  assert.doesNotMatch(home, /search-result-item/);
});

test('latest-change and disclosure controls have visible normal and forced-colors focus treatment', () => {
  const css = fs.readFileSync(
    path.join(siteRoot, 'src', 'styles', 'global.css'),
    'utf8',
  );
  assert.match(css, /\.upstream-changes\s*>\s*summary:focus-visible\s*\{[^}]*outline:/);
  const forcedColors = css.slice(css.indexOf('@media (forced-colors: active)'));
  assert.match(forcedColors, /\.upstream-changes\s*>\s*summary:focus-visible/);
});

test('all active non-restricted skills render honest metadata on every localized surface', {
  skip: !distExists && 'dist/ not found (run npm run build first)',
}, async () => {
  const catalog = await loadCatalog(repoRoot);
  const skills = catalog.skills.filter(
    (skill) => !skill.isTombstone && !skill.isRestricted,
  );

  for (const locale of SUPPORTED_LOCALES) {
    const expected = new Map(
      (await Promise.all(skills.map(async (skill) => [
        skill.path,
        await loadSkillChangelog({
          repoRoot,
          skill: skill.lockEntry,
          locale,
        }),
      ] as const))),
    );
    const home = fs.readFileSync(htmlPath(locale), 'utf8');
    const homeMarkers = home.match(/data-latest-included-change=/g) ?? [];
    assert.equal(homeMarkers.length, skills.length, `${locale} card metadata count`);

    const sourcePages = new Map<string, string>();
    let sourceMetadataCount = 0;
    for (const sourceName of catalog.sources) {
      const page = htmlPath(locale, 'sources', sourceName);
      if (!fs.existsSync(page)) continue;
      const rendered = fs.readFileSync(page, 'utf8');
      sourcePages.set(sourceName, rendered);
      sourceMetadataCount += (rendered.match(/data-latest-included-change=/g) ?? []).length;
    }
    assert.equal(sourceMetadataCount, skills.length, `${locale} source metadata count`);

    for (const skill of skills) {
      const view = expected.get(skill.path);
      assert.ok(view);
      const detailUrl = `/Skills/${locale}/skills/${skill.source}/${skill.slug}/`;
      const card = containingElement(
        home,
        `data-url="${detailUrl}"`,
        '<article',
        '</article>',
      );
      const sourceRow = containingElement(
        sourcePages.get(skill.source)!,
        `href="${detailUrl}"`,
        '<tr',
        '</tr>',
      );
      const detail = fs.readFileSync(
        htmlPath(locale, 'skills', skill.source, skill.slug),
        'utf8',
      );
      for (const [surface, rendered] of [
        ['card', card],
        ['source', sourceRow],
        ['detail', detail],
      ] as const) {
        assert.match(
          rendered,
          new RegExp(
            `data-latest-included-change="${view.latestIncludedChange.reason}"`,
          ),
          `${locale} ${surface} reason ${skill.path}`,
        );
      }
      assert.equal(
        (detail.match(/data-latest-included-change=/g) ?? []).length,
        1,
        `${locale} detail metadata ${skill.path}`,
      );

      if (view.latestIncludedChange.date) {
        const date = view.latestIncludedChange.date;
        const renderedTime = new RegExp(
          `<time datetime="${escapeRegex(date)}" ` +
          `title="${escapeRegex(t(locale, 'latestIncludedChangeClarification'))}" ` +
          `aria-describedby="latest-included-change-description">\\s*` +
          `${formatChangelogDate(date)}\\s*</time>`,
        );
        for (const [surface, rendered] of [
          ['card', card],
          ['source', sourceRow],
          ['detail', detail],
        ] as const) {
          assert.match(rendered, renderedTime, `${locale} ${surface} date ${skill.path}`);
        }
      } else {
        const reasonKey = view.latestIncludedChange.reason === 'no-upstream'
          ? 'noVerifiedUpstreamHistory'
          : 'upstreamChangeMetadataUnavailable';
        for (const [surface, rendered] of [
          ['card', card],
          ['source', sourceRow],
          ['detail', detail],
        ] as const) {
          assert.ok(
            rendered.includes(t(locale, reasonKey)),
            `${locale} ${surface} accessible unavailable reason ${skill.path}`,
          );
        }
      }
    }
  }
});
