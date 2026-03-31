/**
 * Convert standard hex color (#RRGGBB) to ASS subtitle color format (&H00BBGGRR&).
 * ASS uses reversed byte order (BGR) with a leading alpha byte.
 */
export function hexToAss(hex: string, alpha = 0): string {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  const r = clean.substring(0, 2);
  const g = clean.substring(2, 4);
  const b = clean.substring(4, 6);
  const a = alpha.toString(16).padStart(2, '0').toUpperCase();
  return `&H${a}${b}${g}${r}&`.toUpperCase();
}

/**
 * Convert ASS color (&HAABBGGRR&) back to hex (#RRGGBB).
 */
export function assToHex(ass: string): string {
  const clean = ass.replace(/&H/i, '').replace(/&$/, '');
  if (clean.length < 6) {
    throw new Error(`Invalid ASS color: ${ass}`);
  }
  const withoutAlpha = clean.length === 8 ? clean.substring(2) : clean;
  const b = withoutAlpha.substring(0, 2);
  const g = withoutAlpha.substring(2, 4);
  const r = withoutAlpha.substring(4, 6);
  return `#${r}${g}${b}`.toUpperCase();
}
