import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const endpoint = process.env.T4_S3_ENDPOINT;
const bucket = process.env.T4_S3_BUCKET;

if (!endpoint || !bucket) {
  console.log("T4_S3_ENDPOINT and T4_S3_BUCKET are not set; nothing to seed.");
  process.exit(0);
}

const accessKeyId = process.env.T4_S3_ACCESS_KEY_ID;
const secretAccessKey = process.env.T4_S3_SECRET_ACCESS_KEY;
if (!accessKeyId || !secretAccessKey) {
  console.error("T4_S3_ACCESS_KEY_ID and T4_S3_SECRET_ACCESS_KEY are required to seed.");
  process.exit(1);
}

const client = new S3Client({
  endpoint,
  region: process.env.T4_S3_REGION || "us-east-1",
  forcePathStyle: process.env.T4_S3_URL_STYLE !== "virtual",
  credentials: { accessKeyId, secretAccessKey },
});

const objects = [
  { key: "readme.txt", body: "t4 demo bucket\n" },
  { key: "warehouse/users/users.csv", body: "id,name\n1,ada\n" },
];

for (const object of objects) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: object.key,
      Body: object.body,
    }),
  );
  console.log(`Wrote s3://${bucket}/${object.key}`);
}

client.destroy();
