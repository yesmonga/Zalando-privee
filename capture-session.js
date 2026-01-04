#!/usr/bin/env node
/**
 * Akamai Session Capture Helper
 * 
 * This script helps parse and upload session data from iOS app traffic.
 * 
 * Usage:
 *   node capture-session.js <raw_headers_file>
 *   node capture-session.js --interactive
 *   node capture-session.js --paste
 * 
 * The script will extract:
 *   - Akamai cookies (_abck, ak_bmsc, bm_sz)
 *   - X-acf-sensor-data header
 *   - Authorization token
 * 
 * And automatically update the server session.
 */

const http = require('http');

const SERVER_URL = 'http://localhost:3000';

function parseHeaders(rawText) {
  const result = {
    cookies: {},
    sensorData: null,
    authorization: null
  };

  const lines = rawText.split('\n');
  
  for (const line of lines) {
    const trimmed = line.trim();
    
    // Parse Cookie header
    if (trimmed.toLowerCase().startsWith('cookie:')) {
      const cookieValue = trimmed.substring(7).trim();
      const cookies = cookieValue.split(';');
      
      for (const cookie of cookies) {
        const [name, ...valueParts] = cookie.split('=');
        const value = valueParts.join('=').trim();
        const cookieName = name.trim();
        
        if (cookieName === '_abck') result.cookies._abck = value;
        if (cookieName === 'ak_bmsc') result.cookies.ak_bmsc = value;
        if (cookieName === 'bm_sz') result.cookies.bm_sz = value;
      }
    }
    
    // Parse X-acf-sensor-data header
    if (trimmed.toLowerCase().startsWith('x-acf-sensor-data:')) {
      result.sensorData = trimmed.substring(18).trim();
    }
    
    // Also try without the colon (just the value on a line by itself)
    if (trimmed.startsWith('4,i,') && trimmed.includes('$')) {
      result.sensorData = trimmed;
    }
    
    // Parse Authorization header
    if (trimmed.toLowerCase().startsWith('authorization:')) {
      result.authorization = trimmed.substring(14).trim();
    }
  }
  
  return result;
}

function parseSensorData(sensorData) {
  if (!sensorData) return null;
  
  const parts = sensorData.split('$');
  if (parts.length < 3) return null;
  
  const headerParts = parts[0].split(',');
  const counters = parts[2] ? parts[2].split(',').map(Number) : [];
  
  return {
    version: headerParts[0],
    type: headerParts[1],
    deviceFP1: headerParts[2] ? headerParts[2].substring(0, 30) + '...' : null,
    deviceFP2: headerParts[3] ? headerParts[3].substring(0, 30) + '...' : null,
    payloadLength: parts[1] ? parts[1].length : 0,
    counters: counters,
    suffix: parts[parts.length - 1] ? parts[parts.length - 1].substring(0, 30) + '...' : null
  };
}

async function updateServer(sessionData) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      cookies: sessionData.cookies,
      sensorData: sessionData.sensorData
    });
    
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/config/session',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Failed to parse server response'));
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function testAddToCart() {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      configSku: 'TEST-SKU',
      simpleSku: 'TEST-SIMPLE-SKU',
      campaignId: 'test-campaign',
      useAkamai: true
    });
    
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/test/addtocart',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    };
    
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(body) });
        } catch (e) {
          resolve({ status: res.statusCode, body: body });
        }
      });
    });
    
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function interactiveMode() {
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  console.log('\n=== AKAMAI SESSION CAPTURE ===\n');
  console.log('Paste the raw headers from iOS app traffic.');
  console.log('Include Cookie and X-acf-sensor-data headers.');
  console.log('Press Enter twice when done.\n');
  
  let input = '';
  let emptyLineCount = 0;
  
  return new Promise((resolve) => {
    rl.on('line', (line) => {
      if (line.trim() === '') {
        emptyLineCount++;
        if (emptyLineCount >= 2) {
          rl.close();
          resolve(input);
        }
      } else {
        emptyLineCount = 0;
        input += line + '\n';
      }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  let rawText = '';
  
  if (args.includes('--interactive') || args.includes('--paste')) {
    rawText = await interactiveMode();
  } else if (args.length > 0) {
    const fs = require('fs');
    rawText = fs.readFileSync(args[0], 'utf8');
  } else {
    console.log('Usage:');
    console.log('  node capture-session.js <file>        - Parse headers from file');
    console.log('  node capture-session.js --interactive - Enter headers interactively');
    console.log('  node capture-session.js --paste       - Paste headers');
    process.exit(1);
  }
  
  console.log('\n=== PARSING SESSION DATA ===\n');
  
  const sessionData = parseHeaders(rawText);
  
  // Display what we found
  console.log('Cookies found:');
  console.log(`  _abck:    ${sessionData.cookies._abck ? '✅ ' + sessionData.cookies._abck.substring(0, 50) + '...' : '❌ Not found'}`);
  console.log(`  ak_bmsc:  ${sessionData.cookies.ak_bmsc ? '✅ ' + sessionData.cookies.ak_bmsc.substring(0, 50) + '...' : '❌ Not found'}`);
  console.log(`  bm_sz:    ${sessionData.cookies.bm_sz ? '✅ ' + sessionData.cookies.bm_sz.substring(0, 50) + '...' : '❌ Not found'}`);
  
  console.log('\nSensor Data:');
  if (sessionData.sensorData) {
    const parsed = parseSensorData(sessionData.sensorData);
    console.log(`  ✅ Found (${sessionData.sensorData.length} chars)`);
    if (parsed) {
      console.log(`     Version: ${parsed.version}, Type: ${parsed.type}`);
      console.log(`     Counters: ${parsed.counters.join(', ')}`);
      console.log(`     Payload length: ${parsed.payloadLength} chars`);
    }
  } else {
    console.log('  ❌ Not found');
  }
  
  if (sessionData.authorization) {
    console.log(`\nAuthorization: ✅ Found`);
  }
  
  // Check if we have enough data
  const hasCookies = sessionData.cookies._abck || sessionData.cookies.ak_bmsc || sessionData.cookies.bm_sz;
  const hasSensor = !!sessionData.sensorData;
  
  if (!hasCookies && !hasSensor) {
    console.log('\n❌ No session data found. Make sure to include Cookie and X-acf-sensor-data headers.');
    process.exit(1);
  }
  
  // Update server
  console.log('\n=== UPDATING SERVER ===\n');
  
  try {
    const result = await updateServer(sessionData);
    console.log('Server response:', JSON.stringify(result, null, 2));
    
    if (result.success) {
      console.log('\n✅ Session data updated successfully!');
      
      // Test the session
      console.log('\n=== TESTING SESSION ===\n');
      const testResult = await testAddToCart();
      console.log('Test result:', JSON.stringify(testResult, null, 2));
      
      if (testResult.body && testResult.body.result && testResult.body.result.error) {
        if (testResult.body.result.error.includes('403')) {
          console.log('\n⚠️  Session still getting 403. Possible reasons:');
          console.log('   - Sensor data is stale (needs to be fresh from same request)');
          console.log('   - Cookies don\'t match the sensor data session');
          console.log('   - Counter values are out of sync');
        }
      }
    }
  } catch (error) {
    console.error('Failed to update server:', error.message);
    console.log('Make sure the server is running on port 3000');
  }
}

main().catch(console.error);
