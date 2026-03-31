import { Injectable, Logger } from '@nestjs/common';

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

@Injectable()
export class VideoProcessingService {
  private readonly logger = new Logger(VideoProcessingService.name);

  async renderPlaceholderImage(title: string, body: string) {
    const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
  <rect width="1280" height="720" fill="#09090b"/>
  <text x="640" y="140" text-anchor="middle" fill="#f59e0b" font-family="Arial, sans-serif" font-size="36">${escapeXml(title)}</text>
  <foreignObject x="120" y="210" width="1040" height="300">
    <div xmlns="http://www.w3.org/1999/xhtml" style="font-family:Arial,sans-serif;color:#ffffff;font-size:28px;line-height:1.5;text-align:center;">
      ${escapeXml(body)}
    </div>
  </foreignObject>
</svg>`;
    this.logger.warn('Using fallback placeholder rendering');
    return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  }
}
