import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { execSync } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveDimensions } from './profile-dimensions';
import { RenderProfilePreviewDto } from './dto/render-profile-preview.dto';
import { TextStyleConfigDto } from './dto/create-profile.dto';

@Injectable()
export class ProfilePreviewService {
  private readonly logger = new Logger(ProfilePreviewService.name);

  /**
   * Escape a value that will be placed inside FFmpeg single quotes.
   * Inside single quotes only \\ and \' are special.
   */
  private escQuoted(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, ' ');
  }

  /**
   * Escape text for the drawtext `text=` option (inside single quotes).
   * Same as escQuoted plus %% for literal percent (drawtext expands %{...}).
   */
  private escText(text: string): string {
    return text
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/%/g, '%%')
      .replace(/\n/g, ' ');
  }

  private ffColor(hexOrName: string): string {
    if (/^#[0-9a-fA-F]{6}$/.test(hexOrName)) {
      return `0x${hexOrName.slice(1)}`;
    }
    return hexOrName;
  }

  private getAnchorX(alignment: number): 'left' | 'center' | 'right' {
    if ([1, 4, 7].includes(alignment)) return 'left';
    if ([3, 6, 9].includes(alignment)) return 'right';
    return 'center';
  }

  private getAnchorY(alignment: number): 'top' | 'middle' | 'bottom' {
    if ([7, 8, 9].includes(alignment)) return 'top';
    if ([4, 5, 6].includes(alignment)) return 'middle';
    return 'bottom';
  }

  private exprX(alignment: number, xOffset: number): string {
    const ax = this.getAnchorX(alignment);
    if (ax === 'left') return `20+${xOffset}`;
    if (ax === 'right') return `w-text_w-20+${xOffset}`;
    return `(w-text_w)/2+${xOffset}`;
  }

  private exprY(alignment: number, yOffset: number): string {
    const ay = this.getAnchorY(alignment);
    if (ay === 'top') return `20+${yOffset}`;
    if (ay === 'middle') return `(h-text_h)/2+${yOffset}`;
    return `h-text_h-20-${yOffset}`;
  }

  /**
   * Resolve the font to a file path. Tries:
   * 1. public/<fontName>/ folder (picks best bold/italic match by filename)
   * 2. fc-match system lookup with style hint
   */
  private resolveFontFile(fontName: string, bold: boolean, italic: boolean): string | undefined {
    const publicDir = path.join(process.cwd(), 'public');
    const familyDir = path.join(publicDir, fontName);

    if (fs.existsSync(familyDir) && fs.statSync(familyDir).isDirectory()) {
      const entries = fs
        .readdirSync(familyDir)
        .filter((file) => /\.(ttf|otf|ttc)$/i.test(file))
        .sort((a, b) => a.localeCompare(b));

      if (entries.length > 0) {
        const score = (name: string) => {
          const lower = name.toLowerCase();
          const hasBold = /bold|black|semibold|demibold/.test(lower);
          const hasItalic = /italic|oblique/.test(lower);
          let s = 0;
          if (bold === hasBold) s += 2;
          if (italic === hasItalic) s += 2;
          if (!bold && !italic && /regular/.test(lower)) s += 1;
          return s;
        };
        const best = entries.reduce(
          (acc, cur) => (score(cur) > score(acc) ? cur : acc),
          entries[0],
        );
        return path.join(familyDir, best);
      }
    }

    try {
      const styleHint =
        bold && italic
          ? 'Bold Italic'
          : bold
            ? 'Bold'
            : italic
              ? 'Italic'
              : 'Regular';
      const pattern = `${fontName}:style=${styleHint}`;
      const result = execSync(`fc-match -f '%{file}' '${pattern.replace(/'/g, "'\\''")}'`, {
        timeout: 3000,
        encoding: 'utf-8',
      }).trim();
      if (result && fs.existsSync(result)) {
        return result;
      }
    } catch {
      this.logger.warn(`fc-match failed for font "${fontName}"`);
    }

    return undefined;
  }

  async renderPreview(dto: RenderProfilePreviewDto): Promise<string> {
    const canvas = resolveDimensions(dto.canvas.ratio as any, dto.canvas.resolution as any);
    const content = resolveDimensions(dto.content.ratio as any, dto.content.resolution as any);
    const outFile = path.join(os.tmpdir(), `profile-preview-${Date.now()}.jpg`);

    const contentX = Math.round((canvas.width - content.width) / 2 + dto.content.xOffset);
    const contentY = Math.round((canvas.height - content.height) / 2 + dto.content.yOffset);

    const chain: string[] = [
      `drawbox=x=${contentX}:y=${contentY}:w=${content.width}:h=${content.height}:color=0x2f8f6f@0.8:t=fill`,
    ];

    const topText = dto.topHeadlineText ?? 'Top headline';
    const subText = dto.subtitleText ?? 'Subtitle baseline';
    const botText = dto.bottomHeadlineText ?? 'Bottom headline';

    const pushText = (style: TextStyleConfigDto, text: string) => {
      if (!style.enabled) return;

      const x = this.exprX(style.alignment, style.xOffset);
      const y = this.exprY(style.alignment, style.yOffset);
      const fontFile = this.resolveFontFile(style.font, style.bold, style.italic);

      const parts = [
        `drawtext=text='${this.escText(text)}'`,
        `fontcolor=${this.ffColor(style.fontColor)}`,
        `fontsize=${style.fontSize}`,
        `bordercolor=${this.ffColor(style.outlineColor)}`,
        `borderw=${Math.max(0, style.outlineWidth)}`,
        `x=${x}`,
        `y=${y}`,
      ];

      if (fontFile) {
        parts.push(`fontfile='${this.escQuoted(fontFile)}'`);
        this.logger.debug(`Font "${style.font}" bold=${style.bold} italic=${style.italic} -> ${fontFile}`);
      } else {
        parts.push(`font='${this.escQuoted(style.font)}'`);
        this.logger.warn(`No fontfile found for "${style.font}", using font= fallback`);
      }

      if (style.background) {
        parts.push('box=1');
        parts.push(`boxcolor=${this.ffColor(style.backColor)}@0.75`);
        parts.push('boxborderw=10');
      }

      chain.push(parts.join(':'));
    };

    pushText(dto.headline.top, topText);
    pushText(dto.subtitle, subText);
    pushText(dto.headline.bottom, botText);

    const filterComplex = chain.join(',');
    this.logger.debug(`FFmpeg -vf: ${filterComplex}`);

    const args = [
      '-f',
      'lavfi',
      '-i',
      `color=c=0x111111:s=${canvas.width}x${canvas.height}:d=1`,
      '-vf',
      filterComplex,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      '-y',
      outFile,
    ];

    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      ff.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });
      ff.on('error', reject);
      ff.on('exit', (code) =>
        code === 0 ? resolve() : reject(new Error(`ffmpeg failed (${code}): ${stderr.slice(-1200)}`)),
      );
    }).catch((err) => {
      this.logger.error(`Preview render failed: ${String(err)}`);
      throw new InternalServerErrorException(`Preview render failed: ${String(err)}`);
    });

    const b64 = fs.readFileSync(outFile).toString('base64');
    fs.unlinkSync(outFile);
    return `data:image/jpeg;base64,${b64}`;
  }
}
