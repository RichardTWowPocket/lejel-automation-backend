/**
 * Profile configuration type definitions
 * These interfaces define the structure of profile JSON files
 */

export interface SubtitleConfig {
    useSubtitle: boolean;
    useSocialMediaSubtitle: boolean;
    fontFamily: string;
    fontSize: number;
    fontFile: string;
    primaryColor: string;
    outlineColor: string;
    backColor: string;
    outline: number;
    shadow: number;
    alignment: number;
    marginL: number;
    marginR: number;
    marginV: number;
    bold: boolean;
    italic: boolean;
    scaleX: number;
    scaleY: number;
}

export interface TopHeadlineConfig {
    fontFamily: string;
    fontSize: number;
    fontFile: string;
    color: string;
    highlightColor: string;
    highlightColorASS: string;
    borderColor: string;
    borderWidth: number;
    y: number;
    alignment: number;
    marginL: number;
    marginR: number;
    marginV: number;
    bold: boolean;
    italic: boolean;
    lineHeight: number;
}

export interface BottomHeadlineConfig {
    fontFamily: string;
    fontSize: number;
    fontFile: string;
    color: string;
    borderColor: string;
    borderWidth: number;
    alignment: number;
    bold: boolean;
    italic: boolean;
}

export interface HeadlineConfig {
    topHeadline: TopHeadlineConfig;
    bottomHeadline: BottomHeadlineConfig;
}

export interface LayoutConfig {
    type: 'default' | 'vertical_poster';
    canvasWidth: number;
    canvasHeight: number;
    imageWidth: number;
    imageHeight: number;
    imageTop: number;
    imageAspect: string;
    inputRatio: string;
    verticalGap: number;
}

export interface ProfileConfig {
    subtitle: SubtitleConfig;
    headline: HeadlineConfig;
    layout: LayoutConfig;
}

export interface Profile {
    profileId: string;
    name: string;
    description: string;
    version: string;
    createdAt: string;
    config: ProfileConfig;
    notes?: any;
}
