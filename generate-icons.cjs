const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const iconsDir = path.join(__dirname, 'src-tauri', 'icons');
const svgPath = path.join(iconsDir, 'logo-simple.svg');

function buildIco(pngBuffers) {
  const numImages = pngBuffers.length;
  const headerSize = 6 + (numImages * 16);
  let offset = headerSize;
  const entries = pngBuffers.map(buf => {
    const entry = { offset, data: buf };
    offset += buf.length;
    return entry;
  });
  const ico = Buffer.alloc(offset);
  ico.writeUInt16LE(0, 0);
  ico.writeUInt16LE(1, 2);
  ico.writeUInt16LE(numImages, 4);
  entries.forEach((entry, i) => {
    const base = 6 + (i * 16);
    const width = entry.data.readUInt32BE(16);
    const height = entry.data.readUInt32BE(20);
    ico.writeUInt8(width >= 256 ? 0 : width, base);
    ico.writeUInt8(height >= 256 ? 0 : height, base + 1);
    ico.writeUInt8(0, base + 2);
    ico.writeUInt8(0, base + 3);
    ico.writeUInt16LE(1, base + 4);
    ico.writeUInt16LE(32, base + 6);
    ico.writeUInt32LE(entry.data.length, base + 8);
    ico.writeUInt32LE(entry.offset, base + 12);
    entry.data.copy(ico, entry.offset);
  });
  return ico;
}

async function run() {
  const svgBuffer = fs.readFileSync(svgPath);
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngSizes = [
    ['32x32.png', 32], ['128x128.png', 128], ['128x128@2x.png', 256], ['icon.png', 512],
    ['Square30x30Logo.png', 30], ['Square44x44Logo.png', 44], ['Square71x71Logo.png', 71],
    ['Square89x89Logo.png', 89], ['Square107x107Logo.png', 107], ['Square142x142Logo.png', 142],
    ['Square150x150Logo.png', 150], ['Square284x284Logo.png', 284], ['Square310x310Logo.png', 310],
    ['StoreLogo.png', 50]
  ];

  console.log('Generating PNGs...');
  const icoBuffers = [];
  const allSizes = [...new Set([...icoSizes, ...pngSizes.map(s => s[1])])].sort((a,b) => a-b);
  
  const generated = {};
  for (const size of allSizes) {
    const buf = await sharp(svgBuffer, { density: 300 })
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png().toBuffer();
    generated[size] = buf;
    console.log('  ' + size + 'x' + size);
  }

  // Write named PNGs
  for (const [name, size] of pngSizes) {
    fs.writeFileSync(path.join(iconsDir, name), generated[size]);
  }

  // Build ICO
  const icoBufs = icoSizes.map(s => generated[s]).filter(Boolean);
  const ico = buildIco(icoBufs);
  fs.writeFileSync(path.join(iconsDir, 'icon.ico'), ico);

  // Copy favicon
  fs.copyFileSync(path.join(iconsDir, 'icon.png'), path.join(__dirname, 'public', 'favicon.png'));

  console.log('All done! ' + icoBufs.length + ' images in ICO, ' + pngSizes.length + ' PNGs');
}

run().catch(e => { console.error(e); process.exit(1); });
