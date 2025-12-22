import mongoose from "mongoose";
import dotenv from "dotenv";
import colors from "colors";

// Load environment variables
dotenv.config();

const connectDb = async () => {
  try {
    if (!process.env.MONGO_URI) {
      console.error("MONGO_URI is not defined in .env file".red);
      process.exit(1); // Exit the process with an error code
    }

    const conn = await mongoose.connect(process.env.MONGO_URI, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    console.log(`MongoDB connected: ${conn.connection.host}`.bgBrightBlue.bgBrightYellow);
  } catch (error) {
    console.error(`Error in connectDb: ${error.message}`.red);
    console.error(error.stack); // Log full stack trace for easier debugging
    process.exit(1); // Exit the process with an error code
  }
};

export default connectDb;
