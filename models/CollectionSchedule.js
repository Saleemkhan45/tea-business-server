import mongoose from 'mongoose'

const settings = {
  frequency: { type: String, enum: ['weekly', 'one_time'], default: 'weekly' },
  channels: { type: [String], enum: ['in_app', 'push', 'whatsapp', 'customer_whatsapp'], default: ['in_app'] },
  weekdays: { type: [Number], required: true },
  expectedAmount: { type: Number, required: true },
  time: { type: String, default: '' },
  startDate: { type: String, required: true },
  endDate: { type: String, default: '' },
  notes: { type: String, default: '' },
  status: { type: String, enum: ['active', 'paused', 'disabled'], required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
}
const history = new mongoose.Schema({ ...settings, recordedAt: { type: Date, default: Date.now } })
const schema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, required: true },
  customer: { type: mongoose.Schema.Types.ObjectId, required: true },
  ...settings,
  generatedThrough: String,
  revision: { type: Number, default: 0 },
  history: [history],
}, { timestamps: true, autoIndex: false })
schema.index({ shop: 1, customer: 1 }, { unique: true, name: 'collection_schedule_customer_unique' })
export const CollectionSchedule = mongoose.model('CollectionSchedule', schema)

const occurrence = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, required: true },
  customer: { type: mongoose.Schema.Types.ObjectId, required: true },
  schedule: { type: mongoose.Schema.Types.ObjectId, required: true },
  scheduledDate: { type: String, required: true },
  expectedAmount: { type: Number, required: true },
  notes: String,
  time: String,
  channels: { type: [String], enum: ['in_app', 'push', 'whatsapp', 'customer_whatsapp'], default: ['in_app'] },
  scheduleRevision: Number,
  acknowledgedAt: Date,
  acknowledgedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  acknowledgmentNotes: String,
}, { timestamps: true, autoIndex: false })
occurrence.index({ shop: 1, schedule: 1, scheduledDate: 1 }, { unique: true, name: 'collection_occurrence_unique' })
occurrence.index({ shop: 1, scheduledDate: 1, customer: 1 })
export const CollectionOccurrence = mongoose.model('CollectionOccurrence', occurrence)
