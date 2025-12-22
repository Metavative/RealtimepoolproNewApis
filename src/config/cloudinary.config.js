import { v2 as cloudinary } from "cloudinary";

// Cloudinary connection function
const connectCloudinary = async () => {
  // Check if Cloudinary credentials are provided
  if (!process.env.CLOUDINARY_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_SECRET_KEY) {
    console.error("Cloudinary credentials missing in .env file.".red);
    process.exit(1); // Exit the process if credentials are missing
  }

  try {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_SECRET_KEY,
    });

    console.log("Cloudinary connected successfully.".bgMagenta.white);
  } catch (error) {
    console.error("Error connecting to Cloudinary:".red, error.message);
    process.exit(1); // Exit the process if the connection fails
  }
};

export default connectCloudinary;
