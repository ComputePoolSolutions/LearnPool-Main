const mongoose = require('../db');
const lmsItemSchema = new mongoose.Schema({
  type: { type: String, required: true, index: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  course: { type: mongoose.Schema.Types.ObjectId, ref: 'Course', default: null, index: true },
  recipients: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  data: { type: mongoose.Schema.Types.Mixed, default: {} },
  readAt: { type: Date, default: null },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, strict: true });
lmsItemSchema.index({ type: 1, owner: 1, createdAt: -1 });
lmsItemSchema.index({ owner:1, 'data.courseId':1, 'data.certificateType':1 }, { unique:true, partialFilterExpression:{ type:'certificates', 'data.status':'issued' } });
module.exports = mongoose.model('LmsItem', lmsItemSchema);
