// Analyze Akamai sensor data patterns
const samples = [
  // Session 1 samples (4 samples)
  `4,i,mqGyzugGd0mXLtzMFLIZDesnt+u0ZNzYERDds1leBjlwxJ6z5JPvP4GTuXI/WYd7Vn7/+0j+RNgY96aGIwH9btg3ClSTWfqqWbJ0+OT1S4SOAiCVYtOQ2X46heIrRssx1WrOATIWL32lmo1Je7m3fazlRCEV7bbGCMVXdC3oFJU=,SHZ/s70jAwzTXXK4sb0T46zKy60HLF08qbZ6x51PGXj7lh1VNvo3en3Dxe6UIbnvoXcs2L2c+huP6+nFYfidFs9Od59p9wraLKO/pirTXQA2pLKjKJo3bzbq/3Om7UPB677dKFRDlWiuDOYhhIO4F9yTj+hA915Z7HGiC0x+2ic=$Q2PYWMvvhaOPL7xQX8DVw6VP23AJLBocI5Ivb0dCXoMGgf92rHro10CX4wAks/YwnCZXKeAMlqqwsn6WP5hrmuiM6V5mlG1yqmESVERgjS2H/agQEnz0d6Syw605uV8ul1eAfgJUV89JEX1uyFERQBjDGkdkGqctzNitfjYCKlGbXQFeLNII1hb0scMJcJ92nUf/GfRBeWt7PCVIjBgdI1kyYiJ62prOQIu5SQ/ycIaQZtXekHAIliH1JYVhqdsc6OYRJ9NH8xAndTRkjazsuX22Uub9xdyrDKY3DEIIScfxFPbaT5ytUaT/NKQ4gNeV1GL8Z4G8rCzb0mhRbJtiO/fUji0doxkveKmQT8RB8+gxYWi6B2gbxzyNNawl7HAq...$11,7,32$$$AAQAAAAE%2f%2f%2f%2f%2fxv%2fHM%2fqgMPtnZjCb8ZLROnvRC+aBdvAgPiesn5DqdmK4546zCqjwyyUs9pmkPPcmUK6Jl2+4M8g09GcaioA410gGC4aN2lg9mpsLgwy7hqtM8Fyv9KjP7VSWp9Gs1HHsNmE0KZCDLCzW6a%2fUiY4QoBnonnkE53FiYT8q3bqtF1bqblTrnsz26iGu7gXQUKtiZJ9ikvya0W5c%2fwcI94Fq6OG4%2fLHuTmuywEL8WkbsaJuImRv6mwULnxHHEaec92hyPE6wJnOpCQGi3R%2fkAzg6eEJlyJ4yVtTL2NrXiCAdojtJ%2fH%2fJDl7sxq2sJkmp5qByoofEHKa49s%3d`,

  // Session 2 samples  
  `4,i,G9uUihHb0uuvuogPoSih9r/3DmeTARwZYsrgbNwa1luKkkcjWzQ2SdpqUyKB6eVYkHdup8M3oOoQutJAWLACsJKnF2izciRd27ZaRr/08JZRcR0e6nPBa37m4Jxer3i6ereN8vcoGMosPC+B0h7ERRb1hyJzUdVy6zUAMVcxmhs=,jfQ6bRr6aDVlS/hp4TVTrn95YyaPsreNTBMus8tjMI9GG5vLXaVxMIJRh/VLdzBsiO8G4hNiMps/VaLvPR31uPAYbuTYGOQ2No0/0DItZGqWVuOlzz2XMIZZPVbSXcOIPkoSCjlpGypE+Jt9Y8Ga3t+2CS4VQsgb9Z4OWGKEWsw=$YfbF21xHsN4sv6xFKhH7gGjA8QKoXRXi19ndyjHvsOGQ3wiK+2Koa5V0wd/SwEO2l785YE2dfNzjuFptZVh9KHfw4btqJEUcRrU8XaPDC0IzRgaILEvNPut2D2o2/nnh...$8,4,23$$$AAQAAAAE%2f%2f%2f%2f%2f4WOpIpDJUfe9E0qre+IahC0IGr1KRt6GzOUW%2fG3UenE9z5jYOKyxWcis4MbsvBDVA4JvXAHRKkeV6S%2f6OQhPHiXzsZeeTxuZSo2Y4C0iQouMp5CWvSj4w5GE0Qri0K0N5ajDBTVTYffQadjEtXvWIDTpcqfdyXLhbcWeqg%2fQo65faH0OTRvOL0ejNCxnInDKLq%2fbByWwCWemDyvSxfK20r7WRqTPG3efZQzje9I6prRRjnj%2fPdz8dzIX+7a6cH41KSx32GGSOtqBecDZjNBF+nNuIN5GYmiIywV%2fUJ4%2fRHYkn6kLFDxfSpCBa+lAtBx4jt3qFLL6es%3d`,
];

