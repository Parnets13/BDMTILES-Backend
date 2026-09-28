import fs from 'fs';
import PDFDocument from 'pdfkit';

/**
 * HR document generation (Offer Letter, Appointment Letter, NDA, etc.) from a
 * template's {{variable}} content. Mirrors the branded look of dealerPdfService.js
 * but writes to disk (into private-uploads/hr-documents) instead of streaming
 * straight to the HTTP response, because the generated file is then attached to
 * Employee.documents and needs to be re-downloadable later.
 */
const BRAND = '#FF5F03';
const INK = '#0F172A';
const MUTED = '#64748B';
const LINE = '#E2E8F0';

// Replace every {{variableName}} occurrence with the matching value from `data`.
// Unmatched placeholders are left as literal text (visible, not silently blanked)
// so a missing field is obvious in the preview rather than producing a gap.
export function renderTemplate(content, data = {}) {
  return String(content || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key) => {
    const value = data[key];
    return value === undefined || value === null || value === '' ? match : String(value);
  });
}

// Extract every {{variableName}} token referenced in a template's content.
export function extractVariables(content) {
  const matches = String(content || '').matchAll(/\{\{\s*([\w.]+)\s*\}\}/g);
  return [...new Set([...matches].map((m) => m[1]))];
}

function header(doc, title) {
  doc.rect(0, 0, doc.page.width, 92).fill(BRAND);
  doc.fillColor('#FFFFFF').fontSize(20).font('Helvetica-Bold').text('BDMTILES', 40, 28);
  doc.fontSize(8).font('Helvetica').text('BDM GRANIMARMO PRIVATE LIMITED', 40, 54);
  doc.fontSize(15).font('Helvetica-Bold').text(title, 40, 26, { width: doc.page.width - 80, align: 'right' });
  doc.fillColor(INK);
  doc.y = 118;
}

function footer(doc) {
  const y = doc.page.height - 58;
  doc.moveTo(40, y).lineTo(doc.page.width - 40, y).strokeColor(LINE).lineWidth(1).stroke();
  doc.fontSize(7.5).fillColor(MUTED).font('Helvetica')
    .text(`Generated ${new Date().toLocaleString('en-IN')}`, 40, y + 8, { width: doc.page.width - 80, align: 'center' });
}

// Renders the (already-substituted) plain-text content as paragraphs, writes the
// PDF to `filePath`, and resolves once the file is fully flushed to disk.
export function generateHrDocumentPdf({ filePath, title, renderedContent }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 40 });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    header(doc, title);

    doc.fontSize(10.5).font('Helvetica').fillColor(INK);
    String(renderedContent || '').split(/\n{2,}/).forEach((paragraph) => {
      if (doc.y > doc.page.height - 100) { doc.addPage(); doc.y = 50; }
      doc.text(paragraph.trim(), 40, doc.y, { width: doc.page.width - 80, align: 'left', lineGap: 4 });
      doc.moveDown(1);
    });

    footer(doc);
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
}
