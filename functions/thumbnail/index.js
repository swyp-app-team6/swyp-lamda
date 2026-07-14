const sharp = require("sharp");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

const s3 = new S3Client({ region: "ap-northeast-2" });
const THUMBNAIL_WIDTH = parseInt(process.env.THUMBNAIL_WIDTH ?? "400");
const THUMBNAIL_QUALITY = parseInt(process.env.THUMBNAIL_QUALITY ?? "85");

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
    const basename = filename.replace(/\.[^.]+$/, "");
    const thumbnailKey = `thumbnail/${basename}.jpg`;

    try {
        const s3Object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

        // 확장자/Content-Type을 미리 판단하지 않는다.
        // sharp가 스트림의 실제 바이트를 보고 포맷을 자동 감지 + 검증한다.
        const sharpStream = await new Promise((resolve, reject) => {
            const transform = sharp()
                .resize({ width: THUMBNAIL_WIDTH, withoutEnlargement: true })
                .jpeg({ quality: THUMBNAIL_QUALITY })
                .on("error", reject);

            s3Object.Body.on("error", reject).pipe(transform);
            resolve(transform);
        });

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
        // 이미지가 아니거나 손상된 파일 → sharp가 여기서 걸러줌 (재시도 불필요)
        if (
            err.name === "NoSuchKey" ||
            err.message?.includes("unsupported image format") ||
            err.message?.includes("Input buffer contains") ||
            err.message?.includes("VipsForeignLoad")
        ) {
            console.error(`Not a processable image, skipping: ${key} - ${err.message}`);
            return;
        }
        console.error(`Failed to process ${key}:`, err.message);
        throw err; // 일시적 오류만 재시도
    }
};