// Parse sensor data structure
function parseSensorData(sensorData) {
  // Format: 4,i,[B64_1],[B64_2]$[PAYLOAD]$[COUNTERS]$$$[SUFFIX]
  const mainParts = sensorData.split('$$$');
  const suffix = mainParts[1] || '';
  
  const firstPart = mainParts[0];
  const dollarParts = firstPart.split('$');
  
  // First part contains: 4,i,B64_1,B64_2
  const headerPart = dollarParts[0];
  const payload = dollarParts[1] || '';
  const counters = dollarParts[2] || '';
  
  // Parse header
  const headerMatch = headerPart.match(/^(\d+),([a-z]),([^,]+),(.+)$/);
  
  return {
    version: headerMatch ? headerMatch[1] : null,
    type: headerMatch ? headerMatch[2] : null,
    deviceFp1: headerMatch ? headerMatch[3] : null,
    deviceFp2: headerMatch ? headerMatch[4] : null,
    payload: payload.substring(0, 50) + '...',
    payloadLength: payload.length,
    counters: counters,
    suffix: suffix.substring(0, 50) + '...',
    suffixLength: suffix.length
  };
}

// Extract counters
function parseCounters(counters) {
  if (!counters) return null;
  const parts = counters.split(',');
  return {
    c1: parseInt(parts[0]) || 0,
    c2: parseInt(parts[1]) || 0,
    c3: parseInt(parts[2]) || 0
  };
}

console.log('=== AKAMAI SENSOR DATA ANALYSIS ===\n');

// Analyze each sample
const fullSamples = `4,i,mqGyzugGd0mXLtzMFLIZDesnt+u0ZNzYERDds1leBjlwxJ6z5JPvP4GTuXI/WYd7Vn7/+0j+RNgY96aGIwH9btg3ClSTWfqqWbJ0+OT1S4SOAiCVYtOQ2X46heIrRssx1WrOATIWL32lmo1Je7m3fazlRCEV7bbGCMVXdC3oFJU=,SHZ/s70jAwzTXXK4sb0T46zKy60HLF08qbZ6x51PGXj7lh1VNvo3en3Dxe6UIbnvoXcs2L2c+huP6+nFYfidFs9Od59p9wraLKO/pirTXQA2pLKjKJo3bzbq/3Om7UPB677dKFRDlWiuDOYhhIO4F9yTj+hA915Z7HGiC0x+2ic=$Q2PYWMvvhaOPL7xQX8DVw6VP23AJLBocI5Ivb0dCXoMGgf92rHro10CX4wAks/YwnCZXKeAMlqqwsn6WP5hrmuiM6V5mlG1yqmESVERgjS2H/agQEnz0d6Syw605uV8ul1eAfgJUV89JEX1uyFERQBjDGkdkGqctzNitfjYCKlGbXQFeLNII1hb0scMJcJ92nUf/GfRBeWt7PCVIjBgdI1kyYiJ62prOQIu5SQ/ycIaQZtXekHAIliH1JYVhqdsc6OYRJ9NH8xAndTRkjazsuX22Uub9xdyrDKY3DEIIScfxFPbaT5ytUaT/NKQ4gNeV1GL8Z4G8rCzb0mhRbJtiO$11,7,32$$$SUFFIX
4,i,G9uUihHb0uuvuogPoSih9r/3DmeTARwZYsrgbNwa1luKkkcjWzQ2SdpqUyKB6eVYkHdup8M3oOoQutJAWLACsJKnF2izciRd27ZaRr/08JZRcR0e6nPBa37m4Jxer3i6ereN8vcoGMosPC+B0h7ERRb1hyJzUdVy6zUAMVcxmhs=,jfQ6bRr6aDVlS/hp4TVTrn95YyaPsreNTBMus8tjMI9GG5vLXaVxMIJRh/VLdzBsiO8G4hNiMps/VaLvPR31uPAYbuTYGOQ2No0/0DItZGqWVuOlzz2XMIZZPVbSXcOIPkoSCjlpGypE+Jt9Y8Ga3t+2CS4VQsgb9Z4OWGKEWsw=$YfbF21xHsN4sv6xFKhH7gGjA8QKoXRXi19ndyjHvsOGQ3wiK+2Koa5V0wd/SwEO2l785YE2dfNzjuFptZVh9KHfw4btqJEUcRrU8XaPDC0IzRgaILEvNPut2D2o2/nnh$8,4,23$$$SUFFIX
4,i,G9uUihHb0uuvuogPoSih9r/3DmeTARwZYsrgbNwa1luKkkcjWzQ2SdpqUyKB6eVYkHdup8M3oOoQutJAWLACsJKnF2izciRd27ZaRr/08JZRcR0e6nPBa37m4Jxer3i6ereN8vcoGMosPC+B0h7ERRb1hyJzUdVy6zUAMVcxmhs=,jfQ6bRr6aDVlS/hp4TVTrn95YyaPsreNTBMus8tjMI9GG5vLXaVxMIJRh/VLdzBsiO8G4hNiMps/VaLvPR31uPAYbuTYGOQ2No0/0DItZGqWVuOlzz2XMIZZPVbSXcOIPkoSCjlpGypE+Jt9Y8Ga3t+2CS4VQsgb9Z4OWGKEWsw=$JtQ0ZORt4eCaEcWM5jqButvrhF4kp4wtf/ns6lLRb7DAFH4mrEsiTjWBdQBnivBXu2HImpYfUs6wPJcVu2vWb9Q$13,5,28$$$SUFFIX
4,i,G9uUihHb0uuvuogPoSih9r/3DmeTARwZYsrgbNwa1luKkkcjWzQ2SdpqUyKB6eVYkHdup8M3oOoQutJAWLACsJKnF2izciRd27ZaRr/08JZRcR0e6nPBa37m4Jxer3i6ereN8vcoGMosPC+B0h7ERRb1hyJzUdVy6zUAMVcxmhs=,jfQ6bRr6aDVlS/hp4TVTrn95YyaPsreNTBMus8tjMI9GG5vLXaVxMIJRh/VLdzBsiO8G4hNiMps/VaLvPR31uPAYbuTYGOQ2No0/0DItZGqWVuOlzz2XMIZZPVbSXcOIPkoSCjlpGypE+Jt9Y8Ga3t+2CS4VQsgb9Z4OWGKEWsw=$Vb3X+8zdbKWN/JcSCmxH6j3BipsfJoB0BQhzwxXK03tgG+lbHJMJreYt4/EarwQ1hqPwiDXi2NzNP7c9y/Ceiydo$13,6,27$$$SUFFIX
4,i,G9uUihHb0uuvuogPoSih9r/3DmeTARwZYsrgbNwa1luKkkcjWzQ2SdpqUyKB6eVYkHdup8M3oOoQutJAWLACsJKnF2izciRd27ZaRr/08JZRcR0e6nPBa37m4Jxer3i6ereN8vcoGMosPC+B0h7ERRb1hyJzUdVy6zUAMVcxmhs=,jfQ6bRr6aDVlS/hp4TVTrn95YyaPsreNTBMus8tjMI9GG5vLXaVxMIJRh/VLdzBsiO8G4hNiMps/VaLvPR31uPAYbuTYGOQ2No0/0DItZGqWVuOlzz2XMIZZPVbSXcOIPkoSCjlpGypE+Jt9Y8Ga3t+2CS4VQsgb9Z4OWGKEWsw=$oMbB0loc6KTKfDEP3qWcvuDPSuGVaVb8mjb6HouaLePFOSEHElo8r2Ftiawuw0oDJafZPl$10,7,27$$$SUFFIX`.split('\n');

