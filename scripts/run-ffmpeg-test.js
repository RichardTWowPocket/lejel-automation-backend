#!/usr/bin/env node

/**
 * Script to run FFMPEG commands with real video/image processing
 * Generates ASS files and executes FFMPEG
 * 
 * Usage: 
 *   node scripts/run-ffmpeg-test.js <profileId> [--image="path"] [--headline="text<br>text2"] [--subtitle="text"] [--duration=10] [--output="output.mp4"]
 * 
 * Example: 
 *   node scripts/run-ffmpeg-test.js saham_labs \
 *     --image="/app/public/media/1768978617748-985137796.png" \
 *     --headline="한화에어로<br><h>실적 분수령</h>" \
 *     --subtitle="한화에어로스페이스 주가는 더 세게 뛰고 있어요"
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Parse arguments
const args = process.argv.slice(2);
const profileId = args[0] || 'saham_labs';

let imagePath = null;
let headlineText = null;
let subtitleText = null;
let videoDuration = 10;
let outputPath = null;

for (let i = 1; i < args.length; i++) {
  if (args[i].startsWith('--image=')) {
    imagePath = args[i].substring('--image='.length);
  } else if (args[i].startsWith('--headline=')) {
    headlineText = args[i].substring('--headline='.length);
  } else if (args[i].startsWith('--subtitle=')) {
    subtitleText = args[i].substring('--subtitle='.length);
  } else if (args[i].startsWith('--duration=')) {
    videoDuration = parseFloat(args[i].substring('--duration='.length));
  } else if (args[i].startsWith('--output=')) {
    outputPath = args[i].substring('--output='.length);
  }
}

// Load profile
const profilesDir = path.join(__dirname, '..', 'profiles');
const profilePath = path.join(profilesDir, `${profileId}.json`);

if (!fs.existsSync(profilePath)) {
  console.error(`❌ Profile not found: ${profilePath}`);
  process.exit(1);
}

const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
const config = profile.config || {};

console.log(`\n📋 Profile: ${profile.name || profileId}`);
console.log(`📁 Profile path: ${profilePath}\n`);

// Extract config
const headlineConfig = config.headline || {};
const topHeadlineConfig = headlineConfig.topHeadline || {};
const bottomHeadlineConfig = headlineConfig.bottomHeadline || {};
const subtitleConfig = config.subtitle || {};
const layoutConfig = config.layout || {};

const width = layoutConfig.canvasWidth || 1080;
const height = layoutConfig.canvasHeight || 1920;

// Create temp directory for ASS files
const tempDir = path.join(__dirname, '..', 'temp', 'ffmpeg-test');
if (!fs.existsSync(tempDir)) {
  fs.mkdirSync(tempDir, { recursive: true });
}

// Helper: Format time for ASS (h:mm:ss.cc)
function formatAssTime(seconds) {
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const centiseconds = Math.floor((seconds % 1) * 100);
  return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
}

// Helper: Parse text with <h>highlight</h> tags
function parseTextWithHighlight(text, highlightColorASS) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  let result = '';
  const regex = /<h>(.*?)<\/h>/g;
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(normalized)) !== null) {
    if (match.index > lastIndex) {
      const normalText = normalized.substring(lastIndex, match.index);
      if (normalText) result += normalText;
    }
    if (match[1]) {
      result += `{\\c${highlightColorASS}}${match[1]}{\\c&HFFFFFF&}`;
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < normalized.length) {
    const normalText = normalized.substring(lastIndex);
    if (normalText) result += normalText;
  }

  return result || normalized;
}

// Generate headline ASS file
function generateHeadlineASS(headlineText, outputPath) {
  const highlightColorASS = topHeadlineConfig.highlightColorASS || '&H0000FF&';
  const fontFamily = topHeadlineConfig.fontFamily || 'Hakgyoansim Jiugae';
  const fontSize = topHeadlineConfig.fontSize || 120;
  const borderWidth = topHeadlineConfig.borderWidth || 5;
  const alignment = topHeadlineConfig.alignment || 8;
  const marginL = topHeadlineConfig.marginL || 50;
  const marginR = topHeadlineConfig.marginR || 50;
  const marginV = topHeadlineConfig.marginV || 150;
  const bold = topHeadlineConfig.bold || false;
  const italic = topHeadlineConfig.italic || false;
  const lineHeight = topHeadlineConfig.lineHeight || 1.0;

  let assContent = `[Script Info]
Title: Headline Overlay
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TopWhite,${fontFamily},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,${bold ? '-1' : '0'},${italic ? '-1' : '0'},0,0,100,100,0,0,1,${borderWidth},0,${alignment},${marginL},${marginR},${marginV},1
Style: TopRed,${fontFamily},${fontSize},${highlightColorASS},${highlightColorASS},&H00000000,&H80000000,${bold ? '-1' : '0'},${italic ? '-1' : '0'},0,0,100,100,0,0,1,${borderWidth},0,${alignment},${marginL},${marginR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const startTime = formatAssTime(0);
  const endTime = formatAssTime(videoDuration);

  if (headlineText) {
    // Fix </br> to <br>
    const normalizedText = headlineText.replace(/<\/?br\s*\/?>/gi, '<br>');
    const lines = normalizedText.replace(/<\/?br\s*\/?>/gi, '\n').split('\n').filter(l => l.trim());
    const textLines = lines.map(line => parseTextWithHighlight(line, highlightColorASS));

    if (textLines.length > 1 && lineHeight < 1.0) {
      // Use separate Dialogue entries with precise positioning
      const lineSpacing = Math.round(fontSize * lineHeight);
      const firstLineY = marginV;
      const secondLineY = firstLineY + lineSpacing;
      const centerX = width / 2;

      assContent += `Dialogue: 0,${startTime},${endTime},TopWhite,,0,0,0,,{\\an8\\pos(${centerX},${firstLineY})}${textLines[0]}\n`;
      assContent += `Dialogue: 0,${startTime},${endTime},TopWhite,,0,0,0,,{\\an8\\pos(${centerX},${secondLineY})}${textLines[1]}\n`;
      for (let i = 2; i < textLines.length; i++) {
        const lineY = secondLineY + (lineSpacing * (i - 1));
        assContent += `Dialogue: 0,${startTime},${endTime},TopWhite,,0,0,0,,{\\an8\\pos(${centerX},${lineY})}${textLines[i]}\n`;
      }
    } else {
      let fullText = textLines[0];
      for (let i = 1; i < textLines.length; i++) {
        fullText += `\\N${textLines[i]}`;
      }
      assContent += `Dialogue: 0,${startTime},${endTime},TopWhite,,0,0,0,,${fullText}\n`;
    }
  }

  fs.writeFileSync(outputPath, assContent, 'utf8');
  return outputPath;
}

// Generate subtitle ASS file (simple text subtitle)
function generateSubtitleASS(subtitleText, outputPath) {
  const fontFamily = subtitleConfig.fontFamily || 'Noto Sans CJK KR';
  const fontSize = subtitleConfig.fontSize || 48;
  const borderWidth = subtitleConfig.outline || 5;
  const alignment = subtitleConfig.alignment || 2;
  const marginL = subtitleConfig.marginL || 50;
  const marginR = subtitleConfig.marginR || 50;
  const marginV = subtitleConfig.marginV || 600;
  const bold = subtitleConfig.bold || false;
  const italic = subtitleConfig.italic || false;
  const primaryColor = subtitleConfig.primaryColor || '&H00FFFFFF&';
  const outlineColor = subtitleConfig.outlineColor || '&H00000000&';
  const backColor = subtitleConfig.backColor || '&H80000000&';

  let assContent = `[Script Info]
Title: Subtitle Overlay
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Subtitle,${fontFamily},${fontSize},${primaryColor},${primaryColor},${outlineColor},${backColor},${bold ? '-1' : '0'},${italic ? '-1' : '0'},0,0,100,100,0,0,1,${borderWidth},0,${alignment},${marginL},${marginR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const startTime = formatAssTime(0);
  const endTime = formatAssTime(videoDuration);

  if (subtitleText) {
    assContent += `Dialogue: 0,${startTime},${endTime},Subtitle,,0,0,0,,${subtitleText}\n`;
  }

  fs.writeFileSync(outputPath, assContent, 'utf8');
  return outputPath;
}

// Escape path for FFMPEG filter
function escapePathForFilter(filePath) {
  return filePath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/'/g, "\\'")
    .replace(/ /g, '\\ ');
}

// Main execution
async function main() {
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🎬 RUNNING FFMPEG TEST');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // Step 1: Check image file
  if (!imagePath) {
    console.error(`❌ No image provided. Use --image="path"`);
    process.exit(1);
  }

  // Resolve image path (handle both absolute and relative paths)
  let absoluteImagePath = imagePath;
  if (!path.isAbsolute(imagePath)) {
    // Try relative to project root
    absoluteImagePath = path.join(__dirname, '..', imagePath);
  }

  // Also try with /app prefix (Docker path)
  if (!fs.existsSync(absoluteImagePath)) {
    const dockerPath = imagePath.replace(/^\/app\//, '');
    absoluteImagePath = path.join(__dirname, '..', dockerPath);
  }

  if (!fs.existsSync(absoluteImagePath)) {
    console.error(`❌ Image file not found: ${imagePath}`);
    console.error(`   Tried: ${absoluteImagePath}`);
    process.exit(1);
  }

  console.log(`✅ Using image: ${absoluteImagePath}`);

  // Step 2: Generate ASS files
  let headlineAssPath = null;
  let subtitleAssPath = null;

  if (headlineText) {
    headlineAssPath = path.join(tempDir, `headline_${Date.now()}.ass`);
    generateHeadlineASS(headlineText, headlineAssPath);
    console.log(`✅ Generated headline ASS: ${headlineAssPath}`);
  }

  if (subtitleText) {
    subtitleAssPath = path.join(tempDir, `subtitle_${Date.now()}.ass`);
    generateSubtitleASS(subtitleText, subtitleAssPath);
    console.log(`✅ Generated subtitle ASS: ${subtitleAssPath}`);
  }

  // Step 3: Create video from image
  const videoPath = path.join(tempDir, `input_video_${Date.now()}.mp4`);
  console.log(`\n🎥 Creating video from image...`);

  // Create video from image using FFMPEG
  const createVideoCmd = `ffmpeg -loop 1 -i "${absoluteImagePath}" -t ${videoDuration} -vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2" -pix_fmt yuv420p -c:v libx264 -preset fast -crf 23 "${videoPath}"`;

  try {
    console.log(`Running: ${createVideoCmd}`);
    await execAsync(createVideoCmd);
    console.log(`✅ Video created: ${videoPath}`);
  } catch (error) {
    console.error(`❌ Failed to create video: ${error.message}`);
    if (error.stderr) {
      console.error(error.stderr);
    }
    process.exit(1);
  }

  // Step 4: Build FFMPEG command with ASS filters
  const outputVideo = outputPath || path.join(tempDir, `output_${Date.now()}.mp4`);

  let filters = [];

  // Add headline filter
  if (headlineAssPath) {
    const fontFilePath = topHeadlineConfig.fontFile;
    let fontsDir = null;

    if (fontFilePath) {
      fontsDir = path.dirname(fontFilePath);
    }

    const escapedHeadlinePath = escapePathForFilter(headlineAssPath);
    const headlineFilter = fontsDir
      ? `ass=${escapedHeadlinePath}:fontsdir=${fontsDir}`
      : `ass=${escapedHeadlinePath}`;
    filters.push(headlineFilter);
  }

  // Add subtitle filter
  if (subtitleAssPath) {
    const fontFilePath = subtitleConfig.fontFile;
    let fontsDir = null;

    if (fontFilePath) {
      fontsDir = path.dirname(fontFilePath);
    }

    const escapedSubtitlePath = escapePathForFilter(subtitleAssPath);
    const subtitleFilter = fontsDir
      ? `ass=${escapedSubtitlePath}:fontsdir=${fontsDir}`
      : `ass=${escapedSubtitlePath}`;
    filters.push(subtitleFilter);
  }

  if (filters.length === 0) {
    console.error(`❌ No filters to apply. Provide --headline or --subtitle`);
    process.exit(1);
  }

  const filterString = filters.join(',');

  // Step 5: Run FFMPEG
  const ffmpegCmd = `ffmpeg -i "${videoPath}" -vf "${filterString}" -c:v libx264 -c:a copy -pix_fmt yuv420p -crf 23 -preset fast -movflags +faststart "${outputVideo}"`;

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('🚀 EXECUTING FFMPEG COMMAND');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
  console.log(`Command:`);
  console.log(`  ${ffmpegCmd}\n`);

  try {
    console.log('⏳ Processing video (this may take a while)...\n');
    const { stdout, stderr } = await execAsync(ffmpegCmd);

    if (stderr) {
      // FFMPEG outputs progress to stderr, which is normal
      console.log(stderr);
    }

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ SUCCESS!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`📹 Output video: ${outputVideo}`);
    console.log(`\n💡 You can now view the video to see the result!\n`);
  } catch (error) {
    console.error('\n❌ FFMPEG execution failed:');
    console.error(error.message);
    if (error.stderr) {
      console.error('\nFFMPEG stderr:');
      console.error(error.stderr);
    }
    process.exit(1);
  }
}

// Run main function
main().catch(error => {
  console.error('❌ Fatal error:', error);
  process.exit(1);
});
