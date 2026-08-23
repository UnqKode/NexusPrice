import mongoose , { Schema, Document }from "mongoose";

export interface Price extends Document{
    tokenAddress: string;
    network: string;
    date: Date;
    price: number;
}

const PriceSchema: Schema<Price> = new Schema({
    tokenAddress: {
        type: String,
        required: [true, "Token address is required"],
    },
    network: {
        type: String,
        required: [true, "Network is required"],
    },
    date: {
        type: Date,
        required: [true, "Date is required"],
        default: Date.now
    },
    price: {
        type: Number,
        required: [true, "Price is required"],
    }
})

// tokenAddress/network are NOT normalised here via a pre-save hook. The
// worker's write path uses Model.updateOne(..., { upsert: true }) (see
// priceProcessor.ts), and Mongoose document middleware like pre('save')
// does not run for query-based writes such as updateOne/findOneAndUpdate -
// a save hook here would silently never fire for the one write path that
// matters. Normalising at the call site (lowercased before the filter is
// built) is what actually stays consistent with the unique index below,
// which is case-sensitive.
PriceSchema.index({ tokenAddress: 1, network: 1, date: 1 }, { unique: true });

const PriceModel = (mongoose.models.Price as mongoose.Model<Price>) || mongoose.model<Price>("Price",PriceSchema);

export default PriceModel;