export interface ValidationError {
  message: string;
  severity: 'error' | 'warning';
}

const FORBIDDEN_PATTERNS: { regex: RegExp; message: string }[] = [
  {
    regex: /@keyframes\s+/,
    message:
      'CSS @keyframes is forbidden in Remotion. Use useCurrentFrame() + interpolate() instead.',
  },
  {
    regex: /\banimate-\w+/,
    message:
      'Tailwind animation classes (animate-*) are forbidden. Use useCurrentFrame() + spring()/interpolate() instead.',
  },
];

const HTTP_URL_REGEX = /https?:\/\/[^\s"'`)\]]+/g;

const SELF_CLOSING_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

const IMPLICIT_CLOSE_TAGS = new Set([
  'div', 'span', 'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'li', 'td', 'th', 'tr', 'tbody', 'thead', 'option',
]);

export function validateTsx(tsx: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const lines = tsx.split('\n');

  // 1. Forbidden patterns
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.regex.test(tsx)) {
      errors.push({ message: pattern.message, severity: 'error' });
    }
  }

  // 2. Missing remotion import
  const hasRemotionImport = /from\s+['"]remotion['"]/.test(tsx);
  if (!hasRemotionImport) {
    errors.push({
      message:
        'Missing import from "remotion". First line must import used hooks/components (useCurrentFrame, AbsoluteFill, etc.).',
      severity: 'error',
    });
  }

  // 3. Missing export default
  const hasExportDefault = /\bexport\s+default\b/.test(tsx);
  if (!hasExportDefault) {
    errors.push({
      message:
        'Missing "export default" — the composition must have a default export function.',
      severity: 'error',
    });
  }

  // 4. Line count
  if (lines.length > 220) {
    errors.push({
      message: `TSX is ${lines.length} lines (max recommended: 220). Long files risk truncation during bundling ("Expected > but found end of file").`,
      severity: 'warning',
    });
  }

  // 5. Hardcoded HTTP URLs (likely user assets that should use getInputProps)
  const urlMatches = tsx.match(HTTP_URL_REGEX);
  const urls: string[] = urlMatches ?? [];
  const suspiciousUrls = urls.filter(
    (u: string) =>
      !u.includes('iconify') &&
      !u.includes('icon-marker') &&
      !u.includes('unpkg.com') &&
      !u.includes('cdn.jsdelivr') &&
      !u.includes('fonts.googleapis') &&
      !u.includes('fonts.gstatic') &&
      !u.includes('api.mapbox'),
  );
  if (suspiciousUrls.length > 1) {
    errors.push({
      message: `Found ${suspiciousUrls.length} hardcoded HTTP URLs. User-uploaded assets must use getInputProps() to receive presigned URLs, not literal http(s) strings.`,
      severity: 'warning',
    });
  }

  // 6. JSX tag balance (basic heuristic)
  const openTagRegex = /<([A-Za-z][A-Za-z0-9]*)(?:\s[^>]*)?>/g;
  const closeTagRegex = /<\/([A-Za-z][A-Za-z0-9]*)>/g;

  const openTags: string[] = [];
  let match: RegExpExecArray | null;

  const openTagRegexGlobal = new RegExp(openTagRegex.source, 'g');
  while ((match = openTagRegexGlobal.exec(tsx)) !== null) {
    const tagName = match[1];
    if (!SELF_CLOSING_TAGS.has(tagName.toLowerCase())) {
      openTags.push(tagName);
    }
  }

  const closeTagRegexGlobal = new RegExp(closeTagRegex.source, 'g');
  while ((match = closeTagRegexGlobal.exec(tsx)) !== null) {
    const tagName = match[1];
    const idx = openTags.lastIndexOf(tagName);
    if (idx !== -1) {
      openTags.splice(idx, 1);
    }
  }

  // Remaining unclosed tags (excluding implicit-close JSX components)
  const unclosed = openTags.filter(
    (t) => t[0] === t[0].toLowerCase() && !IMPLICIT_CLOSE_TAGS.has(t.toLowerCase()),
  );
  if (unclosed.length > 0) {
    errors.push({
      message: `Possible unclosed JSX tags: <${unclosed.join('>, <')}>. Every JSX tag must be closed (</> or self-closing).`,
      severity: 'warning',
    });
  }

  return errors;
}

export function hasCriticalErrors(errors: ValidationError[]): boolean {
  return errors.some((e) => e.severity === 'error');
}

export function formatValidationErrors(errors: ValidationError[]): string {
  if (errors.length === 0) return '';
  const lines = errors.map(
    (e, i) => `${i + 1}. [${e.severity.toUpperCase()}] ${e.message}`,
  );
  return `TSX validation found ${errors.length} issue(s):\n${lines.join('\n')}`;
}

export const MAX_VALIDATION_RETRIES = 2;
