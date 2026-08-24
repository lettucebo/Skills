/**
 * Frontmatter parsing guards.
 *
 * `parseSkillMd` used an ad-hoc `/^description:\s*["']?([\s\S]*?)["']?\s*$/m`
 * regex, which stops at the end of the `description:` LINE. For a YAML block
 * scalar (`>`, `>-`, `|`) that line holds nothing but the indicator, so the
 * rendered card description became the literal string ">" or "|", and six
 * vendored skills shipped that way:
 *
 *   skills/azure/azure-architecture-autopilot   description: >
 *   skills/claude/claude-api                    description: >-
 *   skills/microsoft/entra-agent-id             description: >
 *   skills/microsoft/frontend-design-review     description: >
 *   skills/microsoft/skill-creator              description: |
 *   skills/vscode/code-review                   description: |
 *
 * The site already depends on `yaml`, so the frontmatter is now parsed properly
 * instead of pattern-matched.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findRepoRoot, loadCatalog, loadSkillBody, parseSkillMd } from '../src/lib/catalog.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(path.resolve(__dirname, '..'));

/** YAML scalar indicators that must never leak into rendered output. */
const SCALAR_INDICATORS = new Set(['>', '>-', '>+', '|', '|-', '|+']);

function doc(frontmatter: string, body = '# Title\n\nBody text.\n'): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

test('FM1: folded block scalar (>) becomes a single-line description', () => {
  const { description } = parseSkillMd(
    doc('name: demo\ndescription: >\n  First line of the description\n  continued on the next line.'),
  );

  assert.equal(description, 'First line of the description continued on the next line.');
});

test('FM2: strip-chomped folded scalar (>-) keeps no trailing newline', () => {
  const { description } = parseSkillMd(
    doc('name: demo\ndescription: >-\n  Use when the user asks about X,\n  Y, or Z.'),
  );

  assert.equal(description, 'Use when the user asks about X, Y, or Z.');
});

test('FM3: literal block scalar (|) preserves its own line breaks', () => {
  const { description } = parseSkillMd(
    doc('name: demo\ndescription: |\n  Line one.\n  Line two.'),
  );

  assert.equal(description, 'Line one.\nLine two.');
});

test('FM4: quoted scalars keep colons, hashes and escapes intact', () => {
  assert.equal(
    parseSkillMd(doc('name: demo\ndescription: "Deploy: build, push #1, and \\"verify\\"."')).description,
    'Deploy: build, push #1, and "verify".',
  );

  assert.equal(
    parseSkillMd(doc("name: demo\ndescription: 'It''s a single-quoted value: keep it.'")).description,
    "It's a single-quoted value: keep it.",
  );
});

test('FM5: plain multi-line scalars fold onto one line', () => {
  const { description } = parseSkillMd(
    doc('name: demo\ndescription: A plain scalar that wraps\n  onto a second line.\nname2: x'),
  );

  assert.equal(description, 'A plain scalar that wraps onto a second line.');
});

test('FM6: a missing description yields an empty string, and the body is preserved', () => {
  const parsed = parseSkillMd(doc('name: demo', '# Heading\n\nSome body.\n'));

  assert.equal(parsed.description, '');
  assert.equal(parsed.body, '# Heading\n\nSome body.');
});

test('FM7: malformed frontmatter degrades gracefully instead of throwing', () => {
  const parsed = parseSkillMd(doc('name: demo\n\tdescription: tabbed badly'));

  assert.equal(typeof parsed.description, 'string');
  assert.equal(typeof parsed.body, 'string');
});

test('FM8: no content is dropped when frontmatter is absent', () => {
  const parsed = parseSkillMd('# No frontmatter\n\nJust a body.\n');

  assert.equal(parsed.description, '');
  assert.match(parsed.body, /Just a body\./);
});

test('FM9: every real vendored skill description is meaningful', async () => {
  const catalog = await loadCatalog(repoRoot);
  const offenders: string[] = [];

  for (const skill of catalog.skills) {
    if (skill.isTombstone || skill.isRestricted) continue;

    const skillFile = path.join(repoRoot, ...skill.path.split('/'), 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;

    const body = await loadSkillBody(repoRoot, skill);
    const description = body?.description ?? '';

    if (
      description.trim().length < 10 ||
      SCALAR_INDICATORS.has(description.trim()) ||
      /^[>|][-+]?$/.test(description.trim())
    ) {
      offenders.push(`${skill.path}: ${JSON.stringify(description)}`);
    }
  }

  assert.deepEqual(offenders, [], 'these skills render a placeholder instead of a description');
});

test('FM10: the block-scalar skills specifically parse to real prose', async () => {
  const catalog = await loadCatalog(repoRoot);
  const affected = [
    'skills/azure/azure-architecture-autopilot',
    'skills/claude/claude-api',
    'skills/microsoft/entra-agent-id',
    'skills/microsoft/frontend-design-review',
    'skills/microsoft/skill-creator',
    'skills/vscode/code-review',
  ];

  for (const skillPath of affected) {
    const skill = catalog.skills.find((s) => s.path === skillPath);
    if (!skill) continue;

    const body = await loadSkillBody(repoRoot, skill);
    const description = (body?.description ?? '').trim();

    assert.ok(
      description.length > 20 && !SCALAR_INDICATORS.has(description),
      `${skillPath} description must be prose, got ${JSON.stringify(description)}`,
    );
  }
});
