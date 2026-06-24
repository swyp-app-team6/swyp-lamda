const sharp = require("sharp");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

const s3 = new S3Client({ region: "ap-northeast-2" });
const THUMBNAIL_WIDTH = parseInt(process.env.THUMBNAIL_WIDTH ?? "400");
const THUMBNAIL_QUALITY = parseInt(process.env.THUMBNAIL_QUALITY ?? "85");
const SUPPORTED_EXTENSIONS = ["jpg", "jpeg", "png", "webp"];

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
  const ext = filename.split(".").pop().toLowerCase();
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    console.log(`Unsupported format: ${ext}, skipping.`);
    return;
  }

  try {
    const basename = filename.replace(/\.[^.]+$/, "");
    const thumbnailKey = `thumbnail/${basename}.jpg`;

    const s3Object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

    // S3 Body → sharp 파이프
    // 스트림 에러를 try/catch로 포착하기 위해 Promise로 래핑
    const sharpStream = await new Promise((resolve, reject) => {
      const transform = sharp()
        .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
        .jpeg({ quality: THUMBNAIL_QUALITY })
        .on("error", reject);

      s3Object.Body.on("error", reject).pipe(transform);
      resolve(transform);
    });

    // Upload: multipart로 chunked 전송 — PutObject와 달리 Content-Length 불필요
    await new Upload({
      client: s3,
      params: {
        Bucket: bucket,
        Key: thumbnailKey,
        Body: sharpStream,
        ContentType: "image/jpeg",
      },
    }).done();

    console.log(`Thumbnail saved: ${thumbnailKey}`);
  } catch (err) {
    if (err.name === "NoSuchKey" || err.name === "UnsupportedImageFormat") {
      console.error(`Permanent error, skipping retry: ${err.name} - ${key}`);
      return;
    }
    console.error(`Failed to process ${key}:`, err);
    throw err;
  }
};
