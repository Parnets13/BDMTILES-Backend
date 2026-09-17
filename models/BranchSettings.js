import mongoose from 'mongoose';

const documentNumberingSchema = new mongoose.Schema(
  {
    prefix: { type: String, trim: true, default: '' },
    padding: { type: Number, min: 3, max: 10, default: 5 },
    includeBranchCode: { type: Boolean, default: true },
    includeFiscalYear: { type: Boolean, default: true },
  },
  { _id: false }
);

const branchSettingsSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', required: true, unique: true },
    fiscalYearStartMonth: { type: Number, min: 1, max: 12, default: 4 },
    timezone: { type: String, trim: true, default: 'Asia/Kolkata' },
    currency: { type: String, trim: true, uppercase: true, default: 'INR' },
    invoiceTerms: { type: String, default: '' },
    inventory: {
      reorderFallbackLevel: { type: Number, min: 1, default: 10 },
      minStockFallbackLevel: { type: Number, min: 0, default: 5 },
      minimumReorderQuantity: { type: Number, min: 1, default: 10 },
    },
    numbering: {
      salesOrder: { type: documentNumberingSchema, default: () => ({ prefix: 'SO' }) },
      quotation: { type: documentNumberingSchema, default: () => ({ prefix: 'QT' }) },
      invoice: { type: documentNumberingSchema, default: () => ({ prefix: 'INV' }) },
      purchaseOrder: { type: documentNumberingSchema, default: () => ({ prefix: 'PO' }) },
      supplierQuotation: { type: documentNumberingSchema, default: () => ({ prefix: 'SQ' }) },
      grn: { type: documentNumberingSchema, default: () => ({ prefix: 'GRN' }) },
      payment: { type: documentNumberingSchema, default: () => ({ prefix: 'PAY' }) },
      expense: { type: documentNumberingSchema, default: () => ({ prefix: 'EXP' }) },
      stockTransfer: { type: documentNumberingSchema, default: () => ({ prefix: 'ST' }) },
      salesReturn: { type: documentNumberingSchema, default: () => ({ prefix: 'SR' }) },
      creditNote: { type: documentNumberingSchema, default: () => ({ prefix: 'CN' }) },
      purchaseReturn: { type: documentNumberingSchema, default: () => ({ prefix: 'DN' }) },
      pickList: { type: documentNumberingSchema, default: () => ({ prefix: 'PL' }) },
      supplierInvoice: { type: documentNumberingSchema, default: () => ({ prefix: 'SINV' }) },
      dispatchTrip: { type: documentNumberingSchema, default: () => ({ prefix: 'TRIP' }) },
      dispatch: { type: documentNumberingSchema, default: () => ({ prefix: 'DSP' }) },
      purchaseRequisition: { type: documentNumberingSchema, default: () => ({ prefix: 'PR' }) },
      discountMapping: { type: documentNumberingSchema, default: () => ({ prefix: 'DISC' }) },
      delivery: { type: documentNumberingSchema, default: () => ({ prefix: 'DEL' }) },
      approval: { type: documentNumberingSchema, default: () => ({ prefix: 'APR' }) },
      bankReconciliation: { type: documentNumberingSchema, default: () => ({ prefix: 'BR' }) },
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reorderGuardVersion: { type: Number, default: 0, select: false },
  },
  { timestamps: true }
);

export default mongoose.model('BranchSettings', branchSettingsSchema);
