import mongoose from "mongoose";
import dotenv from "dotenv";

type ConnectionObject = {
    isConnected?: number
}

const connection : ConnectionObject = {}

async function dbConnect(): Promise<void> {
    dotenv.config();
    if(connection.isConnected){
        console.log("Already Connected to database");
        return
    }

    try {
        console.log("Connected to MongoDB",process.env.MONGODB_URI);
        const db = await mongoose.connect(process.env.MONGODB_URI || '')
        connection.isConnected = db.connections[0].readyState
        
        console.log("DB connected Successfully");

    } catch (error) {
        console.log("Database connection failed", error);
        process.exit(1);

    }
}

export default dbConnect;