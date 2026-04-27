import {
  Controller,
  Post,
  Get,
  Delete,
  Param,
  Body,
  UseGuards,
  Res,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { User as ReqUser } from '../auth/user.decorator';
import { RemotionService } from './remotion.service';
import { GenerateRemotionDto } from './dto/generate-remotion.dto';
import { SaveTemplateDto } from './dto/save-template.dto';
import { RenderTemplateDto } from './dto/render-template.dto';
import { RenderTsxDto } from './dto/render-tsx.dto';
import { ReviseRemotionDto } from './dto/revise-remotion.dto';

@Controller('api/remotion')
@UseGuards(JwtAuthGuard)
export class RemotionController {
  constructor(private readonly remotionService: RemotionService) {}

  /**
   * POST /api/remotion/generate
   * Generate a Remotion TSX from a natural-language prompt (LLM) and immediately render it.
   * Returns the MP4 URL and the generated TSX source (so the user can save it as a template).
   */
  @Post('generate')
  async generate(@Body() dto: GenerateRemotionDto, @ReqUser() user: { id: string }) {
    const width = dto.width ?? 1080;
    const height = dto.height ?? 1920;
    const { inputProps, userAssetsMessageBlock } =
      await this.remotionService.buildRemotionUserAssetContext(user.id, dto.userAssets);
    const tsxSource = await this.remotionService.generateTsx(
      dto.prompt,
      dto.model,
      { width, height },
      {
        userAssetsMessageBlock,
      },
    );

    const result = await this.remotionService.renderSource({
      source: tsxSource,
      durationInFrames: dto.durationInFrames ?? 210,
      fps: dto.fps ?? 30,
      width,
      height,
      inputProps: Object.keys(inputProps).length > 0 ? inputProps : undefined,
    });

    return {
      ok: true,
      tsxSource,
      outputUrl: result.outputUrl,
      outputPath: result.outputPath,
      prompt: dto.prompt,
      model: dto.model ?? 'claude-sonnet-4-6',
      inputProps: Object.keys(inputProps).length > 0 ? inputProps : undefined,
    };
  }

  /**
   * POST /api/remotion/generate-tsx
   * Generate TSX only (no render). Useful for previewing before saving as template.
   */
  @Post('generate-tsx')
  async generateTsxOnly(@Body() dto: GenerateRemotionDto, @ReqUser() user: { id: string }) {
    const width = dto.width ?? 1080;
    const height = dto.height ?? 1920;
    const { inputProps, userAssetsMessageBlock } =
      await this.remotionService.buildRemotionUserAssetContext(user.id, dto.userAssets);
    const tsxSource = await this.remotionService.generateTsx(
      dto.prompt,
      dto.model,
      { width, height },
      {
        userAssetsMessageBlock,
      },
    );
    return {
      ok: true,
      tsxSource,
      prompt: dto.prompt,
      inputProps: Object.keys(inputProps).length > 0 ? inputProps : undefined,
    };
  }

  /**
   * POST /api/remotion/revise-tsx
   * LLM edits existing TSX from a natural-language revision request.
   */
  @Post('revise-tsx')
  async reviseTsx(@Body() dto: ReviseRemotionDto) {
    const width = dto.width ?? 1080;
    const height = dto.height ?? 1920;
    const tsxSource = await this.remotionService.reviseTsx(
      dto.existingTsx,
      dto.revisionPrompt,
      dto.model,
      { width, height },
    );
    return { ok: true, tsxSource };
  }

  /**
   * POST /api/remotion/render
   * Bundle + render TSX you already have (e.g. after reviewing / editing in the UI).
   */
  @Post('render')
  async renderTsx(@Body() dto: RenderTsxDto) {
    const result = await this.remotionService.renderSource({
      source: dto.tsxSource,
      durationInFrames: dto.durationInFrames ?? 210,
      fps: dto.fps ?? 30,
      width: dto.width ?? 1080,
      height: dto.height ?? 1920,
      inputProps:
        dto.inputProps && Object.keys(dto.inputProps).length > 0 ? dto.inputProps : undefined,
    });
    return {
      ok: true,
      outputUrl: result.outputUrl,
      outputPath: result.outputPath,
      mode: result.mode,
    };
  }

  // ─── Templates ────────────────────────────────────────────────────────────

  /**
   * POST /api/remotion/templates
   * Save a TSX composition as a reusable template.
   */
  @Post('templates')
  async saveTemplate(@Body() dto: SaveTemplateDto, @ReqUser() user: { id: string }) {
    const template = await this.remotionService.saveTemplate(user.id, dto);
    return { ok: true, template };
  }

  /**
   * GET /api/remotion/templates
   * List all saved templates for the current user.
   */
  @Get('templates')
  async listTemplates(@ReqUser() user: { id: string }) {
    const templates = await this.remotionService.listTemplates(user.id);
    return { ok: true, templates };
  }

  /**
   * GET /api/remotion/templates/:id
   * Get a single template (includes tsxSource).
   */
  @Get('templates/:id')
  async getTemplate(@Param('id') id: string, @ReqUser() user: { id: string }) {
    const template = await this.remotionService.getTemplate(user.id, id);
    return { ok: true, template };
  }

  /**
   * DELETE /api/remotion/templates/:id
   */
  @Delete('templates/:id')
  @HttpCode(HttpStatus.OK)
  async deleteTemplate(@Param('id') id: string, @ReqUser() user: { id: string }) {
    await this.remotionService.deleteTemplate(user.id, id);
    return { ok: true };
  }

  /**
   * POST /api/remotion/templates/:id/render
   * Render a saved template, optionally overriding inputProps.
   */
  @Post('templates/:id/render')
  async renderTemplate(
    @Param('id') id: string,
    @Body() dto: RenderTemplateDto,
    @ReqUser() user: { id: string },
  ) {
    const result = await this.remotionService.renderTemplate(user.id, id, dto);
    return { ok: true, ...result };
  }

  /**
   * GET /api/remotion/files/:filename
   * Proxy MP4 file download from the Remotion render server.
   */
  @Get('files/:filename')
  async getFile(@Param('filename') filename: string, @Res() res: Response) {
    const safe = filename.replace(/[^a-zA-Z0-9_.-]/g, '');
    if (!safe.endsWith('.mp4')) {
      res.status(400).json({ ok: false, error: 'Invalid filename' });
      return;
    }
    const stream = await this.remotionService.getFileStream(safe);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}"`);
    (stream as NodeJS.ReadableStream).pipe(res);
  }
}
