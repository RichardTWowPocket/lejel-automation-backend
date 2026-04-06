import type { Ratio, Resolution } from '../profile/profile-dimensions';
import type { KieMarketImageModel } from '../kie-ai/kie-ai.service';

/**
 * Video profile content box (ratio + resolution) as used for Kie asset generation.
 * Must match what `resolveDimensions(profile.content.ratio, profile.content.resolution)` uses.
 */
export type KieProfileContent = {
  ratio: Ratio;
  resolution: Resolution;
};

const GROK_STILL_RATIOS: ReadonlySet<Ratio> = new Set(['1:1', '16:9', '9:16']);

/** Kie Market video ids we validate (others e.g. kling are placeholders / no Kie constraints here). */
export type KieMarketVideoModelId =
  | 'bytedance/v1-lite-text-to-video'
  | 'wan/2-6-text-to-video'
  | 'grok-imagine/image-to-video';

function isKieMarketVideoModel(id: string): id is KieMarketVideoModelId {
  return (
    id === 'bytedance/v1-lite-text-to-video' ||
    id === 'wan/2-6-text-to-video' ||
    id === 'grok-imagine/image-to-video'
  );
}

function normalizeKieImageModelId(raw: string | null | undefined): KieMarketImageModel {
  const s = (raw || 'z-image').trim();
  if (s === 'nano-banana-pro') return 'nano-banana-pro';
  if (s === 'google/nano-banana' || s === 'nano-banana') return 'google/nano-banana';
  if (s === 'flux-2/pro-text-to-image') return 'flux-2/pro-text-to-image';
  if (s === 'flux-2/flex-text-to-image') return 'flux-2/flex-text-to-image';
  if (s === 'grok-imagine/text-to-image') return 'grok-imagine/text-to-image';
  if (s === 'gpt-image/1.5-text-to-image') return 'gpt-image/1.5-text-to-image';
  return 'z-image';
}

/**
 * Bytedance V1 Lite: aspect_ratio + resolution map 1:1 to profile enums in our integration.
 */
export function validateBytedanceV1LiteTextToVideoForProfile(_content: KieProfileContent): void {
  // All profile ratios (1:1, 4:3, 3:4, 16:9, 9:16) are sent to Kie; resolution comes from profile (720p|1080p).
}

/**
 * Wan 2-6: our createTask payload does not set aspect_ratio; only safe when profile matches default behavior.
 */
export function validateWan26TextToVideoForProfile(content: KieProfileContent): void {
  if (content.ratio !== '16:9') {
    throw new Error(
      `Kie model 'wan/2-6-text-to-video' does not support aspect_ratio configuration in our integration. ` +
        `Your profile content ratio is '${content.ratio}'. Switch to 'bytedance/v1-lite-text-to-video' ` +
        `to match the ratio, or use another video model that supports your profile.`,
    );
  }
}

/**
 * Grok image-to-video: we drive it via grok text-to-image task_id; still image must be Grok, ratio must be Grok-still-safe.
 */
export function validateGrokImagineImageToVideoForProfile(
  content: KieProfileContent,
  imageModelRaw: string | null | undefined,
): void {
  if (normalizeKieImageModelId(imageModelRaw) !== 'grok-imagine/text-to-image') {
    throw new Error(
      `Kie model 'grok-imagine/image-to-video' requires imageModel='grok-imagine/text-to-image' ` +
        `so we can pass task_id from the generated Grok image. Please change image model.`,
    );
  }
  if (!GROK_STILL_RATIOS.has(content.ratio)) {
    throw new Error(
      `Kie model 'grok-imagine/image-to-video' requires a Grok still image first; Grok image supports only 1:1, 16:9, 9:16 for your profiles. ` +
        `Your profile content ratio is '${content.ratio}'. Switch profile ratio or switch model.`,
    );
  }
}

/** Grok text-to-image: subset of ratios for our profiles (no 4:3 / 3:4). */
export function assertGrokImagineTextToImageRatio(ratio: Ratio): void {
  if (!GROK_STILL_RATIOS.has(ratio)) {
    throw new Error(
      `Kie model 'grok-imagine/text-to-image' supports only 1:1, 16:9, 9:16. ` +
        `Your profile content ratio is '${ratio}'. Switch image model (e.g. ` +
        `'flux-2/pro-text-to-image', 'flux-2/flex-text-to-image', 'nano-banana-pro', ` +
        `'google/nano-banana', or 'z-image').`,
    );
  }
}

export function validateGrokImagineTextToImageForProfile(content: KieProfileContent): void {
  assertGrokImagineTextToImageRatio(content.ratio);
}

/** GPT Image 1.5: with our profile ratio set, only 1:1 maps without lying about aspect. */
export function assertGptImage15TextToImageRatio(ratio: Ratio): void {
  if (ratio !== '1:1') {
    throw new Error(
      `Kie model 'gpt-image/1.5-text-to-image' supports only '1:1' for your available profile ratios. ` +
        `Your profile content ratio is '${ratio}'. Switch image model (e.g. ` +
        `'flux-2/pro-text-to-image' or 'nano-banana-pro').`,
    );
  }
}

export function validateGptImage15TextToImageForProfile(content: KieProfileContent): void {
  assertGptImage15TextToImageRatio(content.ratio);
}

/**
 * z-image, nano-banana-*, google/nano-banana, flux-2: profile ratios/resolutions are within Kie enums we send.
 */
export function validateZImageForProfile(_content: KieProfileContent): void {}
export function validateNanoBananaProForProfile(_content: KieProfileContent): void {}
export function validateGoogleNanoBananaForProfile(_content: KieProfileContent): void {}
export function validateFlux2TextToImageForProfile(_content: KieProfileContent): void {}

/**
 * Dispatch: validate one Kie Market **video** model against profile content (+ image model when needed).
 */
export function validateKieMarketVideoModelForProfile(
  videoModelRaw: string,
  content: KieProfileContent,
  imageModelRaw?: string | null,
): void {
  if (!isKieMarketVideoModel(videoModelRaw)) {
    return;
  }
  switch (videoModelRaw) {
    case 'bytedance/v1-lite-text-to-video':
      validateBytedanceV1LiteTextToVideoForProfile(content);
      break;
    case 'wan/2-6-text-to-video':
      validateWan26TextToVideoForProfile(content);
      break;
    case 'grok-imagine/image-to-video':
      validateGrokImagineImageToVideoForProfile(content, imageModelRaw);
      break;
    default:
      break;
  }
}

/**
 * Dispatch: validate one Kie Market **image** model against profile content.
 */
export function validateKieMarketImageModelForProfile(
  imageModelRaw: string | null | undefined,
  content: KieProfileContent,
): void {
  const model = normalizeKieImageModelId(imageModelRaw);
  switch (model) {
    case 'grok-imagine/text-to-image':
      validateGrokImagineTextToImageForProfile(content);
      break;
    case 'gpt-image/1.5-text-to-image':
      validateGptImage15TextToImageForProfile(content);
      break;
    case 'z-image':
      validateZImageForProfile(content);
      break;
    case 'nano-banana-pro':
      validateNanoBananaProForProfile(content);
      break;
    case 'google/nano-banana':
      validateGoogleNanoBananaForProfile(content);
      break;
    case 'flux-2/pro-text-to-image':
    case 'flux-2/flex-text-to-image':
      validateFlux2TextToImageForProfile(content);
      break;
    default:
      break;
  }
}
