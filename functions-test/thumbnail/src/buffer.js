const sharp = require("sharp");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");
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

// 대조군: 원본 전체를 Buffer로 적재한 뒤 variant를 순차 처리하는 방식.
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

    console.log(`[buffer] Processing: bucket=${bucket}, key=${key}`);

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

    // 원본 전체를 메모리에 Buffer로 적재.
    const originalBuffer = await streamToBuffer(s3Object.Body);

    try {
        for (const variant of VARIANTS) {
            const outputBuffer = await sharp(originalBuffer)
                .rotate() // EXIF Orientation 기준 자동 정방향 회전
                .toColorspace("srgb") // CMYK 등 이색 컬러스페이스 통일
                .resize({
                    width: variant.width,
                    height: variant.height,
                    fit: "cover",
                    withoutEnlargement: true, // 원본이 작으면 확대하지 않고, 크롭만 적용
                    position: "north", // 실측 결과 얼굴 잘림 없이 가장 안정적
                })
                // 알파 채널 없는 이미지엔 no-op이라 조건 분기 없이 항상 호출 가능
                .flatten({ background: "#ffffff" })
                .webp({ quality: WEBP_QUALITY, effort: 4 })
                .toBuffer();

            await s3.send(
                new PutObjectCommand({
                    Bucket: bucket,
                    Key: `${variant.name}/${basename}.webp`,
                    Body: outputBuffer,
                    ContentType: "image/webp",
                })
            );
        }
        console.log(`[buffer] Saved thumbnail/main for ${basename}`);
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
