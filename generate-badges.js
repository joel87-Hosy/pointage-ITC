const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const bwipjs = require('bwip-js');
const PDFDocument = require('pdfkit');

const badgesFile = path.join(__dirname, 'badges.json');
const outputDir = path.join(__dirname, 'badge-output');

if (!fs.existsSync(badgesFile)) {
  console.error('Fichier badges.json introuvable.');
  process.exit(1);
}

const badges = JSON.parse(fs.readFileSync(badgesFile, 'utf8'));
if (!Array.isArray(badges) || badges.length === 0) {
  console.error('Aucune entrée valide dans badges.json');
  process.exit(1);
}

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir);
}

async function generate() {
  const pdfPath = path.join(outputDir, 'badges-layout.pdf');
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  doc.pipe(fs.createWriteStream(pdfPath));

  for (let i = 0; i < badges.length; i++) {
    const badge = badges[i];
    const baseName = `${badge.badge_id}-${badge.nom_agent.replace(/\s+/g, '-')}`;
    const qrPath = path.join(outputDir, `${baseName}-qr.png`);
    const barcodePath = path.join(outputDir, `${baseName}-code128.png`);

    await QRCode.toFile(qrPath, badge.badge_id, {
      type: 'png',
      width: 240,
      margin: 0,
    });

    const barcodeBuffer = await bwipjs.toBuffer({
      bcid: 'code128',
      text: badge.badge_id,
      scale: 3,
      height: 50,
      includetext: true,
      textxalign: 'center',
    });
    fs.writeFileSync(barcodePath, barcodeBuffer);

    if (i > 0) {
      doc.addPage();
    }

    const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const cardWidth = 260;
    const cardHeight = 155;
    const x = doc.page.margins.left + (pageWidth - cardWidth) / 2;
    const y = 80;

    // Card background
    doc.roundedRect(x, y, cardWidth, cardHeight, 14).fill('#eef3fb');

    // Header bar
    doc.rect(x, y, cardWidth, 30).fill('#0d47a1');
    doc.fillColor('#ffffff').fontSize(14).font('Helvetica-Bold')
      .text('Badge Agent', x + 14, y + 8);

    // Logo placeholder
    doc.rect(x + cardWidth - 62, y + 8, 44, 14).fill('#ffffff');
    doc.fillColor('#0d47a1').fontSize(8).font('Helvetica-Bold')
      .text('LOGO', x + cardWidth - 60, y + 10, { width: 40, align: 'center' });

    // Body
    const bodyX = x + 14;
    const photoX = x + cardWidth - 78;
    const photoY = y + 44;
    doc.fillColor('#0d47a1').fontSize(10).font('Helvetica-Bold')
      .text('Nom', bodyX, y + 44);
    doc.fillColor('#000').fontSize(16).font('Helvetica-Bold')
      .text(badge.nom_agent, bodyX, y + 58);

    doc.fillColor('#0d47a1').fontSize(10).font('Helvetica-Bold')
      .text('Fonction', bodyX, y + 86);
    doc.fillColor('#000').fontSize(12).font('Helvetica')
      .text(badge.fonction, bodyX, y + 100);

    doc.fillColor('#0d47a1').fontSize(10).font('Helvetica-Bold')
      .text('ID Badge', bodyX, y + 122);
    doc.fillColor('#000').fontSize(12).font('Helvetica')
      .text(badge.badge_id, bodyX, y + 136);

    // Photo placeholder
    doc.rect(photoX, photoY, 60, 70).fill('#ffffff').stroke('#90caf9');
    doc.fillColor('#0d47a1').fontSize(10).font('Helvetica-Bold')
      .text('Photo', photoX, photoY + 28, { width: 60, align: 'center' });

    // Scan areas
    doc.image(qrPath, x + 16, y + 110, { width: 90, height: 90 });
    doc.image(barcodePath, x + 114, y + 110, { width: 128, height: 90 });

    doc.fillColor('#0d47a1').fontSize(9).font('Helvetica')
      .text('Scannez le QR ou le Code 128 avec la caméra', x + 14, y + cardHeight + 8, { width: cardWidth - 28, align: 'center' });

    doc.fillColor('#555').fontSize(8).text('Badge imprimé pour pointage agent — affichage et sortie des présences.', x + 14, y + cardHeight + 24, { width: cardWidth - 28, align: 'center' });
  }

  doc.end();
  console.log('Badge layout généré dans :', outputDir);
  console.log('PDF d exemple :', pdfPath);
}

generate().catch(err => {
  console.error('Erreur de génération :', err);
  process.exit(1);
});
