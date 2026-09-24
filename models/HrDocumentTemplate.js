import mongoose from 'mongoose';

const hrDocumentTemplateSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch' },
    templateCode: { type: String, required: true, trim: true },
    templateName: { type: String, required: true, trim: true },
    documentType: {
      type: String,
      enum: ['Offer Letter', 'Appointment Letter', 'NDA', 'Relieving Letter', 'Experience Certificate', 'Other'],
      required: true,
    },
    // Body content with {{variable}} placeholders, rendered as simple paragraphs
    // (each line becomes a paragraph in the generated PDF).
    content: { type: String, required: true },
    // Variables referenced in content, e.g. {{employeeName}}, {{designation}}, {{salary}}, {{joiningDate}}, {{companyName}}.
    variables: [String],
    isActive: { type: Boolean, default: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

hrDocumentTemplateSchema.index({ branch: 1, templateCode: 1 }, { unique: true });
hrDocumentTemplateSchema.index({ branch: 1, documentType: 1, isActive: 1 });

export default mongoose.model('HrDocumentTemplate', hrDocumentTemplateSchema);
