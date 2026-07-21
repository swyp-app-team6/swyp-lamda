const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { IMG_DIR, OUT_DIR, listSourceImages, compressToTargetRange } = require("./lib");

const WIDTH = 400;
const HEIGHT = 400;
const MIN_BYTES = 40 * 1024;
const MAX_BYTES = 120 * 1024;
const GALLERY_DIR = path.join(OUT_DIR, "gallery");

function computeCrop(meta) {
    const scale = Math.max(WIDTH / meta.width, HEIGHT / meta.height);
    const resizedWidth = Math.round(meta.width * scale);
    const resizedHeight = Math.round(meta.height * scale);
    const left = Math.round((resizedWidth - WIDTH) / 2);
    const top = Math.round((resizedHeight - HEIGHT) / 2);
    return { resizedWidth, resizedHeight, left, top };
}

async function run() {
    fs.mkdirSync(GALLERY_DIR, { recursive: true });
    const files = listSourceImages();

    for (const file of files) {
        const inputPath = path.join(IMG_DIR, file);
        const meta = await sharp(inputPath).metadata();
        const crop = computeCrop(meta);

        const result = await compressToTargetRange(
            (quality) =>
                sharp(inputPath)
                    .rotate()
                    .resize({ width: crop.resizedWidth, height: crop.resizedHeight })
                    .extract({ left: crop.left, top: crop.top, width: WIDTH, height: HEIGHT })
                    .flatten({ background: "#ffffff" })
                    .jpeg({ quality, mozjpeg: true })
                    .toBuffer(),
            MIN_BYTES,
            MAX_BYTES
        );

        const outputPath = path.join(GALLERY_DIR, file);
        fs.writeFileSync(outputPath, result.buffer);
        console.log(
            `${file}: ${WIDTH}x${HEIGHT}, quality=${result.quality}, ${(result.size / 1024).toFixed(1)}KB -> ${path.relative(process.cwd(), outputPath)}`
        );
    }
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
