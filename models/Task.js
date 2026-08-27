import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema(
  {
    branch: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', index: true },
    taskNumber: { type: String, unique: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    priority: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    status: { type: String, enum: ['pending', 'in_progress', 'completed', 'cancelled', 'overdue'], default: 'pending' },
    
    // Assignment
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    department: { type: String, default: '' },

    // Dates
    dueDate: { type: Date, required: true },
    completedDate: Date,
    startedDate: Date,

    // Checklist
    checklist: [{ text: String, done: { type: Boolean, default: false } }],

    // Attachments
    attachments: [{ fileName: String, fileUrl: String, uploadedAt: { type: Date, default: Date.now } }],

    // Comments
    comments: [{
      text: String,
      user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      userName: String,
      createdAt: { type: Date, default: Date.now },
    }],

    // Escalation
    escalated: { type: Boolean, default: false },
    escalatedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    escalatedAt: Date,

    // Review
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewDate: Date,
    reviewRemarks: { type: String, default: '' },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

taskSchema.index({ branch: 1, assignedTo: 1, status: 1 });
taskSchema.index({ branch: 1, dueDate: 1 });
taskSchema.index({ branch: 1, status: 1 });
taskSchema.index({ branch: 1, priority: -1 });

export default mongoose.model('Task', taskSchema);
