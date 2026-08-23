import path from 'node:path';

const { posix } = path;
const MANAGED_ROOTS = new Set(['references', 'reference', 'scripts', 'assets']);
const INLINE_LINK_PATTERN = /!?\[[^\]]*]\(([^)\r\n]+)\)/g;

export function collectManagedRelativeLinks(markdownText, options) {
  const sanitizedText = stripCodeExamples(markdownText);
  const matches = [];
  const markdownPath = toPosixPath(options.markdownPath);
  const skillPath = toPosixPath(options.skillPath);
  const markdownDir = posix.dirname(markdownPath);

  for (const match of sanitizedText.matchAll(INLINE_LINK_PATTERN)) {
    const originalTarget = normalizeDestination(match[1]);

    if (!originalTarget || shouldIgnoreDestination(originalTarget)) {
      continue;
    }

    const normalizedTarget = normalizeRelativeDestination(originalTarget);

    if (!normalizedTarget) {
      continue;
    }

    const resolvedPath = toPosixPath(posix.normalize(posix.join(markdownDir, normalizedTarget)));
    const relativeToSkill = posix.relative(skillPath, resolvedPath);

    if (
      relativeToSkill === '' ||
      relativeToSkill.startsWith('../') ||
      relativeToSkill === '..'
    ) {
      continue;
    }

    const relativeSegments = relativeToSkill.split('/');

    if (!MANAGED_ROOTS.has(relativeSegments[0])) {
      continue;
    }

    matches.push({
      markdownPath,
      originalTarget,
      normalizedTarget,
      resolvedPath,
    });
  }

  return matches;
}

function stripCodeExamples(markdownText) {
  return markdownText
    .replace(/```[\s\S]*?```/g, '')
    .replace(/~~~[\s\S]*?~~~/g, '')
    .replace(/`[^`\r\n]*`/g, '');
}

function normalizeDestination(rawTarget) {
  const trimmed = rawTarget.trim();

  if (!trimmed) {
    return '';
  }

  const destinationMatch = trimmed.match(/^(<[^>]+>|[^\s]+)(?:\s+["'][\s\S]*["'])?$/);
  const destination = destinationMatch ? destinationMatch[1] : trimmed;

  if (destination.startsWith('<') && destination.endsWith('>')) {
    return destination.slice(1, -1).trim();
  }

  return destination;
}

function shouldIgnoreDestination(destination) {
  if (destination.startsWith('#')) {
    return true;
  }

  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(destination)) {
    return true;
  }

  const decodedDestination = safeDecode(stripQueryAndFragment(destination));

  return /(\{\{|\}\}|\$\{|<|>)/u.test(destination)
    || /(\{\{|\}\}|\$\{|<|>)/u.test(decodedDestination);
}

function normalizeRelativeDestination(destination) {
  const decodedDestination = safeDecode(stripQueryAndFragment(destination));
  const normalizedDestination = toPosixPath(decodedDestination)
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');

  if (!normalizedDestination || normalizedDestination.startsWith('/')) {
    return '';
  }

  return normalizedDestination;
}

function stripQueryAndFragment(destination) {
  const hashIndex = destination.indexOf('#');
  const queryIndex = destination.indexOf('?');
  const cutIndex = [hashIndex, queryIndex]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  return cutIndex === undefined ? destination : destination.slice(0, cutIndex);
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function toPosixPath(value) {
  return value.replace(/\\/g, '/');
}
