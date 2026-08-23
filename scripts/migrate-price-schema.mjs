#!/usr/bin/env node
// One-time migration for the price.model.ts schema change (Task 1a):
// - price stored as a BSON string -> BSON number
// - tokenAddress normalised to lowercase (network was already lowercase in
//   every existing document, but is normalised too for safety)
// - builds the (tokenAddress, network, date) unique index, refusing to do so
//   if normalisation produced any duplicate keys (it would block index
//   creation anyway; this fails fast with a clear list instead of a raw
//   Mongo error).
//
// Safe to re-run: already-normalised documents are no-ops, and index
// creation is a no-op if the index already exists.
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

async function migrate() {
  await mongoose.connect(process.env.MONGODB_URI || "");
  const coll = mongoose.connection.db.collection("prices");

  const totalBefore = await coll.countDocuments();
  console.log(`Found ${totalBefore} documents in 'prices'.`);

  const cursor = coll.find({});
  const ops = [];
  let scanned = 0;
  let skippedUnparseable = 0;

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    scanned++;

    const normalizedToken = String(doc.tokenAddress).toLowerCase();
    const normalizedNetwork = String(doc.network).toLowerCase();
    const numericPrice = typeof doc.price === "number" ? doc.price : parseFloat(doc.price);

    if (Number.isNaN(numericPrice)) {
      skippedUnparseable++;
      console.warn(`Skipping unparseable price on doc ${doc._id}: ${JSON.stringify(doc.price)}`);
      continue;
    }

    const needsUpdate =
      doc.tokenAddress !== normalizedToken ||
      doc.network !== normalizedNetwork ||
      typeof doc.price !== "number";

    if (needsUpdate) {
      ops.push({
        updateOne: {
          filter: { _id: doc._id },
          update: {
            $set: { tokenAddress: normalizedToken, network: normalizedNetwork, price: numericPrice },
          },
        },
      });
    }
  }

  console.log(`Scanned ${scanned} documents. ${ops.length} need normalisation. ${skippedUnparseable} skipped (unparseable price).`);

  if (ops.length > 0) {
    const result = await coll.bulkWrite(ops);
    console.log(`Updated ${result.modifiedCount} documents.`);
  }

  // Re-check for duplicate keys under the target unique index AFTER
  // normalisation - two differently-cased addresses could now collide.
  const dupes = await coll
    .aggregate([
      {
        $group: {
          _id: { tokenAddress: "$tokenAddress", network: "$network", date: "$date" },
          count: { $sum: 1 },
          ids: { $push: "$_id" },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  if (dupes.length > 0) {
    console.error(`Found ${dupes.length} duplicate (tokenAddress, network, date) groups after normalisation:`);
    console.error(JSON.stringify(dupes, null, 2));
    console.error("Refusing to build the unique index. Resolve these manually (keep one document per group) and re-run.");
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log("No duplicate keys after normalisation. Building unique index on (tokenAddress, network, date)...");
  await coll.createIndex({ tokenAddress: 1, network: 1, date: 1 }, { unique: true });
  console.log("Unique index created (or already existed).");

  await mongoose.disconnect();
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
