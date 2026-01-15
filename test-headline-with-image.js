const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const path = require('path');

async function testHeadlineWithImage() {
  console.log('🧪 Testing Headline ASS with Real Image\n');
  
  const imagePath = './public/media/1768451636507-587424022.png';
  const outputPath = './temp/test-headline-final.mp4';
  const tempDir = './temp';
  
  // Test headline input (same as user's example)
  const topHeadlineText = '<h>KKR</h>의</br><h>3조6천억</h> 한국 공략';
  
  console.log(`📝 Input headline: ${topHeadlineText}\n`);
  
  // Settings
  const canvasWidth = 1080;
  const canvasHeight = 1920;
  const imageWidth = 1080;
  const imageHeight = 1440;
  const imageTop = 240;
  const videoDuration = 5;
  
  // NEW font sizes (increased)
  const topHeadlineFontSize = 120; // Increased from 96
  const bottomHeadlineFontSize = 100; // Increased from 80
  
  console.log(`📐 Layout Settings:`);
  console.log(`   Canvas: ${canvasWidth}x${canvasHeight}`);
  console.log(`   Image area: ${imageWidth}x${imageHeight} at Y=${imageTop}`);
  console.log(`   Top headline font size: ${topHeadlineFontSize}px`);
  console.log(`   Bottom headline font size: ${bottomHeadlineFontSize}px`);
  console.log('');
  
  // Parse function (same as in generateHeadlineASS)
  const parseTextWithHighlight = (text) => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    
    let result = '';
    const regex = /<h>(.*?)<\/h>/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(normalized)) !== null) {
      if (match.index > lastIndex) {
        const normalText = normalized.substring(lastIndex, match.index);
        if (normalText) {
          result += normalText;
        }
      }
      if (match[1]) {
        result += `{\\c&H0000FF&}${match[1]}{\\c&HFFFFFF&}`;
      }
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < normalized.length) {
      const normalText = normalized.substring(lastIndex);
      if (normalText) {
        result += normalText;
      }
    }

    return result || normalized;
  };

  // Format time for ASS
  const formatTime = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const centiseconds = Math.floor((seconds % 1) * 100);
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${centiseconds.toString().padStart(2, '0')}`;
  };

  // Generate ASS content
  const lines = topHeadlineText.replace(/<\/?br\s*\/?>/gi, '\n').split('\n').filter(l => l.trim());
  const textLines = lines.map(line => parseTextWithHighlight(line));
  const fullText = textLines.join('\\N');
  
  const startTime = formatTime(0);
  const endTime = formatTime(videoDuration);
  
  let assContent = `[Script Info]
Title: Headline Overlay
ScriptType: v4.00+
PlayResX: ${canvasWidth}
PlayResY: ${canvasHeight}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TopWhite,Hakgyoansim Jiugae,${topHeadlineFontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,0,8,50,50,150,1
Style: TopRed,Hakgyoansim Jiugae,${topHeadlineFontSize},&H000000FF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,0,8,50,50,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,${startTime},${endTime},TopWhite,,0,0,0,,${fullText}
`;

  const assFilePath = path.join(tempDir, 'test-headline-final.ass');
  await fs.writeFile(assFilePath, assContent, 'utf-8');
  
  console.log('📄 Generated ASS Content:');
  console.log('='.repeat(80));
  console.log(assContent);
  console.log('='.repeat(80));
  console.log('');
  
  console.log('🎬 Rendering video with headline overlay...\n');

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop', '1', '-framerate', '30'])
      .videoCodec('libx264')
      .outputOptions([
        `-t ${videoDuration}`,
        `-vf scale=${imageWidth}:${imageHeight}:force_original_aspect_ratio=decrease,pad=${imageWidth}:${imageHeight}:(ow-iw)/2:(oh-ih)/2:black,pad=${canvasWidth}:${canvasHeight}:0:${imageTop}:black,ass=${assFilePath}`,
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
        console.log('\n\n✅ SUCCESS! Video created with headline overlay!');
        console.log(`📹 Output: ${outputPath}`);
        console.log('');
        console.log('📊 Font & Position Info:');
        console.log(`   Font: Hakgyoansim Jiugae`);
        console.log(`   Font Size: ${topHeadlineFontSize}px (top headline)`);
        console.log(`   Position: Top center (alignment 8)`);
        console.log(`   MarginV: 150px from top`);
        console.log(`   Expected: Line 1 "KKR" (RED) + "의" (WHITE)`);
        console.log(`   Expected: Line 2 "3조6천억" (RED) + " 한국 공략" (WHITE)`);
        console.log('');
        
        resolve();
      })
      .on('error', (error) => {
        console.error('\n\n❌ ERROR:', error.message);
        reject(error);
      })
      .run();
  });
}

testHeadlineWithImage()
  .then(() => {
    console.log('\n✨ Test completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Test failed:', error);
    process.exit(1);
  });
