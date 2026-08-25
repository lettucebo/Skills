import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { parse, stringify } from 'yaml';

const FRONTMATTER_PATTERN = /^---(\r?\n)([\s\S]*?)(\r?\n)---([ \t]*)(\r?\n|$)/;

/**
 * Derives the globally-unique frontmatter name for a `rename-frontmatter-name`
 * override from the skill's registry path.
 *
 * `skills/claude/mcp-builder` becomes `claude-mcp-builder`, keeping the source
 * collection as a stable prefix so names never collide across collections.
 */
export function computeOverrideName(skillPath) {
  const segments = skillPath.split('/').filter(Boolean);
  const relative = segments[0] === 'skills' ? segments.slice(1) : segments;
  return relative.join('-');
}

/**
 * Rewrites only the YAML frontmatter block of a SKILL.md document.
 *
 * The markdown body below the closing fence is preserved byte-for-byte, and the
 * frontmatter is re-rendered using the document's own line ending (LF or CRLF)
 * so CRLF files stay CRLF. Because the frontmatter object is parsed, mutated,
 * and re-stringified deterministically, applying the same stamps twice yields
 * identical bytes — the transform is idempotent.
 */
export function stampFrontmatter(markdownText, { name, stamps = {} } = {}) {
  const match = markdownText.match(FRONTMATTER_PATTERN);

  if (!match) {
    throw new Error('Missing YAML frontmatter');
  }

  const eol = match[1];
  const yamlBody = match[2];
  const trailing = match[5];
  const body = markdownText.slice(match[0].length);

  const data = parse(yamlBody) ?? {};

  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Frontmatter must be a YAML object');
  }

  if (name !== undefined) {
    data.name = name;
  }

  for (const [key, value] of Object.entries(stamps)) {
    data[key] = value;
  }

  const rendered = stringify(data).replace(/\r?\n/g, eol);

  return `---${eol}${rendered}---${trailing}${body}`;
}

/**
 * Applies the manifest transform for a single staged skill directory.
 *
 * Operates strictly on the staging copy (never the live repo). It stamps the
 * upstream provenance fields onto the top-level SKILL.md and, for
 * `rename-frontmatter-name` overrides, rewrites the frontmatter `name`.
 */
export async function transformStaged({
  skillDir,
  skillPath,
  override,
  upstream,
  source,
  commit,
  version,
}) {
  const skillFilePath = path.join(skillDir, 'SKILL.md');
  const original = await readFile(skillFilePath, 'utf8');

  const name =
    override?.transform === 'rename-frontmatter-name'
      ? computeOverrideName(skillPath)
      : undefined;

  const stamps = {
    'x-source': upstream.repository,
    'x-source-ref': upstream.reference,
    'x-source-path': source,
    'x-source-commit': commit,
    'x-version': version,
  };

  const transformed = stampFrontmatter(original, { name, stamps });

  if (transformed !== original) {
    await writeFile(skillFilePath, transformed);
  }

  return transformed;
}
