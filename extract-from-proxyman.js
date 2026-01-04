#!/usr/bin/env node
/**
 * Extract Akamai session data from Proxyman capture file
 */

const fs = require('fs');
const http = require('http');

const FILE_PATH = '/Users/alex/CascadeProjects/zalando-prive/new requete ios';

function extractData() {
  console.log('=== EXTRACTION DES DONNÉES AKAMAI ===\n');
  
  const raw = fs.readFileSync(FILE_PATH);
  const text = raw.toString('utf8', 0, raw.length);
  
  // Extract cookies
  const cookieMatch = text.match(/Cookie:[^\n]*_abck=([^;~]+~[^;]+)/);
  const akBmscMatch = text.match(/ak_bmsc=([^;]+)/);
  const bmSzMatch = text.match(/bm_sz=([^;\s]+)/);
  
  // Extract sensor data (starts with device fingerprint and has $counters$)
  const sensorMatch = text.match(/4,i,([A-Za-z0-9+/=]+,[A-Za-z0-9+/=]+\$[^\s]+\$\d+,\d+,\d+\$\$\$[A-Za-z0-9%+/=]+)/);
  
  // Extract authorization
  const authMatch = text.match(/Authorization:\s*(Bearer\s+[A-Za-z0-9._-]+)/);
  
  const result = {
    cookies: {
      _abck: null,
      ak_bmsc: null,
      bm_sz: null
    },
    sensorData: null,
    authorization: null
  };
  
  // Parse cookies from the full cookie string
  const fullCookieMatch = text.match(/Cookie:\s*([^\n]+)/g);
  if (fullCookieMatch) {
    for (const cookieLine of fullCookieMatch) {
      const abckM = cookieLine.match(/_abck=([^;\s]+)/);
      const akM = cookieLine.match(/ak_bmsc=([^;\s]+)/);
      const bzM = cookieLine.match(/bm_sz=([^;\s]+)/);
      
      if (abckM && !result.cookies._abck) result.cookies._abck = abckM[1];
      if (akM && !result.cookies.ak_bmsc) result.cookies.ak_bmsc = akM[1];
      if (bzM && !result.cookies.bm_sz) result.cookies.bm_sz = bzM[1];
    }
  }
  
  // Find sensor data
  const sensorRegex = /4,i,[A-Za-z0-9+/=]+,[A-Za-z0-9+/=]+\$[^\$]+\$\d+,\d+,\d+\$\$\$[A-Za-z0-9%+/=]+/g;
  const sensorMatches = text.match(sensorRegex);
  if (sensorMatches && sensorMatches.length > 0) {
    // Get the last (most recent) sensor data
    result.sensorData = sensorMatches[sensorMatches.length - 1];
  }
  
  if (authMatch) {
    result.authorization = authMatch[1];
  }
  
  // Display results
  console.log('COOKIES:');
  console.log(`  _abck:   ${result.cookies._abck ? '✅ ' + result.cookies._abck.substring(0, 60) + '...' : '❌'}`);
  console.log(`  ak_bmsc: ${result.cookies.ak_bmsc ? '✅ ' + result.cookies.ak_bmsc.substring(0, 60) + '...' : '❌'}`);
  console.log(`  bm_sz:   ${result.cookies.bm_sz ? '✅ ' + result.cookies.bm_sz.substring(0, 60) + '...' : '❌'}`);
  
  console.log('\nSENSOR DATA:');
  if (result.sensorData) {
    console.log(`  ✅ Found (${result.sensorData.length} chars)`);
    // Parse counters
    const counterMatch = result.sensorData.match(/\$(\d+,\d+,\d+)\$\$\$/);
    if (counterMatch) {
      console.log(`  Counters: ${counterMatch[1]}`);
    }
  } else {
    console.log('  ❌ Not found');
  }
  
  console.log('\nAUTHORIZATION:');
  console.log(`  ${result.authorization ? '✅ Found' : '❌ Not found'}`);
  
  return result;
}

async function updateToken(token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ token });
    
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/config/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Invalid response: ' + body));
        }
      });
    });
    
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function updateServer(data) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      cookies: data.cookies,
      sensorData: data.sensorData
    });
    
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/config/session',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error('Invalid response: ' + body));
        }
      });
    });
    
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function testCart() {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      configSku: 'TEST',
      simpleSku: 'TEST',
      campaignId: 'test',
      useAkamai: true
    });
    
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: '/api/test/addtocart',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
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
    req.write(payload);
    req.end();
  });
}

async function main() {
  try {
    const data = extractData();
    
    if (!data.cookies._abck && !data.sensorData) {
      console.log('\n❌ Aucune donnée Akamai trouvée dans le fichier');
      return;
    }
    
    console.log('\n=== MISE À JOUR DU SERVEUR ===\n');
    
    // Update session (cookies + sensor)
    const result = await updateServer(data);
    console.log('Session:', JSON.stringify(result, null, 2));
    
    // Update token if found
    if (data.authorization) {
      const tokenResult = await updateToken(data.authorization);
      console.log('Token:', JSON.stringify(tokenResult, null, 2));
    }
    
    if (result.success) {
      console.log('\n✅ Session mise à jour!');
      
      console.log('\n=== TEST ADD TO CART ===\n');
      const testResult = await testCart();
      console.log('Résultat:', JSON.stringify(testResult, null, 2));
      
      if (testResult.body?.result?.error?.includes('403')) {
        console.log('\n⚠️  Encore 403 - les données sont peut-être périmées');
        console.log('   Refais une capture fraîche depuis l\'app iOS');
      } else if (testResult.body?.result?.success || testResult.status === 200) {
        console.log('\n✅ Session Akamai valide!');
      }
    }
  } catch (error) {
    console.error('Erreur:', error.message);
  }
}

main();
