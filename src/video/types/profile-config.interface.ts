export interface DimensionConfig {
  ratio: '1:1' | '3:4' | '4:3' | '9:16' | '16:9';
  resolution: '720p' | '1080p';
}

export interface ContentConfig extends DimensionConfig {
  xOffset: number;
  yOffset: number;
}

export interface TextStyleConfig {
  enabled: boolean;
  font: string;
  fontSize: number;
  fontColor: string;
  highlightColor: string;
  outlineColor: string;
  outlineWidth: number;
  background: boolean;
  backColor: string;
  alignment: number;
  yOffset: number;
  xOffset: number;
  bold: boolean;
  italic: boolean;
}

export interface SubtitleConfig extends TextStyleConfig {
  socialMediaStyle: boolean;
}

export interface HeadlineConfig {
  top: TextStyleConfig;
  bottom: TextStyleConfig;
}

/** Optional sample/default copy for previews and for prefilling headline fields on “new video”. */
export interface ProfileSampleTexts {
  topHeadline?: string;
  bottomHeadline?: string;
  /** Layout/preview only; rendered subtitles still follow the spoken script. */
  subtitle?: string;
}

export interface VideoProfile {
  profileId: string;
  name: string;
  description: string;
  canvas: DimensionConfig;
  content: ContentConfig;
  subtitle: SubtitleConfig;
  headline: HeadlineConfig;
  sampleTexts?: ProfileSampleTexts;
}
