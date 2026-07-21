const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { IMG_DIR, OUT_DIR, listSourceImages, compressToTargetRange } = require("./lib");

// 크롭은 하지 않되, 긴 변을 웹에 충분한 해상도로 줄이고 목표 용량 범위에 맞춰 품질을 자동 조절한다.
const MAX_DIMENSION = parseInt(process.argv[2], 10) || 2200;
const MIN_BYTES = (parseInt(process.argv[3], 10) || 300) * 1024;
const MAX_BYTES = (parseInt(process.argv[4], 10) || 600) * 1024;
const FULL_DIR = path.join(OUT_DIR, "full");

async function run() {
    fs.mkdirSync(FULL_DIR, { recursive: true });
    const files = listSourceImages();

    for (const file of files) {
        const inputPath = path.join(IMG_DIR, file);
        const outputPath = path.join(FULL_DIR, file);
        const originalSize = fs.statSync(inputPath).size;

        const result = await compressToTargetRange(
            (quality) =>
                sharp(inputPath)
                    .rotate()
                    .resize({
                        width: MAX_DIMENSION,
                        height: MAX_DIMENSION,
                        fit: "inside",
                        withoutEnlargement: true,
                    })
                    .flatten({ background: "#ffffff" })
                    .jpeg({ quality, mozjpeg: true })
                    .toBuffer(),
            MIN_BYTES,
            MAX_BYTES
        );

        fs.writeFileSync(outputPath, result.buffer);

        const reduction = (100 * (1 - result.size / originalSize)).toFixed(1);
        console.log(
            `${file}: ${(originalSize / 1024 / 1024).toFixed(1)}MB -> ${(result.size / 1024).toFixed(0)}KB (quality=${result.quality}, -${reduction}%)`
        );
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
