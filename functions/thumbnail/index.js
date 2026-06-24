const sharp = require("sharp");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const s3 = new S3Client({ region: "ap-northeast-2" });
const THUMBNAIL_WIDTH = 400;

exports.handler = async (event) => {
  const record = event.Records[0];
  const bucket = record.s3.bucket.name;
  const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

  console.log(`Processing: bucket=${bucket}, key=${key}`);

  if (!key.startsWith("original/")) {
    console.log("Not an original/ file, skipping.");
    return;
  }

  const filename = key.split("/").pop();
  const thumbnailKey = `thumbnail/${filename}`;

  const s3Object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const inputBuffer = await streamToBuffer(s3Object.Body);

  const thumbnailBuffer = await sharp(inputBuffer)
    .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: thumbnailKey,
    Body: thumbnailBuffer,
    ContentType: "image/jpeg",
  }));

  console.log(`Thumbnail saved: ${thumbnailKey}`);
};

const streamToBuffer = (stream) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
