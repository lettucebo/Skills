import { parse } from 'yaml';

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

export function parseSkillFrontmatter(markdownText, displayPath) {
  const frontmatterMatch = markdownText.match(FRONTMATTER_PATTERN);

  if (!frontmatterMatch) {
    throw new Error(`Missing YAML frontmatter: ${displayPath}`);
  }

  const frontmatter = parse(frontmatterMatch[1]);

  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
    throw new Error(`Frontmatter must be a YAML object: ${displayPath}`);
  }

  return {
    ...frontmatter,
    name: requireNonEmptyString(frontmatter.name, 'name', displayPath),
    description: requireNonEmptyString(
      frontmatter.description,
      'description',
      displayPath,
    ),
  };
}

function requireNonEmptyString(value, fieldName, displayPath) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `Frontmatter field "${fieldName}" must be a non-empty string: ${displayPath}`,
    );
  }

  return value.trim();
}
