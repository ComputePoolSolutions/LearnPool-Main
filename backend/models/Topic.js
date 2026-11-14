const mongoose = require('../db');

const topicSchema = new mongoose.Schema({
  title: { type: String, required: true },
  description: { type: String },
  module: { type: mongoose.Schema.Types.ObjectId, ref: 'Module', required: true },
  lectures: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Lecture' }],
  tests: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Test' }],
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

module.exports = mongoose.model('Topic', topicSchema);
