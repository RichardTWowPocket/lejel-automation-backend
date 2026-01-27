#!/usr/bin/env node

/**
 * Test script for combine-media-profile API
 * Tests all 5 profiles with a single image and Korean text
 * 
 * Usage:
 *   node scripts/test-combine-media-profile.js
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';
const API_KEY = process.env.API_KEY || ''; // Leave empty if no auth needed
const IMAGE_PATH = '/app/public/media/1769053993782-151271291.png';
const TOP_HEADLINE = '<h>서진시스템</h></br><h>정밀파운드리</h> 전환';
const SUBTITLE = '서진시스템, 정밀파운드리로 레벨업 중 놓치면 손해';
const BOTTOM_HEADLINE = ''; // Empty as requested
const VIDEO_DURATION = 5; // seconds

// Profiles to test
const PROFILES = [
    'default',
    'saham_catatan',
    'saham_labs',
    'saham_logs',
    'saham_suhu',
];

// Output directory
const OUTPUT_DIR = path.join(__dirname, '..', 'temp', 'profile-tests');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Generate dummy audio file (5 seconds of silence)
 */
async function generateDummyAudio() {
    const audioPath = path.join(OUTPUT_DIR, 'audio-5sec.mp3');

    // Check if already exists
    if (fs.existsSync(audioPath)) {
        console.log(`✅ Using existing audio file: ${audioPath}`);
        return audioPath;
    }

    console.log('🎵 Generating 5-second dummy audio...');

    const cmd = `ffmpeg -f lavfi -i anullsrc=r=44100:cl=stereo -t ${VIDEO_DURATION} -q:a 9 -acodec libmp3lame "${audioPath}"`;

    try {
        await execAsync(cmd);
        console.log(`✅ Dummy audio created: ${audioPath}`);
        return audioPath;
    } catch (error) {
        console.error(`❌ Failed to create dummy audio: ${error.message}`);
        throw error;
    }
}

/**
 * Test a single profile
 */
async function testProfile(profileId, audioPath) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`🧪 Testing Profile: ${profileId}`);
    console.log(`${'='.repeat(80)}\n`);

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

    console.log('📤 Request payload:');
    console.log(JSON.stringify(requestData, null, 2));
    console.log('');

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
                timeout: 120000, // 2 minutes timeout
            }
        );

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        if (response.status === 200 || response.status === 201) {
            const videoUrl = response.data;
            console.log(`✅ SUCCESS! (${duration}s)`);
            console.log(`📹 Video URL: ${videoUrl}`);

            // Save URL to file
            const urlFilePath = path.join(OUTPUT_DIR, `url-${profileId}.txt`);
            fs.writeFileSync(urlFilePath, videoUrl, 'utf8');
            console.log(`💾 URL saved to: ${urlFilePath}`);

            return {
                success: true,
                profileId,
                videoUrl,
                duration,
            };
        } else {
            console.log(`⚠️  Unexpected status: ${response.status}`);
            return {
                success: false,
                profileId,
                error: `Unexpected status: ${response.status}`,
            };
        }
    } catch (error) {
        console.error(`❌ ERROR: ${error.message}`);
        if (error.response) {
            console.error(`   Status: ${error.response.status}`);
            console.error(`   Data: ${JSON.stringify(error.response.data)}`);
        }

        return {
            success: false,
            profileId,
            error: error.message,
        };
    }
}

/**
 * Main function
 */
async function main() {
    console.log('\n' + '━'.repeat(80));
    console.log('🎬 COMBINE-MEDIA-PROFILE API TESTING');
    console.log('━'.repeat(80));
    console.log(`\n📋 Configuration:`);
    console.log(`   API Base URL: ${API_BASE_URL}`);
    console.log(`   Image: ${IMAGE_PATH}`);
    console.log(`   Top Headline: ${TOP_HEADLINE}`);
    console.log(`   Subtitle: ${SUBTITLE}`);
    console.log(`   Bottom Headline: ${BOTTOM_HEADLINE || '(empty)'}`);
    console.log(`   Duration: ${VIDEO_DURATION}s`);
    console.log(`   Profiles to test: ${PROFILES.length}`);
    console.log(`   Output directory: ${OUTPUT_DIR}\n`);

    // Step 1: Generate dummy audio
    let audioPath;
    try {
        audioPath = await generateDummyAudio();
    } catch (error) {
        console.error('\n❌ Failed to generate audio. Exiting.');
        process.exit(1);
    }

    // Step 2: Test each profile
    const results = [];

    for (const profileId of PROFILES) {
        const result = await testProfile(profileId, audioPath);
        results.push(result);

        // Wait a bit between requests to avoid overwhelming the server
        if (profileId !== PROFILES[PROFILES.length - 1]) {
            console.log('\n⏳ Waiting 2 seconds before next test...');
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
    }

    // Step 3: Print summary
    console.log('\n' + '━'.repeat(80));
    console.log('📊 TEST SUMMARY');
    console.log('━'.repeat(80) + '\n');

    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    console.log(`Total tests: ${results.length}`);
    console.log(`✅ Passed: ${successCount}`);
    console.log(`❌ Failed: ${failCount}\n`);

    if (successCount > 0) {
        console.log('✅ Successful tests:');
        results.filter(r => r.success).forEach(r => {
            console.log(`   - ${r.profileId}: ${r.videoUrl} (${r.duration}s)`);
        });
        console.log('');
    }

    if (failCount > 0) {
        console.log('❌ Failed tests:');
        results.filter(r => !r.success).forEach(r => {
            console.log(`   - ${r.profileId}: ${r.error}`);
        });
        console.log('');
    }

    console.log('💡 Next steps:');
    console.log('   1. Check the output videos in the URLs above');
    console.log('   2. Verify visual differences between profiles');
    console.log('   3. Check headline colors and fonts\n');

    // Exit with appropriate code
    process.exit(failCount > 0 ? 1 : 0);
}

// Run main function
main().catch(error => {
    console.error('\n💥 Fatal error:', error);
    process.exit(1);
});
