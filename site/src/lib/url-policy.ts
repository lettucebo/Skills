/**
 * URL policy for Markdown-rendered links and images.
 *
 * Skill bodies are rendered with Marked and injected via `set:html`, so a
 * hostile or compromised upstream `SKILL.md` can reach the DOM through Markdown
 * link/image syntax even though raw HTML is stripped. Only `http:`, `https:`,
 * `mailto:` and relative/fragment URLs are allowed; everything else — including
 * `javascript:`, `data:`, `vbscript:`, unknown schemes and protocol-relative
 * URLs — is rejected.
 *
 * The helpers are pure so the policy is directly unit-testable and reusable.
 */

/** The only explicit URL schemes that may reach an `href` or `src`. */
export const ALLOWED_URL_SCHEMES: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'mailto:',
]);

/** Numeric character references, with or without the closing semicolon. */
const NUMERIC_ENTITY = /&#(x[0-9a-f]{1,6}|\d{1,7});?/gi;

/**
 * Named references a browser also decodes inside attribute values and which
 * can therefore hide a scheme (`java&Tab;script&colon;…`).
 */
const NAMED_ENTITIES: Record<string, string> = {
  '&colon;': ':',
  '&Tab;': '\t',
  '&NewLine;': '\n',
  '&sol;': '/',
  '&bsol;': '\\',
};

const NAMED_ENTITY = /&(?:colon|Tab|NewLine|sol|bsol);/g;

/** ASCII whitespace plus C0/C1-style control characters browsers ignore. */
const ASCII_WHITESPACE_AND_CONTROL = /[\u0000-\u0020\u007f]/g;

/** An explicit scheme, e.g. `https:` or `javascript:`. */
const EXPLICIT_SCHEME = /^[a-z][a-z0-9+.-]*:/;

/**
 * Produces the form a browser would effectively see when resolving the URL:
 * character references decoded, ASCII whitespace and control characters
 * removed, and the result lowercased. Used only for the scheme decision — the
 * original value is what gets escaped and emitted when it is allowed.
 */
export function normalizeUrlForSchemeCheck(raw: string): string {
  const decoded = String(raw ?? '')
    .replace(NAMED_ENTITY, (match) => NAMED_ENTITIES[match] ?? match)
    .replace(NUMERIC_ENTITY, (match, code: string) => {
      const codePoint =
        code[0].toLowerCase() === 'x'
          ? Number.parseInt(code.slice(1), 16)
          : Number.parseInt(code, 10);

      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        return match;
      }

      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    });

  return decoded.replace(ASCII_WHITESPACE_AND_CONTROL, '').toLowerCase();
}

/**
 * Returns true only for URLs that are safe to emit into an `href` or `src`.
 *
 * Relative, root-relative, query-only and fragment-only URLs are allowed;
 * protocol-relative URLs (`//host`, and the backslash variants browsers accept)
 * are not, because they silently escape the site origin.
 */
export function isSafeUrl(raw: string): boolean {
  const normalized = normalizeUrlForSchemeCheck(raw);

  if (normalized.replace(/\\/g, '/').startsWith('//')) {
    return false;
  }

  const scheme = normalized.match(EXPLICIT_SCHEME);

  if (!scheme) {
    return true;
  }

  return ALLOWED_URL_SCHEMES.has(scheme[0]);
}

const ESCAPE_REPLACEMENTS: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes a value for an HTML attribute or text node without double-encoding
 * character references that are already present (matching Marked's own
 * no-encode escaping so existing safe output is unchanged).
 */
const ESCAPE_WITHOUT_DOUBLE_ENCODING =
  /[<>"']|&(?!(?:#\d{1,7}|#[Xx][0-9A-Fa-f]{1,6}|\w+);)/g;

export function escapeHtmlAttribute(value: string): string {
  return String(value ?? '').replace(
    ESCAPE_WITHOUT_DOUBLE_ENCODING,
    (character) => ESCAPE_REPLACEMENTS[character],
  );
}
