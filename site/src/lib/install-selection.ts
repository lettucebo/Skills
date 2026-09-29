const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

export interface SelectableSkill {
  name: string;
  isRestricted: boolean;
  isTombstone: boolean;
}

export function getInstallableSkillNames(skills: readonly SelectableSkill[]): string[] {
  return skills
    .filter((skill) => !skill.isRestricted && !skill.isTombstone && SKILL_NAME.test(skill.name))
    .map((skill) => skill.name)
    .sort();
}

export function parseStoredSelection(raw: string | null, allowedNames: readonly string[]): string[] {
  if (raw === null) return [];
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) {
    throw new Error('Invalid stored selection');
  }
  const allowed = new Set(allowedNames);
  return [...new Set(value.filter((name) => SKILL_NAME.test(name) && allowed.has(name)))].sort();
}

export function buildMultiSkillInstallCommand(
  names: readonly string[],
  { owner, repo, version }: { owner: string; repo: string; version: string },
): string | null {
  if (names.some((name) => !SKILL_NAME.test(name))) {
    throw new Error('Invalid skill name');
  }
  const selected = [...new Set(names)].sort();
  if (selected.length === 0) return null;
  return `npx skills add "${owner}/${repo}#v${version}" --full-depth ${selected.map((name) => `--skill ${name}`).join(' ')}`;
}
