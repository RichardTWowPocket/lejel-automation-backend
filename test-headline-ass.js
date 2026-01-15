const fs = require('fs').promises;
const path = require('path');

async function testHeadlineASS() {
  console.log('🧪 Testing Headline ASS Generation\n');
  
  const input = '<h>KKR</h>의</br><h>3조6천억</h> 한국 공략';
  console.log(`Input: ${input}\n`);
  
  // Parse function
  const parseTextWithHighlight = (text) => {
    const normalized = text.replace(/\s+/g, ' ').trim();
    
    let result = '';
    const regex = /<h>(.*?)<\/h>/g;
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(normalized)) !== null) {
      // Add normal text before highlight
      if (match.index > lastIndex) {
        const normalText = normalized.substring(lastIndex, match.index);
        if (normalText) {
          result += normalText;
        }
      }
      // Add highlighted text with color override (red = &H0000FF& in BGR)
      if (match[1]) {
        result += `{\\c&H0000FF&}${match[1]}{\\c&HFFFFFF&}`;
      }
      lastIndex = regex.lastIndex;
    }

    // Add remaining normal text
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

  const topHeadlineText = input;
  const videoDuration = 60; // 60 seconds
  const width = 1080;
  const height = 1920;
  
  // Process headline
  const lines = topHeadlineText.replace(/<\/?br\s*\/?>/gi, '\n').split('\n').filter(l => l.trim());
  
  console.log('📝 Parsed Lines:');
  lines.forEach((line, i) => {
    console.log(`  Line ${i + 1}: "${line}"`);
  });
  console.log('');
  
  const textLines = lines.map(line => {
    const parsed = parseTextWithHighlight(line);
    console.log(`  Parsed: "${parsed}"`);
    return parsed;
  });
  console.log('');
  
  const fullText = textLines.join('\\N');
  console.log(`📄 Full ASS Text: "${fullText}"\n`);
  
  const startTime = formatTime(0);
  const endTime = formatTime(videoDuration);
  
  // Generate ASS content
  let assContent = `[Script Info]
Title: Headline Overlay
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: TopWhite,Hakgyoansim Jiugae,96,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,0,8,50,50,150,1
Style: TopRed,Hakgyoansim Jiugae,96,&H000000FF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,5,0,8,50,50,150,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  assContent += `Dialogue: 0,${startTime},${endTime},TopWhite,,0,0,0,,${fullText}\n`;
  
  console.log('📋 Generated ASS Content:');
  console.log('='.repeat(80));
  console.log(assContent);
  console.log('='.repeat(80));
  console.log('');
  
  // Expected output
  console.log('✅ Expected Rendering:');
  console.log('  Line 1: "KKR" (RED) + "의" (WHITE)');
  console.log('  Line 2: "3조6천억" (RED) + " 한국 공략" (WHITE)');
  console.log('');
  
  // Write to file
  const tempDir = './temp';
  await fs.mkdir(tempDir, { recursive: true });
  const assFilePath = path.join(tempDir, 'test-headline.ass');
  await fs.writeFile(assFilePath, assContent, 'utf-8');
  
  console.log(`💾 Saved to: ${assFilePath}`);
  console.log('');
  console.log('🎬 To test with FFmpeg:');
  console.log(`   ffmpeg -f lavfi -i color=c=black:s=1080x1920:d=5 -vf "ass=${assFilePath}" -y test-headline-output.mp4`);
}

testHeadlineASS()
  .then(() => {
    console.log('\n✨ Test completed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Test failed:', error);
    process.exit(1);
  });
