import PDFDocument from 'pdfkit';

/**
 * Dealer-facing PDF documents (SOW 17.5 invoice download / receipt download).
 * Streams straight to the HTTP response so nothing is written to disk.
 */
const BRAND = '#FF5F03';
const INK = '#0F172A';
const MUTED = '#64748B';
const LINE = '#E2E8F0';

const money = (value) => `Rs. ${Number(value || 0).toLocaleString('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})}`;

const dateStr = (value) => {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

function header(doc, title, subtitle) {
  doc.rect(0, 0, doc.page.width, 92).fill(BRAND);
  doc.fillColor('#FFFFFF').fontSize(20).font('Helvetica-Bold').text('BDMTILES', 40, 28);
  doc.fontSize(8).font('Helvetica').text('BDM GRANIMARMO PRIVATE LIMITED', 40, 54);
  doc.fontSize(15).font('Helvetica-Bold')
    .text(title, 40, 26, { width: doc.page.width - 80, align: 'right' });
  if (subtitle) {
    doc.fontSize(9).font('Helvetica')
      .text(subtitle, 40, 50, { width: doc.page.width - 80, align: 'right' });
  }
  doc.fillColor(INK);
  doc.y = 118;
}

function labelValueGrid(doc, pairs, columns = 2) {
  const startY = doc.y;
  const colWidth = (doc.page.width - 80) / columns;
  pairs.forEach((pair, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = 40 + col * colWidth;
    const y = startY + row * 30;
    doc.fontSize(7.5).fillColor(MUTED).font('Helvetica').text(String(pair[0]).toUpperCase(), x, y);
    doc.fontSize(10).fillColor(INK).font('Helvetica-Bold')
      .text(pair[1] ?? '-', x, y + 11, { width: colWidth - 12 });
  });
  doc.y = startY + Math.ceil(pairs.length / columns) * 30 + 8;
  doc.fillColor(INK);
}

function rule(doc) {
  doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor(LINE).lineWidth(1).stroke();
  doc.y += 12;
}

function sectionTitle(doc, text) {
  doc.fontSize(8).fillColor(MUTED).font('Helvetica-Bold').text(text.toUpperCase(), 40, doc.y);
  doc.y += 14;
  doc.fillColor(INK);
}

function footer(doc, note) {
  const y = doc.page.height - 58;
  doc.moveTo(40, y).lineTo(doc.page.width - 40, y).strokeColor(LINE).lineWidth(1).stroke();
  doc.fontSize(7.5).fillColor(MUTED).font('Helvetica')
    .text(note, 40, y + 8, { width: doc.page.width - 80, align: 'center' });
  doc.text(`Generated ${new Date().toLocaleString('en-IN')}`, 40, y + 20, {
    width: doc.page.width - 80,
    align: 'center',
  });
}

/** Tax invoice PDF. `inv` is the shape returned by the dealer invoice endpoint. */
export function streamInvoicePdf(res, inv, dealer) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${inv.invoiceNumber || 'invoice'}.pdf"`);
  doc.pipe(res);

  header(doc, 'TAX INVOICE', inv.invoiceNumber || '');

  labelValueGrid(doc, [
    ['Invoice number', inv.invoiceNumber],
    ['Invoice date', dateStr(inv.invoiceDate)],
    ['Due date', dateStr(inv.dueDate)],
    ['Order reference', inv.orderNumber || '-'],
  ]);
  rule(doc);

  sectionTitle(doc, 'Billed to');
  doc.fontSize(11).font('Helvetica-Bold').text(inv.buyer?.name || dealer?.businessName || '-', 40, doc.y);
  doc.y += 14;
  doc.fontSize(9).font('Helvetica').fillColor(MUTED);
  const buyerBits = [
    dealer?.address,
    [dealer?.city, dealer?.state].filter(Boolean).join(', '),
    dealer?.pinCode,
    inv.buyer?.gstin ? `GSTIN: ${inv.buyer.gstin}` : '',
  ].filter(Boolean);
  buyerBits.forEach((line) => {
    doc.text(line, 40, doc.y);
    doc.y += 12;
  });
  doc.fillColor(INK);
  doc.y += 6;
  rule(doc);

  // Items table
  sectionTitle(doc, 'Items');
  const cols = [
    { key: 'sn', label: '#', width: 22, align: 'left' },
    { key: 'name', label: 'Product', width: 178, align: 'left' },
    { key: 'hsn', label: 'HSN', width: 52, align: 'left' },
    { key: 'qty', label: 'Qty', width: 58, align: 'right' },
    { key: 'rate', label: 'Rate', width: 68, align: 'right' },
    { key: 'gst', label: 'GST', width: 38, align: 'right' },
    { key: 'amount', label: 'Amount', width: 99, align: 'right' },
  ];

  const drawHeaderRow = () => {
    const y = doc.y;
    doc.rect(40, y - 3, doc.page.width - 80, 18).fill('#F1F5F9');
    let x = 44;
    doc.fontSize(8).font('Helvetica-Bold').fillColor(MUTED);
    cols.forEach((c) => {
      doc.text(c.label, x, y + 2, { width: c.width - 6, align: c.align });
      x += c.width;
    });
    doc.y = y + 20;
    doc.fillColor(INK);
  };

  drawHeaderRow();

  (inv.items || []).forEach((it, i) => {
    if (doc.y > doc.page.height - 190) {
      doc.addPage();
      doc.y = 50;
      drawHeaderRow();
    }
    const values = {
      sn: String(i + 1),
      name: it.productName || '-',
      hsn: it.hsnCode || '-',
      qty: `${it.quantity} ${it.unit || ''}`.trim(),
      rate: money(it.rate),
      gst: `${it.gstPercentage || 0}%`,
      amount: money(it.totalAmount),
    };
    const y = doc.y;
    let x = 44;
    doc.fontSize(8.5).font('Helvetica');
    let rowHeight = 12;
    cols.forEach((c) => {
      const h = doc.heightOfString(values[c.key], { width: c.width - 6 });
      rowHeight = Math.max(rowHeight, h);
      doc.text(values[c.key], x, y, { width: c.width - 6, align: c.align });
      x += c.width;
    });
    doc.y = y + rowHeight + 6;
    doc.moveTo(40, doc.y - 3).lineTo(doc.page.width - 40, doc.y - 3)
      .strokeColor(LINE).lineWidth(0.5).stroke();
  });

  // Totals
  const t = inv.totals || {};
  doc.y += 8;
  const totalsX = doc.page.width - 240;
  const totalRow = (label, value, bold = false) => {
    doc.fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .fillColor(bold ? INK : MUTED)
      .text(label, totalsX, doc.y, { width: 110, align: 'left' });
    doc.fillColor(INK).font(bold ? 'Helvetica-Bold' : 'Helvetica')
      .text(value, totalsX + 110, doc.y, { width: 90, align: 'right' });
    doc.y += 15;
  };

  totalRow('Taxable value', money(t.taxableTotal));
  if (Number(t.totalDiscount) > 0) totalRow('Discount', `- ${money(t.totalDiscount)}`);
  if (inv.isInterState) {
    totalRow('IGST', money(t.totalIgst));
  } else {
    totalRow('CGST', money(t.totalCgst));
    totalRow('SGST', money(t.totalSgst));
  }
  if (Number(t.freightCharges) > 0) totalRow('Freight', money(t.freightCharges));
  if (Number(t.loadingCharges) > 0) totalRow('Loading', money(t.loadingCharges));
  if (Number(t.roundOff)) totalRow('Round off', money(t.roundOff));
  doc.moveTo(totalsX, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor(LINE).stroke();
  doc.y += 8;
  totalRow('Grand total', money(t.grandTotal), true);
  if (Number(t.paidAmount) > 0) totalRow('Paid', `- ${money(t.paidAmount)}`);
  totalRow('Balance due', money(t.balanceAmount), true);

  if (inv.amountInWords) {
    doc.y += 6;
    doc.fontSize(8).font('Helvetica-Oblique').fillColor(MUTED)
      .text(inv.amountInWords, 40, doc.y, { width: doc.page.width - 300 });
    doc.fillColor(INK);
  }

  footer(doc, 'This is a computer-generated tax invoice issued by BDM Granimarmo Private Limited.');
  doc.end();
}

/** Payment receipt PDF. `r` is the shape returned by the dealer receipts endpoint. */
export function streamReceiptPdf(res, r, dealer) {
  const doc = new PDFDocument({ size: 'A4', margin: 40 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${r.paymentNumber || 'receipt'}.pdf"`);
  doc.pipe(res);

  header(doc, 'PAYMENT RECEIPT', r.paymentNumber || '');

  labelValueGrid(doc, [
    ['Receipt number', r.paymentNumber],
    ['Receipt date', dateStr(r.paymentDate)],
    ['Payment mode', String(r.paymentMode || '').toUpperCase()],
    ['Status', String(r.status || '').toUpperCase()],
  ]);
  rule(doc);

  sectionTitle(doc, 'Received from');
  doc.fontSize(11).font('Helvetica-Bold').text(dealer?.businessName || '-', 40, doc.y);
  doc.y += 14;
  doc.fontSize(9).font('Helvetica').fillColor(MUTED);
  [
    dealer?.dealerCode ? `Dealer code: ${dealer.dealerCode}` : '',
    [dealer?.city, dealer?.state].filter(Boolean).join(', '),
    dealer?.gstin ? `GSTIN: ${dealer.gstin}` : '',
  ].filter(Boolean).forEach((line) => {
    doc.text(line, 40, doc.y);
    doc.y += 12;
  });
  doc.fillColor(INK);
  doc.y += 6;
  rule(doc);

  // Amount highlight
  doc.rect(40, doc.y, doc.page.width - 80, 58).fill('#FFF3ED');
  doc.fillColor(MUTED).fontSize(8).font('Helvetica-Bold')
    .text('AMOUNT RECEIVED', 56, doc.y + 12);
  doc.fillColor(BRAND).fontSize(22).font('Helvetica-Bold')
    .text(money(r.amount), 56, doc.y + 26);
  doc.y += 74;
  doc.fillColor(INK);

  const details = [];
  if (r.bankName) details.push(['Bank', r.bankName]);
  if (r.chequeNumber) details.push(['Cheque number', r.chequeNumber]);
  if (r.reference) details.push(['Reference / UTR', r.reference]);
  if (r.against?.length) details.push(['Adjusted against', r.against.join(', ')]);
  if (r.remarks) details.push(['Remarks', r.remarks]);
  if (details.length) {
    sectionTitle(doc, 'Payment details');
    labelValueGrid(doc, details);
  }

  footer(doc, 'This is a computer-generated receipt. Subject to realisation of the instrument.');
  doc.end();
}
