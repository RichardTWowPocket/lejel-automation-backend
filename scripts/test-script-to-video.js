#!/usr/bin/env node

/**
 * Test script for script-to-video API
 *
 * Usage:
 *   # Script from env
 *   FULL_SCRIPT="Your full script here..." node scripts/test-script-to-video.js
 *
 *   # Script from file
 *   node scripts/test-script-to-video.js path/to/script.txt
 *   node scripts/test-script-to-video.js --file path/to/script.txt
 *
 *   # Async (default): returns jobId, then polls until done and prints URL
 *   node scripts/test-script-to-video.js path/to/script.txt
 *
 *   # Sync (wait for full pipeline, may timeout on long scripts)
 *   SYNC=1 node scripts/test-script-to-video.js path/to/script.txt
 *
 * Env: API_BASE_URL (default http://localhost:3001), API_KEY (required for backend)
 */

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const API_KEY = process.env.API_KEY || '';
const SYNC = process.env.SYNC === '1' || process.env.SYNC === 'true';
const POLL_INTERVAL_MS = 10000; // 10 seconds
const POLL_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour for many segments

function getScript() {
  const fromEnv = process.env.FULL_SCRIPT;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();

  const args = process.argv.slice(2);
  let filePath = null;
  if (args[0] === '--file' && args[1]) {
    filePath = args[1];
  } else if (args[0] && !args[0].startsWith('--')) {
    filePath = args[0];
  }
  if (filePath) {
    const abs = path.isAbsolute(filePath) ? filePath : path.join(process.cwd(), filePath);
    if (fs.existsSync(abs)) {
      return fs.readFileSync(abs, 'utf8').trim();
    }
    console.error('File not found:', abs);
    process.exit(1);
  }

  console.error('Provide script via FULL_SCRIPT env or: node script path/to/script.txt');
  process.exit(1);
}

async function pollJobUntilComplete(jobId) {
  const started = Date.now();
  while (Date.now() - started < POLL_TIMEOUT_MS) {
    const res = await axios.get(`${API_BASE_URL}/api/job/${jobId}/status`, {
      headers: API_KEY ? { 'x-api-key': API_KEY } : {},
      timeout: 15000,
    });
    const { status, result, error } = res.data;
    console.log(`  Job ${jobId} status: ${status}`);
    if (status === 'completed') {
      return result?.url || null;
    }
    if (status === 'failed') {
      throw new Error(error || 'Job failed');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error('Poll timeout');
}

async function main() {
  const fullScript = getScript();
  console.log('Script length:', fullScript.length, 'chars');
  console.log('API:', API_BASE_URL);
  console.log('Mode:', SYNC ? 'sync' : 'async (poll for result)');
  console.log('');

  const headers = { 'Content-Type': 'application/json' };
  if (API_KEY) headers['x-api-key'] = API_KEY;

  try {
    const payload = {
      fullScript: fullScript,
      asyncMode: SYNC ? 'no' : 'yes',
      returnUrl: 'yes',
      profile: 'default',
    };

    const response = await axios.post(`${API_BASE_URL}/api/script-to-video`, payload, {
      headers,
      timeout: SYNC ? 600000 : 30000,
    });

    if (SYNC) {
      const url = typeof response.data === 'string' ? response.data : response.data?.url;
      console.log('Done. Video URL:', url || response.data);
      return;
    }

    if (response.status !== 202) {
      console.log('Unexpected status:', response.status, response.data);
      return;
    }

    const { jobId, status } = response.data;
    console.log('Job created:', jobId, status);
    console.log('Polling for completion (interval', POLL_INTERVAL_MS / 1000, 's)...');
    const url = await pollJobUntilComplete(jobId);
    console.log('');
    console.log('Video URL:', url);
  } catch (err) {
    console.error('Error:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
}

main();
