// Temporary script to inspect save file for clusterio modules
const fs = require('fs');
const path = require('path');

const savePath = process.argv[2] || '/clusterio/data/instances/clusterio-host-1-instance-1/saves/_autosave_po1.zip';

// Use Node's built-in zlib + manual ZIP parsing, or just use child_process
const { execSync } = require('child_process');

// Simple approach: read the ZIP central directory with node
const buf = fs.readFileSync(savePath);

// Find end of central directory record
let eocdOffset = -1;
for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
        eocdOffset = i;
        break;
    }
}

if (eocdOffset === -1) {
    console.error('Not a valid ZIP file');
    process.exit(1);
}

const cdOffset = buf.readUInt32LE(eocdOffset + 16);
const cdSize = buf.readUInt32LE(eocdOffset + 12);
const totalEntries = buf.readUInt16LE(eocdOffset + 10);

console.log(`Total entries: ${totalEntries}`);
console.log('---');

let offset = cdOffset;
const files = [];
for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break;
    const fnLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const fileName = buf.toString('utf8', offset + 46, offset + 46 + fnLen);
    files.push(fileName);
    offset += 46 + fnLen + extraLen + commentLen;
}

// Print files matching clusterio or surface_export
const matches = files.filter(f => /clusterio|surface_export|module/i.test(f));
if (matches.length > 0) {
    console.log('Matching files (clusterio/surface_export/module):');
    matches.forEach(f => console.log('  ' + f));
} else {
    console.log('NO clusterio/surface_export/module files found in save!');
}

console.log('\n--- All files ---');
files.forEach(f => console.log(f));
