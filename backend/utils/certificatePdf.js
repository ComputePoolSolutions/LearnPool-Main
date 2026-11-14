/**
 * Builds the LearnPool "Certificate of Completion" as a real PDF (A4 landscape) with pdfkit.
 * Only pdfkit's built-in fonts are used, so there is nothing extra to install.
 */
const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const GREEN = '#2f5b45', GREEN_LIGHT = '#e9f1ec', GOLD = '#b39a55', INK = '#25362c', MUTED = '#6a766e';
const storageDir = path.join(__dirname, '..', 'storage', 'certificates');

// The built-in PDF fonts only cover Western characters; anything else would print as garbage.
const safe = value => String(value ?? '').replace(/[^\x20-\x7E\u00A0-\u00FF\u2018\u2019\u201C\u201D\u2013\u2014\u2026]/g, '?').trim();
const longDate = value => { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }); };

// Shrink a line until it fits the available width.
function fit(doc, text, font, max, min, width) {
  let size = max;
  doc.font(font);
  while (size > min && doc.fontSize(size).widthOfString(text) > width) size -= 1;
  return size;
}

function draw(doc, c) {
  const W = doc.page.width, H = doc.page.height, mid = W / 2;
  const name = safe(c.recipientName) || 'LearnPool Learner';
  const course = safe(c.courseName) || 'LearnPool Course';
  const instructor = safe(c.instructorName) || 'LearnPool Instructor';
  const verifyUrl = `${(process.env.PUBLIC_APP_URL || 'http://localhost:5173').replace(/\/$/, '')}/verify-certificate/${c.certificateNumber}`;

  // frame: soft tint, double border and corner accents
  doc.rect(0, 0, W, H).fill('#ffffff');
  doc.lineWidth(3).rect(18, 18, W - 36, H - 36).stroke(GREEN);
  doc.lineWidth(0.8).rect(28, 28, W - 56, H - 56).stroke(GOLD);
  for (const [x, y, dx, dy] of [[40, 40, 1, 1], [W - 40, 40, -1, 1], [40, H - 40, 1, -1], [W - 40, H - 40, -1, -1]]) {
    doc.lineWidth(2).moveTo(x, y + dy * 26).lineTo(x, y).lineTo(x + dx * 26, y).stroke(GOLD);
  }

  // logo: green rounded mark with an L, then the wordmark
  doc.roundedRect(mid - 20, 52, 40, 40, 9).fill(GREEN);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(24).text('L', mid - 20, 59, { width: 40, align: 'center' });
  doc.fillColor(GREEN).font('Times-Bold').fontSize(17).text('LearnPool', 0, 99, { width: W, align: 'center', characterSpacing: 2 });

  // title
  doc.fillColor(GREEN).font('Times-Bold').fontSize(34).text('CERTIFICATE OF COMPLETION', 0, 138, { width: W, align: 'center', characterSpacing: 2 });
  doc.lineWidth(0.8).moveTo(mid - 110, 187).lineTo(mid - 10, 187).stroke(GOLD);
  doc.lineWidth(0.8).moveTo(mid + 10, 187).lineTo(mid + 110, 187).stroke(GOLD);
  doc.moveTo(mid, 182).lineTo(mid + 5, 187).lineTo(mid, 192).lineTo(mid - 5, 187).closePath().fill(GOLD);

  // body
  doc.fillColor(MUTED).font('Helvetica').fontSize(13).text('This certificate is proudly presented to', 0, 208, { width: W, align: 'center' });
  const nameSize = fit(doc, name, 'Times-BoldItalic', 42, 20, W - 200);
  doc.fillColor(INK).font('Times-BoldItalic').fontSize(nameSize).text(name, 80, 232, { width: W - 160, align: 'center' });
  doc.lineWidth(0.7).moveTo(mid - 190, 288).lineTo(mid + 190, 288).stroke('#c3cdc5');
  doc.fillColor(MUTED).font('Helvetica').fontSize(13).text('for successfully completing the course', 0, 304, { width: W, align: 'center' });
  const courseSize = fit(doc, course, 'Times-Bold', 26, 14, W - 200);
  doc.fillColor(GREEN).font('Times-Bold').fontSize(courseSize).text(course, 80, 328, { width: W - 160, align: 'center' });
  doc.fillColor(MUTED).font('Helvetica').fontSize(13).text('on LearnPool', 0, 366, { width: W, align: 'center' });
  if (c.completedAt) doc.fillColor(MUTED).font('Helvetica').fontSize(11).text(`Course completed on ${longDate(c.completedAt)}`, 0, 388, { width: W, align: 'center' });

  // signature area, seal and issue date
  const lineY = 468;
  doc.lineWidth(0.8).moveTo(90, lineY).lineTo(290, lineY).stroke(INK);
  doc.fillColor(INK).font('Times-Italic').fontSize(17).text(instructor, 90, lineY - 26, { width: 200, align: 'center' });
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('COURSE INSTRUCTOR  ·  VERIFIED', 90, lineY + 7, { width: 200, align: 'center', characterSpacing: 1 });

  doc.lineWidth(2.5).circle(mid, 452, 38).fillAndStroke(GREEN_LIGHT, GREEN);
  doc.lineWidth(0.8).circle(mid, 452, 31).stroke(GOLD);
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9).text('LEARNPOOL', mid - 30, 436, { width: 60, align: 'center', characterSpacing: 1 });
  doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(16).text('VERIFIED', mid - 30, 449, { width: 60, align: 'center' });

  doc.lineWidth(0.8).moveTo(W - 290, lineY).lineTo(W - 90, lineY).stroke(INK);
  doc.fillColor(INK).font('Times-Roman').fontSize(16).text(longDate(c.issuedAt), W - 290, lineY - 25, { width: 200, align: 'center' });
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('DATE OF ISSUE', W - 290, lineY + 7, { width: 200, align: 'center', characterSpacing: 1 });

  // identity and verification
  doc.fillColor(MUTED).font('Helvetica').fontSize(9).text(`Certificate ID: ${c.certificateNumber}`, 0, H - 74, { width: W, align: 'center', characterSpacing: 0.5 });
  doc.fillColor(MUTED).font('Helvetica').fontSize(8).text(`Verify this certificate at ${verifyUrl}`, 0, H - 60, { width: W, align: 'center' });
}

// Renders the certificate and returns the PDF bytes.
function renderCertificate(c) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 0, info: { Title: `Certificate ${c.certificateNumber}`, Author: 'LearnPool', Subject: 'Certificate of Completion' } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    try { draw(doc, c); doc.end(); } catch (error) { reject(error); }
  });
}

const fileFor = certificateNumber => path.join(storageDir, `${String(certificateNumber).replace(/[^A-Za-z0-9_-]/g, '_')}.pdf`);

// Renders and saves the PDF; returns { file, buffer }.
async function generateCertificateFile(c) {
  const buffer = await renderCertificate(c);
  fs.mkdirSync(storageDir, { recursive: true });
  const file = fileFor(c.certificateNumber);
  fs.writeFileSync(file, buffer);
  return { file, buffer };
}

module.exports = { renderCertificate, generateCertificateFile, fileFor, storageDir, longDate };
