import mongoose from "mongoose";

const connectDB = async (): Promise<void> => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI as string, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,  
    });

    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    console.log(`📦 Database: ${conn.connection.name}`);
      
    mongoose.connection.on("disconnected", () => {
      console.log("⚠️ MongoDB disconnected");
    });
  
    mongoose.connection.on("error", (err) => {
      console.error(`❌ MongoDB error: ${err}`);
    });

    process.on("SIGINT", async () => {
      await mongoose.connection.close();
      console.log("MongoDB connection closed");
      process.exit(0);
    });
  } catch (error: any) {
    console.error(`❌ DB Connection Error: ${error.message}`);
    process.exit(1);
  }
};

export default connectDB;
