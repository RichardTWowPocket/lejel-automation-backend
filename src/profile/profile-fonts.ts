import * as fs from 'fs';
import * as path from 'path';
import { Logger } from '@nestjs/common';

const logger = new Logger('ProfileFonts');

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.woff', '.woff2']);

/**
 * Scan `public/` subdirectories for font files and build a name -> path lookup.
 * Font name is derived from the filename without extension.
 */
export function buildFontMap(publicDir?: string): Map<string, string> {
  const dir = publicDir ?? path.join(process.cwd(), 'public');
  const map = new Map<string, string>();

  if (!fs.existsSync(dir)) {
    logger.warn(`Font directory not found: ${dir}`);
    return map;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const subdir = path.join(dir, entry.name);
    const files = fs.readdirSync(subdir);
    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!FONT_EXTENSIONS.has(ext)) continue;
      const fontName = path.basename(file, ext);
      const fontPath = path.join(subdir, file);
      map.set(fontName, fontPath);
      map.set(entry.name, fontPath);
    }
  }

  return map;
}

/**
 * Resolve a font name to its absolute file path.
 * Falls back to the name itself if not found (FFmpeg may still find system fonts).
 */
export function resolveFontPath(fontName: string, fontMap?: Map<string, string>): string {
  const map = fontMap ?? buildFontMap();
  return map.get(fontName) ?? fontName;
}
