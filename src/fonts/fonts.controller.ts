import { Controller, Get, UseGuards } from '@nestjs/common';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { ApiKeyOrJwtGuard } from '../auth/api-key-or-jwt.guard';

const FONT_EXT_RE = /\.(ttf|otf|ttc|woff|woff2)$/i;

@Controller('api/fonts')
@UseGuards(ApiKeyOrJwtGuard)
export class FontsController {
  @Get()
  listFonts(): string[] {
    const fonts = new Set<string>();

    const publicDir = path.join(process.cwd(), 'public');
    if (fs.existsSync(publicDir)) {
      const entries = fs.readdirSync(publicDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dirPath = path.join(publicDir, entry.name);
        const files = fs.readdirSync(dirPath);
        if (files.some((f) => FONT_EXT_RE.test(f))) {
          fonts.add(entry.name);
        }
      }
    }

    try {
      const raw = execSync("fc-list --format='%{family[0]}\\n'", {
        timeout: 5000,
        encoding: 'utf-8',
      });
      for (const line of raw.split('\n')) {
        const name = line.trim();
        if (name) fonts.add(name);
      }
    } catch {
      // fontconfig not available; only return public fonts
    }

    return [...fonts].sort((a, b) => a.localeCompare(b));
  }
}
