/**
 * Mega Prompt Template Loader
 *
 * Loads the mega prompt template from a text file to avoid
 * TypeScript JSX parsing issues in template strings.
 */

import * as fs from 'fs';
import * as path from 'path';

let cachedPrompt: string | null = null;

export function loadMegaSystemPrompt(): string {
  if (cachedPrompt) return cachedPrompt;

  const filePath = path.join(__dirname, 'mega-prompt.template.txt');
  cachedPrompt = fs.readFileSync(filePath, 'utf-8');
  return cachedPrompt;
}
