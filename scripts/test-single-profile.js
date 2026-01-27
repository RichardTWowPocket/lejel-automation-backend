#!/usr/bin/env node

/**
 * Test script for single profile
 * Quick testing for a specific profile
 * 
 * Usage:
 *   node scripts/test-single-profile.js <profileId>
 *   
 * Example:
 *   node scripts/test-single-profile.js saham_catatan
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Get profile ID from command line
const profileId = process.argv[2] || 'default';

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || ''; // Leave empty if no auth needed
const IMAGE_PATH = '/app/public/media/1769053993782-151271291.png';
const TOP_HEADLINE = '<h>서진시스템</h></br><h>정밀파운드리</h> 전환';
const SUBTITLE = '서진시스템, 정밀파운드리로 레벨업 중 놓치면 손해';
const BOTTOM_HEADLINE = '';
const VIDEO_DURATION = 5;

// Output directory
const OUTPUT_DIR = path.join(__dirname, '..', 'temp', 'profile-tests');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Generate dummy audio file
 */
async function generateDummyAudio() {
    const audioPath = path.join(OUTPUT_DIR, 'audio-5sec.mp3');

    if (fs.existsSync(audioPath)) {
        console.log(`✅ Using existing audio: ${audioPath}\n`);
        return audioPath;
    }

    console.log('🎵 Generating 5-second dummy audio...');
    const cmd = `ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t ${VIDEO_DURATION} -q:a 9 -acodec libmp3lame "${audioPath}"`;

    await execAsync(cmd);
    console.log(`✅ Audio created: ${audioPath}\n`);
    return audioPath;
}

/**
 * Main function
 */
async function main() {
    console.log('\n' + '━'.repeat(60));
    console.log(`🧪 Testing Profile: ${profileId}`);
    console.log('━'.repeat(60) + '\n');

    // Generate audio
    const audioPath = await generateDummyAudio();

    // Prepare request
    const requestData = {
        audioPath: audioPath,
        sections: [
            {
                transcript: SUBTITLE,
                imagePath: IMAGE_PATH,
            },
        ],
        profile: profileId,
        topHeadlineText: TOP_HEADLINE,
        bottomHeadlineText: BOTTOM_HEADLINE,
        returnUrl: 'yes',
    };

    console.log('📤 Request:');
    console.log(`   Profile: ${profileId}`);
    console.log(`   Image: ${IMAGE_PATH}`);
    console.log(`   Top Headline: ${TOP_HEADLINE}`);
    console.log(`   Subtitle: ${SUBTITLE}\n`);

    console.log('⏳ Sending request to API...\n');

    try {
        const startTime = Date.now();

        const response = await axios.post(
            `${API_BASE_URL}/api/combine-media-profile`,
            requestData,
            {
                headers: {
                    'x-api-key': API_KEY,
                    'Content-Type': 'application/json',
                },
                timeout: 120000,
            }
        );

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        if (response.status === 200) {
            const videoUrl = response.data;

            console.log('━'.repeat(60));
            console.log('✅ SUCCESS!');
            console.log('━'.repeat(60));
            console.log(`\n📹 Video URL: ${videoUrl}`);
            console.log(`⏱️  Processing time: ${duration}s\n`);

            // Save URL
            const urlFile = path.join(OUTPUT_DIR, `url-${profileId}.txt`);
            fs.writeFileSync(urlFile, videoUrl, 'utf8');
            console.log(`💾 URL saved to: ${urlFile}\n`);

            console.log('💡 Next: Open the URL to view the video!\n');
        } else {
            console.error(`⚠️  Unexpected status: ${response.status}`);
            process.exit(1);
        }
    } catch (error) {
        console.error('\n━'.repeat(60));
        console.error('❌ ERROR');
        console.error('━'.repeat(60));
        console.error(`\nMessage: ${error.message}`);

        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error(`Data: ${JSON.stringify(error.response.data, null, 2)}`);
        }
        console.error('');
        process.exit(1);
    }
}

main().catch(error => {
    console.error('\n💥 Fatal error:', error);
    process.exit(1);
});
