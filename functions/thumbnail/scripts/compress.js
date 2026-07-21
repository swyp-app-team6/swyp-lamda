const path = require("path");
const fs = require("fs");
const sharp = require("sharp");
const { IMG_DIR, OUT_DIR, compressToTargetRange } = require("./lib");

// 슬롯별 목표 규격 (docs: hero/og/ending/gallery)
const SLOTS = {
    hero: {
        source: "hero.jpg",
        width: 960,
        height: 1200,
        focus: { x: 0.5, y: 0.5 },
        minBytes: 200 * 1024,
        maxBytes: 400 * 1024,
    },
    ending: {
        source: "ending.jpg",
        width: 960,
        height: 600,
        focus: { x: 0.5, y: 0.7 }, // 화면 아래쪽이 더 보이도록 세로 크롭 위치를 아래로 이동
        extraTop: 135, // 하단 경계는 유지한 채 위쪽 여백을 추가로 확보 (8:5 규격에서 벗어남)
        minBytes: 200 * 1024,
        maxBytes: 400 * 1024,
    },
    og: {
        source: "og.jpg",
        width: 1200,
        height: 630,
        focus: { x: 0.5, y: 0.5 }, // 카카오톡/페이스북이 강제하는 1.91:1 비율은 그대로 유지
        minBytes: 200 * 1024,
        maxBytes: 400 * 1024,
    },
};

// fit:"cover"를 수동으로 재현하되, 크롭 위치를 focus(0~1 비율)로 세밀하게 지정.
// extraTop이 있으면 하단 경계는 그대로 두고 위쪽으로만 크롭 영역을 넓힌다(출력 세로 길이가 늘어남).
async function computeCrop(meta, { width, height, focus, extraTop = 0 }) {
    const scale = Math.max(width / meta.width, height / meta.height);
    const resizedWidth = Math.round(meta.width * scale);
    const resizedHeight = Math.round(meta.height * scale);

    const left = Math.min(Math.max(Math.round((resizedWidth - width) * focus.x), 0), resizedWidth - width);
    const baseTop = Math.round((resizedHeight - height) * focus.y);
    const bottom = baseTop + height;

    const top = Math.max(0, baseTop - extraTop);
    const cropHeight = Math.min(bottom - top, resizedHeight - top);

    return { resizedWidth, resizedHeight, left, top, width, height: cropHeight };
}

async function compressToRange(inputPath, slot) {
    const { minBytes, maxBytes } = slot;
    const meta = await sharp(inputPath).metadata();
    const crop = await computeCrop(meta, slot);

    const best = await compressToTargetRange(
        (quality) =>
            sharp(inputPath)
                .rotate()
                .resize({ width: crop.resizedWidth, height: crop.resizedHeight })
                .extract({ left: crop.left, top: crop.top, width: crop.width, height: crop.height })
                .flatten({ background: "#ffffff" })
                .jpeg({ quality, mozjpeg: true })
                .toBuffer(),
        minBytes,
        maxBytes
    );

    return { ...best, outWidth: crop.width, outHeight: crop.height };
}

async function run(slotName) {
    const slot = SLOTS[slotName];
    if (!slot) {
        console.error(`Unknown slot: ${slotName}. Available: ${Object.keys(SLOTS).join(", ")}`);
        process.exit(1);
    }

    const inputPath = path.join(IMG_DIR, slot.source);
    if (!fs.existsSync(inputPath)) {
        console.error(`Source not found: ${inputPath}`);
        process.exit(1);
    }

    fs.mkdirSync(OUT_DIR, { recursive: true });

    const result = await compressToRange(inputPath, slot);
    const outputPath = path.join(OUT_DIR, slot.source);
    fs.writeFileSync(outputPath, result.buffer);

    console.log(`${slotName}: ${result.outWidth}x${result.outHeight}, quality=${result.quality}, ${(result.size / 1024).toFixed(1)}KB -> ${path.relative(process.cwd(), outputPath)}`);
}

const slotName = process.argv[2];
if (!slotName) {
    console.error("Usage: node compress.js <slot>");
    process.exit(1);
}

run(slotName).catch((err) => {
    console.error(err);
    process.exit(1);
});
