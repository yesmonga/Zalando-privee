#!/usr/bin/env node
/**
 * Test if Akamai sensor data can be reused or manipulated
 * 
 * Tests:
 * 1. Can we reuse the same sensor data multiple times?
 * 2. Can we modify counters to extend validity?
 * 3. What's the time window for sensor data validity?
 */

const https = require('https');

// Test configuration - update these with fresh values from iOS app
const TEST_CONFIG = {
  // Akamai cookies (from Cookie header)
  cookies: {
    _abck: '',  // Fill from iOS traffic
    ak_bmsc: '', // Fill from iOS traffic
    bm_sz: ''   // Fill from iOS traffic
  },
  // Sensor data (from X-acf-sensor-data header)
  sensorData: '',  // Fill from iOS traffic
  // Auth token
  authorization: '' // Fill from iOS traffic
};

// Cart request payload
const CART_PAYLOAD = {
  campaignIdentifier: 'dd0f1f6b-a86f-453b-a7e6-5cee5e6764db',
  quantity: "1",
  simpleSku: "SK191N01O-C110M0000",
  configSku: "SK191N01O-C11"
};

function modifyCounters(sensorData, c1Delta = 0, c2Delta = 0, c3Delta = 0) {
  const parts = sensorData.split('$');
  if (parts.length < 3) return sensorData;
  
  const counters = parts[2].split(',').map(Number);
  counters[0] += c1Delta;
  counters[1] += c2Delta;
  counters[2] += c3Delta;
  
  parts[2] = counters.join(',');
  return parts.join('$');
}

function makeCartRequest(config, label = 'Test') {
  return new Promise((resolve) => {
    const postData = JSON.stringify(CART_PAYLOAD);
    
    const cookieParts = [];
    if (config.cookies._abck) cookieParts.push(`_abck=${config.cookies._abck}`);
    if (config.cookies.ak_bmsc) cookieParts.push(`ak_bmsc=${config.cookies.ak_bmsc}`);
    if (config.cookies.bm_sz) cookieParts.push(`bm_sz=${config.cookies.bm_sz}`);
    
    const headers = {
      'User-Agent': 'Client/ios-app AppVersion/615 AppVersionName/4.72.1 AppDomain/18 OS/26.2',
      'X-Device-Type': 'smartphone',
      'X-Zalando-Client-Id': '53BEFF53-D469-4DDA-913E-33F4555D2CEE',
      'X-Device-OS': 'iOS',
      'X-Flow-Id': `I${Date.now().toString(16).toUpperCase()}-${Math.random().toString(16).slice(2, 6)}-${Math.floor(Math.random() * 100)}`,
      'X-Sales-Channel': 'a332da49-a665-4a13-bd44-1ecea09b4d86',
      'X-App-Version': '4.72.1',
      'Authorization': config.authorization,
      'Accept': 'application/json,application/problem+json',
      'Content-Type': 'application/json',
      'x-enable-unreserved-cart': 'true'
    };
    
    if (cookieParts.length > 0) {
      headers['Cookie'] = cookieParts.join('; ');
    }
    
    if (config.sensorData) {
      headers['X-acf-sensor-data'] = config.sensorData;
    }
    
    const options = {
      hostname: 'www.zalando-prive.fr',
      port: 443,
      path: '/stockcart/cart/items',
      method: 'POST',
      headers: headers
    };
    
    const startTime = Date.now();
    
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const duration = Date.now() - startTime;
        resolve({
          label,
          status: res.statusCode,
          duration,
          body: body.substring(0, 200)
        });
      });
    });
    
    req.on('error', (e) => {
      resolve({
        label,
        error: e.message,
        status: 0
      });
    });
    
    req.write(postData);
    req.end();
  });
}

async function runTests() {
  console.log('=== SENSOR DATA REUSE TESTS ===\n');
  
  // Check if config is set
  if (!TEST_CONFIG.sensorData || !TEST_CONFIG.authorization) {
    console.log('⚠️  Please fill in TEST_CONFIG with fresh values from iOS app traffic.');
    console.log('\nRequired values:');
    console.log('  - cookies._abck, cookies.ak_bmsc, cookies.bm_sz');
    console.log('  - sensorData (X-acf-sensor-data header)');
    console.log('  - authorization (Bearer token)');
    console.log('\nCapture these from a successful add-to-cart request in the iOS app.');
    return;
  }
  
  const results = [];
  
  // Test 1: Original sensor data
  console.log('Test 1: Original sensor data...');
  results.push(await makeCartRequest(TEST_CONFIG, 'Original'));
  
  // Wait 1 second
  await new Promise(r => setTimeout(r, 1000));
  
  // Test 2: Same sensor data again (reuse test)
  console.log('Test 2: Reusing same sensor data...');
  results.push(await makeCartRequest(TEST_CONFIG, 'Reuse-1'));
  
  // Wait 1 second
  await new Promise(r => setTimeout(r, 1000));
  
  // Test 3: Same sensor data third time
  console.log('Test 3: Third reuse...');
  results.push(await makeCartRequest(TEST_CONFIG, 'Reuse-2'));
  
  // Test 4: Modified counters (increment C1)
  console.log('Test 4: Modified counter C1+1...');
  const modifiedConfig1 = { ...TEST_CONFIG, sensorData: modifyCounters(TEST_CONFIG.sensorData, 1, 0, 0) };
  results.push(await makeCartRequest(modifiedConfig1, 'Counter-C1+1'));
  
  // Test 5: Modified counters (increment C3)
  console.log('Test 5: Modified counter C3+1...');
  const modifiedConfig2 = { ...TEST_CONFIG, sensorData: modifyCounters(TEST_CONFIG.sensorData, 0, 0, 1) };
  results.push(await makeCartRequest(modifiedConfig2, 'Counter-C3+1'));
  
  // Test 6: No sensor data at all
  console.log('Test 6: No sensor data...');
  const noSensorConfig = { ...TEST_CONFIG, sensorData: '' };
  results.push(await makeCartRequest(noSensorConfig, 'No-Sensor'));
  
  // Test 7: No cookies
  console.log('Test 7: No cookies...');
  const noCookiesConfig = { ...TEST_CONFIG, cookies: {} };
  results.push(await makeCartRequest(noCookiesConfig, 'No-Cookies'));
  
  // Display results
  console.log('\n=== RESULTS ===\n');
  console.log('Label'.padEnd(15), 'Status'.padEnd(8), 'Duration'.padEnd(10), 'Response');
  console.log('-'.repeat(80));
  
  for (const r of results) {
    const statusIcon = r.status === 200 || r.status === 201 ? '✅' : '❌';
    console.log(
      r.label.padEnd(15),
      `${statusIcon} ${r.status}`.padEnd(8),
      `${r.duration || 0}ms`.padEnd(10),
      (r.body || r.error || '').substring(0, 40)
    );
  }
  
  console.log('\n=== ANALYSIS ===\n');
  
  const successCount = results.filter(r => r.status === 200 || r.status === 201).length;
  
  if (successCount === 0) {
    console.log('❌ All requests failed. Check if:');
    console.log('   - Authorization token is valid');
    console.log('   - Cookies and sensor data are from the same session');
    console.log('   - Data is fresh (not older than a few minutes)');
  } else if (results[0].status === 200 && results[1].status !== 200) {
    console.log('⚠️  Sensor data can only be used ONCE');
    console.log('   Each request needs fresh sensor data from Akamai SDK');
  } else if (results[0].status === 200 && results[1].status === 200) {
    console.log('✅ Sensor data can be REUSED within a session window!');
    console.log('   This means we can capture once and use multiple times');
  }
}

runTests().catch(console.error);
