import mongoose from 'mongoose';

const supplierCreditNoteSchema = new mongoose.Schema({
  noteNumber: { type: String, trim: true },
  noteDate: Date,
  amount: { type: Number, min: 0 },
  documentUrl: { type: String, trim: true },
  storedName: { type: String, trim: true },
  originalName: { type: String, trim: true },
  mimeType: { type: String, trim: true },
  documentHash: { type: String, trim: true },
  status: { type: String, enum: ['pending_verification', 'verified', 'rejected', 'superseded_by_reversal'] },
  receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  receivedAt: Date,
  verifiedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  verifiedAt: Date,
  verificationRemarks: { type: String, default: '' },
}, { _id: false });

const schemeSettlementSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, immutable: true, index: true },
    settlementNumber: { type: String, required: true },
    partyType: { type: String, enum: ['dealer', 'supplier'], required: true, immutable: true },
    dealer: { type: mongoose.Schema.Types.ObjectId, ref: 'Dealer' },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier' },
    partyName: { type: String, required: true },
    dealerScheme: { type: mongoose.Schema.Types.ObjectId, ref: 'DealerScheme' },
    supplierScheme: { type: mongoose.Schema.Types.ObjectId, ref: 'SupplierScheme' },
    schemeNumber: { type: String, required: true },
    schemeName: { type: String, required: true },
    schemeVersion: { type: Number, required: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    rootKey: { type: String, required: true, index: true },
    scopeKey: { type: String, required: true, unique: true },
    calculationFingerprint: { type: String, required: true },
    ruleSnapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    calculation: { type: mongoose.Schema.Types.Mixed, required: true },
    amount: { type: Number, required: true, min: 0.01 },
    adjustmentType: { type: String, enum: ['base', 'supplemental', 'clawback'], default: 'base' },
    parentSettlement: { type: mongoose.Schema.Types.ObjectId, ref: 'SchemeSettlement' },
    status: { type: String, enum: ['submitted', 'approved', 'reversed', 'superseded'], default: 'submitted' },
    notes: { type: String, default: '', trim: true },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    submittedAt: { type: Date, default: Date.now },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    accountingNoteNumber: String,
    accountingNoteDate: Date,
    postingKey: String,
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reversedAt: Date,
    reversalReason: String,
    reversalPostingKey: String,
    supplierCreditNote: supplierCreditNoteSchema,
    supplierCreditNoteHistory: { type: [supplierCreditNoteSchema], default: [] },
    supplierEvidenceKeys: { type: [String], default: [] },
  },
  { timestamps: true }
);

schemeSettlementSchema.index({ branch: 1, settlementNumber: 1 }, { unique: true });
schemeSettlementSchema.index({ branch: 1, partyType: 1, status: 1, submittedAt: -1 });
schemeSettlementSchema.index({ branch: 1, dealerScheme: 1, dealer: 1, periodStart: 1, periodEnd: 1 });
schemeSettlementSchema.index({ branch: 1, supplierScheme: 1, supplier: 1, periodStart: 1, periodEnd: 1 });

schemeSettlementSchema.index({ branch: 1, supplier: 1, 'supplierCreditNote.noteNumber': 1 }, {
  unique: true,
  partialFilterExpression: { 'supplierCreditNote.noteNumber': { $type: 'string' } },
});
schemeSettlementSchema.index({ branch: 1, supplier: 1, 'supplierCreditNote.documentHash': 1 }, {
  unique: true,
  partialFilterExpression: { 'supplierCreditNote.documentHash': { $type: 'string' } },
});

schemeSettlementSchema.index({ branch: 1, supplier: 1, supplierEvidenceKeys: 1 }, {
  unique: true,
  partialFilterExpression: { supplierEvidenceKeys: { $type: 'string' } },
});

export default mongoose.model('SchemeSettlement', schemeSettlementSchema);
