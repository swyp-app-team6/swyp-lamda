const sharp = require("sharp");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");
const { withMemProfiler } = require("./memProfiler");

const s3 = new S3Client({
    region: process.env.AWS_REGION ?? "ap-northeast-2",
    ...(process.env.S3_ENDPOINT
        ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }
        : {}),
});
const WEBP_QUALITY = parseInt(process.env.WEBP_QUALITY ?? "90");

// 두 가지 파생 이미지 스펙 (보관함, 메인 뷰)
const VARIANTS = [
    { name: "thumbnail", width: 208, height: 220 },
    { name: "main", width: 284, height: 392 },
];

// 두 번째 대조군: 리팩터링 전 실제 운영 코드(커밋 0e57b6e 이전)를 재현.
// 원본 전체를 Buffer로 적재하되, variant는 sharp().clone() + Promise.all로
// "동시" 처리한다. (src/buffer.js의 순차 처리와 달리 동시성은 stream.js와 동일)
async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

const handler = async (event) => {
    const record = event.Records[0];
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, " "));

    console.log(`[buffer-concurrent] Processing: bucket=${bucket}, key=${key}`);

    if (!key.startsWith("original/")) {
        console.log("Not an original/ file, skipping.");
        return;
    }

    const filename = key.split("/").pop();
    const basename = filename.replace(/\.[^.]+$/, "");

    let s3Object;
    try {
        s3Object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    } catch (err) {
        if (err.name === "NoSuchKey") {
            console.error(`Permanent error - object not found, skipping retry: ${key}`);
            return;
        }
        throw err;
    }

    const originalBuffer = await streamToBuffer(s3Object.Body);
    const baseImage = sharp(originalBuffer);

    const uploads = VARIANTS.map((variant) => {
        const transform = baseImage
            .clone()
            .rotate()
            .toColorspace("srgb")
            .resize({
                width: variant.width,
                height: variant.height,
                fit: "cover",
                withoutEnlargement: true,
                position: "north",
            })
            .flatten({ background: "#ffffff" })
            .webp({ quality: WEBP_QUALITY, effort: 4 })
            .on("error", (err) =>
                console.error(`${variant.name} sharp error: ${err.message}`)
            );

        return new Upload({
            client: s3,
            params: {
                Bucket: bucket,
                Key: `${variant.name}/${basename}.webp`,
                Body: transform,
                ContentType: "image/webp",
            },
        }).done();
    });

    try {
        await Promise.all(uploads);
        console.log(`[buffer-concurrent] Saved thumbnail/main for ${basename}`);
    } catch (err) {
        if (
            err.message?.includes("unsupported image format") ||
            err.message?.includes("Input buffer contains") ||
            err.message?.includes("VipsForeignLoad")
        ) {
            console.error(`Not a processable image, skipping: ${key} - ${err.message}`);
            return;
        }
        console.error(`Failed to process ${key}:`, err.message);
        throw err;
    }
};

exports.handler = withMemProfiler(handler);
