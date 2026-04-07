import * as fs from 'fs';
import type { TextStyleConfig } from './types/profile-config.interface';

function hexToAssBgr(hex: string): string {
  const clean = hex.replace('#', '');
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  return `&H00${b}${g}${r}`;
}

function assEscapeTextKeepSpacing(input: string): string {
  return (input || '')
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\n/g, ' ');
}

function assAnchorX(alignment: number): 'left' | 'center' | 'right' {
  if ([1, 4, 7].includes(alignment)) return 'left';
  if ([3, 6, 9].includes(alignment)) return 'right';
  return 'center';
}

function assAnchorY(alignment: number): 'top' | 'middle' | 'bottom' {
  if ([7, 8, 9].includes(alignment)) return 'top';
  if ([4, 5, 6].includes(alignment)) return 'middle';
  return 'bottom';
}

/** ASS \\pos + \\an so xOffset/yOffset match drawtext geometry. */
function assSubtitlePosPrefix(
  style: TextStyleConfig,
  playResX: number,
  playResY: number,
): string {
  const a = style.alignment ?? 2;
  const ax = assAnchorX(a);
  const ay = assAnchorY(a);
  const xOff = Number(style.xOffset) || 0;
  const yOff = Number(style.yOffset) || 0;
  const m = 20;
  let x = playResX / 2;
  let y = playResY / 2;
  if (ay === 'top') {
    y = m + yOff;
    if (ax === 'left') x = m + xOff;
    else if (ax === 'right') x = playResX - m + xOff;
    else x = playResX / 2 + xOff;
  } else if (ay === 'middle') {
    if (ax === 'left') x = m + xOff;
    else if (ax === 'right') x = playResX - m + xOff;
    else x = playResX / 2 + xOff;
    y = playResY / 2 + yOff;
  } else {
    y = playResY - m - yOff;
    if (ax === 'left') x = m + xOff;
    else if (ax === 'right') x = playResX - m + xOff;
    else x = playResX / 2 + xOff;
  }
  return `{\\an${a}\\pos(${Math.round(x)},${Math.round(y)})}`;
}

function textStyleToAssHeadline(style: TextStyleConfig, styleName = 'HeadlineHl'): string {
  const assAlignmentMap: Record<number, number> = {
    1: 1, 2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  };
  const alignment = assAlignmentMap[style.alignment] ?? 2;
  const primary = style.fontColor;
  const secondary = style.highlightColor;
  return `Style: ${styleName},${style.font},${style.fontSize},${hexToAssBgr(primary)},${hexToAssBgr(secondary)},${hexToAssBgr(style.backColor)},${hexToAssBgr(style.outlineColor)},${style.bold ? -1 : 0},${style.italic ? -1 : 0},0,0,100,100,0,0,1,${Math.max(0, style.outlineWidth)},0,${alignment},0,0,0,1`;
}

export function headlineHasHighlightTags(s: string): boolean {
  return /<h>[\s\S]*?<\/h>/i.test(s || '');
}

export function stripHeadlineHighlightTags(s: string): string {
  return (s || '').replace(/<\/?h>/gi, '');
}

function parseHeadlineHighlightSegments(input: string): Array<{ text: string; highlight: boolean }> {
  const s = input || '';
  const re = /<h>([\s\S]*?)<\/h>/gi;
  const out: Array<{ text: string; highlight: boolean }> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) {
      const plain = s.slice(last, m.index);
      if (plain) out.push({ text: plain, highlight: false });
    }
    const inner = m[1] ?? '';
    if (inner) out.push({ text: inner, highlight: true });
    last = m.index + m[0].length;
  }
  if (last < s.length) {
    const rest = s.slice(last);
    if (rest) out.push({ text: rest, highlight: false });
  }
  if (out.length === 0) {
    out.push({ text: s.replace(/<\/?h>/gi, ''), highlight: false });
  }
  return out;
}

/**
 * Build ASS dialogue body with explicit \\c for base and highlight.
 * Avoids `{\\r}` after highlights — some libass builds reset fill colour inconsistently.
 */
export function buildHeadlineAssRichBody(
  segments: Array<{ text: string; highlight: boolean }>,
  style: TextStyleConfig,
): string {
  const hi = hexToAssBgr(style.highlightColor);
  const base = hexToAssBgr(style.fontColor);
  let buf = '';
  for (const seg of segments) {
    const esc = assEscapeTextKeepSpacing(seg.text);
    if (!esc || !esc.trim()) continue;
    if (seg.highlight) {
      buf += `{\\c${hi}}${esc}{\\c${base}}`;
    } else {
      buf += `{\\c${base}}${esc}`;
    }
  }
  return buf;
}

export function writeHeadlineHighlightAssFile(
  style: TextStyleConfig,
  rawText: string,
  playResX: number,
  playResY: number,
  outPath: string,
): void {
  const segments = parseHeadlineHighlightSegments(rawText);
  const posPrefix = assSubtitlePosPrefix(style, playResX, playResY);
  const body = buildHeadlineAssRichBody(segments, style);
  const doc = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${playResX}`,
    `PlayResY: ${playResY}`,
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,BackColour,OutlineColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    textStyleToAssHeadline(style, 'HeadlineHl'),
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    `Dialogue: 0,0:00:00.00,9:59:59.99,HeadlineHl,,0,0,0,,${posPrefix}${body}`,
    '',
  ].join('\n');
  fs.writeFileSync(outPath, doc, 'utf-8');
}
