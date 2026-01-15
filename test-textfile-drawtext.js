const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const path = require('path');

async function testTextfileDrawtext() {
  console.log('🧪 Testing textfile-based drawtext with Korean text...\n');

  const tempDir = './temp';
  const textDir = path.join(tempDir, 'drawtext-test');
  
  // Ensure directories exist
  await fs.mkdir(textDir, { recursive: true });

  // Create text files with Korean text
  const text1 = '서부발전';
  const text2 = '공공자금 신호';
  
  const textFile1 = path.join(textDir, 'test1.txt');
  const textFile2 = path.join(textDir, 'test2.txt');
  
  await fs.writeFile(textFile1, text1, 'utf-8');
  await fs.writeFile(textFile2, text2, 'utf-8');
  
  console.log(`✅ Created text file 1: ${textFile1}`);
  console.log(`   Content: "${text1}"`);
  console.log(`✅ Created text file 2: ${textFile2}`);
  console.log(`   Content: "${text2}"\n`);

  // Create a simple test image if it doesn't exist
  const testImagePath = './public/media/1768379984189-791730619.png'; // Use existing image
  const outputPath = path.join(tempDir, 'test-output-textfile.mp4');

  const fontPath = '/app/public/hakgyoansim-jiugae/HakgyoansimJiugaeR.ttf';

  // Build filter using textfile (no escaping needed!)
  const filterComplex = [
    'color=black:size=1080x1920:duration=3:rate=30[bg]',
    `[bg]drawtext=textfile=${textFile1}:fontsize=96:fontcolor=red:x=400:y=800:fontfile=${fontPath}:bordercolor=black@1.0:borderw=5[v1]`,
    `[v1]drawtext=textfile=${textFile2}:fontsize=96:fontcolor=white:x=300:y=950:fontfile=${fontPath}:bordercolor=black@1.0:borderw=5[out]`
  ].join(';');

  console.log('🎬 FFmpeg filter_complex:');
  console.log(filterComplex);
  console.log('');

  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(testImagePath)
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
        console.log('📟 Full FFmpeg command:');
        console.log(commandLine);
        console.log('');
      })
      .on('progress', (progress) => {
        if (progress.percent) {
          process.stdout.write(`\r⏳ Processing: ${Math.floor(progress.percent)}%`);
        }
      })
      .on('end', async () => {
        console.log('\n\n✅ SUCCESS! Video created: ' + outputPath);
        console.log('🎉 Korean text with spaces works perfectly with textfile!\n');
        
        // Cleanup text files
        await fs.unlink(textFile1);
        await fs.unlink(textFile2);
        console.log('🧹 Cleaned up text files');
        
        resolve();
      })
      .on('error', async (error) => {
        console.error('\n\n❌ ERROR:', error.message);
        
        // Cleanup on error
        try {
          await fs.unlink(textFile1);
          await fs.unlink(textFile2);
        } catch (e) {}
        
        reject(error);
      })
      .run();
  });
}

// Run the test
testTextfileDrawtext()
  .then(() => {
    console.log('\n✨ Test completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Test failed:', error);
    process.exit(1);
  });
