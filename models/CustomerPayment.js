import mongoose from 'mongoose'

const customerPaymentSchema = new mongoose.Schema({
  shop: { type: mongoose.Schema.Types.ObjectId, ref: 'Shop', required: true, index: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'Customer', required: true, index: true },
  businessDate: { type: String, required: true, index: true },
  amount: { type: Number, required: true, min: 0 },
}, { timestamps: true })

customerPaymentSchema.index({ shop: 1, customer: 1, businessDate: -1 })

export const CustomerPayment = mongoose.model('CustomerPayment', customerPaymentSchema)
