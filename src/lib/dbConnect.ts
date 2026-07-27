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
        const db = await mongoose.connect(process.env.MONGODB_URI || '')
        connection.isConnected = db.connections[0].readyState

        console.log("DB connected Successfully");

    } catch (error) {
        console.error("Database connection failed", error);
        // Do NOT process.exit here: this runs inside request-handling code
        // paths (API routes, the worker's job processor). Exiting the process
        // on a transient DB blip takes down every unrelated route/job with it.
        // Throwing lets the caller decide how to fail (e.g. return a 503).
        throw error;
    }
}

export default dbConnect;