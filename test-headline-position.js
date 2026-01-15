const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const path = require('path');

async function testHeadlinePosition() {
  console.log('🧪 Testing headline positioning with -50px adjustment for 2 lines...\n');

  const tempDir = './temp';
  const textDir = path.join(tempDir, 'drawtext-test');
  
  // Ensure directories exist
  await fs.mkdir(textDir, { recursive: true });

  // Test data: 2 lines (should move up by 50px)
  const topLine1 = '서부발전'; // red with <h>
  const topLine2 = '공공자금 신호'; // white
  
  const textFile1 = path.join(textDir, 'headline_line1.txt');
  const textFile2 = path.join(textDir, 'headline_line2.txt');
  
  await fs.writeFile(textFile1, topLine1, 'utf-8');
  await fs.writeFile(textFile2, topLine2, 'utf-8');
  
  console.log(`✅ Text file 1: ${textFile1} = "${topLine1}"`);
  console.log(`✅ Text file 2: ${textFile2} = "${topLine2}"\n`);

  // Settings
  const canvasWidth = 1080;
  const canvasHeight = 1920;
  const imageWidth = 1080;
  const imageHeight = 1440;
  const imageTop = 240;
  
  const topHeadlineFontSize = 96;
  const borderWidth = 5;
  const lineHeight = 1.15;
  
  // NEW: -50px adjustment for 2 lines
  const baseTopHeadlineY = 280;
  const topHeadlineY = baseTopHeadlineY - 90; // 230px (because we have 2 lines)
  
  console.log(`📐 Layout Settings:`);
  console.log(`   Canvas: ${canvasWidth}x${canvasHeight}`);
  console.log(`   Image area: ${imageWidth}x${imageHeight} at Y=${imageTop}`);
  console.log(`   Base headline Y: ${baseTopHeadlineY}px`);
  console.log(`   Adjusted for 2 lines: ${topHeadlineY}px (moved up 50px)`);
  console.log('');

  const imagePath = './public/media/1768379984189-791730619.png'; // 1:1 image
  const outputPath = path.join(tempDir, 'test-headline-50px.mp4');
  const fontPath = '/app/public/hakgyoansim-jiugae/HakgyoansimJiugaeR.ttf';

  // Calculate positions for centered text
  // Estimate text width (rough calculation)
  const estimateWidth = (text, fontSize) => {
    return text.length * fontSize * 0.95; // Korean chars ~0.95x fontSize
  };
  
  const line1Width = estimateWidth(topLine1, topHeadlineFontSize);
  const line2Width = estimateWidth(topLine2, topHeadlineFontSize);
  
  const line1X = (canvasWidth - line1Width) / 2;
  const line2X = (canvasWidth - line2Width) / 2;
  
  const line1Y = topHeadlineY;
  const line2Y = topHeadlineY + (topHeadlineFontSize * lineHeight);
  
  console.log(`📝 Text Positioning:`);
  console.log(`   Line 1 "${topLine1}": X=${line1X.toFixed(1)}, Y=${line1Y.toFixed(1)}`);
  console.log(`   Line 2 "${topLine2}": X=${line2X.toFixed(1)}, Y=${line2Y.toFixed(1)}`);
  console.log('');

  // Build filter using textfile
  const filterComplex = [
    `[0:v]scale=${imageWidth}:${imageHeight}:force_original_aspect_ratio=decrease,pad=${imageWidth}:${imageHeight}:(ow-iw)/2:(oh-ih)/2:black[img]`,
    `color=black:size=${canvasWidth}x${canvasHeight}:duration=3:rate=30[bg]`,
    `[bg][img]overlay=0:${imageTop}[v1]`,
    `[v1]drawtext=textfile=${textFile1}:fontsize=${topHeadlineFontSize}:fontcolor=red:x=${line1X}:y=${line1Y}:fontfile=${fontPath}:bordercolor=black@1.0:borderw=${borderWidth}[v2]`,
    `[v2]drawtext=textfile=${textFile2}:fontsize=${topHeadlineFontSize}:fontcolor=white:x=${line2X}:y=${line2Y}:fontfile=${fontPath}:bordercolor=black@1.0:borderw=${borderWidth}[out]`
  ].join(';');

  console.log('🎬 Filter Complex:');
  console.log(filterComplex.split(';').map((f, i) => `   ${i + 1}. ${f}`).join('\n'));
  console.log('');

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop', '1', '-framerate', '30'])
      .videoCodec('libx264')
      .outputOptions([
        '-t 3',
        '-filter_complex', filterComplex,
        '-map', '[out]',
        '-pix_fmt', 'yuv420p',
        '-r', '30',
        '-preset', 'fast',
        '-crf', '23'
      ])
      .output(outputPath)
      .on('start', (commandLine) => {
        console.log('📟 FFmpeg Command:');
        console.log(commandLine);
        console.log('');
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          process.stdout.write(`\r⏳ Processing: ${Math.floor(progress.percent)}%`);
        }
      })
      .on('end', async () => {
        console.log('\n\n✅ SUCCESS! Video created with -50px adjustment!');
        console.log(`📹 Output: ${outputPath}`);
        console.log('');
        console.log('🎯 Visual check:');
        console.log('   - Line 1 "서부발전" (RED) at Y=230px');
        console.log('   - Line 2 "공공자금 신호" (WHITE) at Y≈340px');
        console.log('   - 50px higher than old -30px positioning');
        console.log('');
        
        // Cleanup text files
        await fs.unlink(textFile1);
        await fs.unlink(textFile2);
        console.log('🧹 Cleaned up text files');
        
        resolve();
      })
      .on('error', async (error) => {
        console.error('\n\n❌ ERROR:', error.message);
        
        try {
          await fs.unlink(textFile1);
          await fs.unlink(textFile2);
        } catch (e) {}
        
        reject(error);
      })
      .run();
  });
}

testHeadlinePosition()
  .then(() => {
    console.log('\n✨ Test completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Test failed:', error);
    process.exit(1);
  });
