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

export interface VideoProfile {
  profileId: string;
  name: string;
  description: string;
  canvas: DimensionConfig;
  content: ContentConfig;
  subtitle: SubtitleConfig;
  headline: HeadlineConfig;
}
