import { IsArray, IsNotEmpty, ValidateNested, IsString, IsOptional } from 'class-validator';
import { Type } from 'class-transformer';

export class SectionDataDto {
    @IsString()
    @IsNotEmpty()
    transcript: string; // Transcript text for this section

    @IsString()
    @IsNotEmpty()
    imagePath: string; // Path/URL to image file for this section
}

export class CombineMediaProfileDto {
    @IsString()
    @IsNotEmpty()
    audioPath: string; // Full video audio (all sections combined)

    @IsArray()
    @IsNotEmpty()
    @ValidateNested({ each: true })
    @Type(() => SectionDataDto)
    sections: SectionDataDto[]; // Array of sections with transcript and image

    @IsOptional()
    @IsString()
    profile?: string; // Profile ID to use (e.g., 'default', 'saham_catatan', etc.)

    @IsOptional()
    @IsString()
    topHeadlineText?: string; // Top headline text (overrides profile if provided)

    @IsOptional()
    @IsString()
    bottomHeadlineText?: string; // Bottom headline / CTA text (overrides profile if provided)

    @IsOptional()
    @IsString()
    outputFormat?: string; // mp4, webm, etc. Default: mp4

    @IsOptional()
    @IsString()
    returnUrl?: string; // If "yes" or "true", return public URL instead of streaming file

    @IsOptional()
    @IsString()
    asyncMode?: string; // If "yes" or "true", return job ID immediately and process in background

    @IsOptional()
    @IsString()
    bottomHeadlineAppear?: string; // 'start' or 'last'. Default: 'start'
}
