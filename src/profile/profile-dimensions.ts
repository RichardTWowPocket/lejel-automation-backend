export const RATIOS = ['1:1', '3:4', '4:3', '9:16', '16:9'] as const;
export type Ratio = (typeof RATIOS)[number];

export const RESOLUTIONS = ['720p', '1080p'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

const DIMENSION_TABLE: Record<string, { width: number; height: number }> = {
  '1:1_720p': { width: 720, height: 720 },
  '1:1_1080p': { width: 1080, height: 1080 },
  '3:4_720p': { width: 720, height: 960 },
  '3:4_1080p': { width: 1080, height: 1440 },
  '4:3_720p': { width: 960, height: 720 },
  '4:3_1080p': { width: 1440, height: 1080 },
  '9:16_720p': { width: 720, height: 1280 },
  '9:16_1080p': { width: 1080, height: 1920 },
  '16:9_720p': { width: 1280, height: 720 },
  '16:9_1080p': { width: 1920, height: 1080 },
};

export function resolveDimensions(
  ratio: Ratio,
  resolution: Resolution,
): { width: number; height: number } {
  const key = `${ratio}_${resolution}`;
  const entry = DIMENSION_TABLE[key];
  if (!entry) {
    throw new Error(`Unknown ratio/resolution combination: ${key}`);
  }
  return entry;
}