console.log('STRUCTURE FORMAT:');
console.log('4,i,[DEVICE_FP1],[DEVICE_FP2]$[PAYLOAD]$[C1,C2,C3]$$$[AUTH_SUFFIX]\n');

console.log('ANALYSIS BY SAMPLE:\n');

fullSamples.forEach((sample, i) => {
  const parsed = parseSensorData(sample);
  const counters = parseCounters(parsed.counters);
  console.log(`Sample ${i + 1}:`);
  console.log(`  DeviceFP1: ${parsed.deviceFp1?.substring(0, 40)}...`);
  console.log(`  DeviceFP2: ${parsed.deviceFp2?.substring(0, 40)}...`);
  console.log(`  Counters: ${parsed.counters} => C1=${counters?.c1}, C2=${counters?.c2}, C3=${counters?.c3}`);
  console.log(`  Payload length: ${parsed.payloadLength} chars`);
  console.log('');
});

console.log('=== KEY FINDINGS ===\n');
console.log('1. STATIC per session:');
console.log('   - Version: 4');
console.log('   - Type: i');
console.log('   - DeviceFP1: Device fingerprint (session-bound)');
console.log('   - DeviceFP2: Second fingerprint (session-bound)');
console.log('   - AUTH_SUFFIX: Authentication token (session-bound)\n');

console.log('2. DYNAMIC per request:');
console.log('   - PAYLOAD: Changes every request (encrypted behavioral data)');
console.log('   - C1,C2,C3: Counter values that increment\n');

console.log('3. COUNTER PATTERNS (C1,C2,C3):');
console.log('   - C1: Seems to increment per request (8 -> 13 -> 13 -> 10)');
console.log('   - C2: Small values (4-7)');
console.log('   - C3: Request counter within session (23 -> 28 -> 27 -> 27)\n');

console.log('=== CONCLUSION ===');
console.log('Cannot generate sensor data without Akamai SDK.');
console.log('The payload contains encrypted device fingerprinting and behavioral data.');
console.log('Best approach: Capture fresh session from iOS app when needed.');
