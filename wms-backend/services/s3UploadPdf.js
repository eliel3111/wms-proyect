import { PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "./s3Client.js";

export async function uploadPdfToS3({ buffer, key }) {


  console.log("AWS KEY:", process.env.AWS_ACCESS_KEY_ID);

  
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: "application/pdf",
    })
  );
}
