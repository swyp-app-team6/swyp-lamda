const sharp = require("sharp");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { Upload } = require("@aws-sdk/lib-storage");

const s3 = new S3Client({ region: "ap-northeast-2" });

const WEBP_QUALITY = parseInt(process.env.WEBP_QUALITY ?? "90");

// 두 가지 파생 이미지 스펙 (보관함, 메인 뷰)
const VARIANTS = [
    { name: "thumbnail", width: 208, height: 220 },
    { name: "main", width: 284, height: 392 },
];

async function streamToBuffer(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

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

    try {
        const s3Object = await s3.send(
            new GetObjectCommand({ Bucket: bucket, Key: key })
        );

        const originalBuffer = await streamToBuffer(s3Object.Body);

        const baseImage = sharp(originalBuffer, { animated: false });
        const metadata = await baseImage.metadata();

        console.log(
            `Original: format=${metadata.format}, ${metadata.width}x${metadata.height}, ` +
            `hasAlpha=${metadata.hasAlpha}, size=${originalBuffer.length} bytes`
        );

        await Promise.all(
            VARIANTS.map(async (variant) => {
                // 원본이 목표 크기보다 이미 작은 경우, 목표 박스보다 작은 쪽을 기준으로
                // fit을 "inside"로 전환해 확대를 원천 차단한다.
                // (cover는 확대까지 강제하므로 withoutEnlargement와 병행 불가한 케이스가 있음)
                const needsUpscale =
                    metadata.width < variant.width || metadata.height < variant.height;

                let pipeline = baseImage
                    .clone()
                    .rotate() // EXIF Orientation 기준 자동 정방향 회전
                    .toColorspace("srgb"); // CMYK 등 이색 컬러스페이스 통일

                if (needsUpscale) {
                    // 확대하지 않고 원본 해상도를 그대로 유지 (품질 저하 + 용량 증가 방지)
                    // 화면에는 UI 레이어에서 box-fit으로 표시되므로 문제 없음
                    console.log(
                        `${variant.name}: source smaller than target, skipping upscale ` +
                        `(${metadata.width}x${metadata.height} < ${variant.width}x${variant.height})`
                    );
                } else {
                    pipeline = pipeline.resize({
                        width: variant.width,
                        height: variant.height,
                        fit: "cover",
                        // 프로필 사진 샘플 테스트 결과, 자동 saliency 감지(attention)보다
                        // 상단 기준 크롭(north)이 얼굴 잘림 없이 안정적으로 동작함
                        position: "north",
                    });
                }

                if (metadata.hasAlpha) {
                    pipeline = pipeline.flatten({ background: "#ffffff" });
                }

                const outputBuffer = await pipeline
                    .webp({ quality: WEBP_QUALITY, effort: 4 })
                    .toBuffer();

                // 재인코딩 후에도 원본보다 커지면 원본을 그대로 사용 (안전장치)
                const finalBuffer =
                    outputBuffer.length < originalBuffer.length
                        ? outputBuffer
                        : originalBuffer;

                if (finalBuffer === originalBuffer) {
                    console.log(
                        `${variant.name}: re-encoded result larger than original ` +
                        `(${outputBuffer.length} >= ${originalBuffer.length}), using original instead`
                    );
                }

                const outputKey = `${variant.name}/${basename}.webp`;

                await new Upload({
                    client: s3,
                    params: {
                        Bucket: bucket,
                        Key: outputKey,
                        Body: finalBuffer,
                        ContentType:
                            finalBuffer === originalBuffer
                                ? `image/${metadata.format}`
                                : "image/webp",
                    },
                }).done();

                console.log(
                    `Saved ${variant.name}: ${outputKey} (${finalBuffer.length} bytes)`
                );
            })
        );
    } catch (err) {
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
        throw err;
    }
};
