import mongoose , { Schema, Document }from "mongoose";

export interface Price extends Document{
    tokenAddress: string;
    network: string;
    date: Date;
    price: string;
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
        type: String,
        required: [true, "Price is required"],
    }
})


const PriceModel = (mongoose.models.Price as mongoose.Model<Price>) || mongoose.model<Price>("Price",PriceSchema);

export default PriceModel;