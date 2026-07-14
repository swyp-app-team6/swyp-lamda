/**
 * 사용법: node compare-formats.js ./photo1.jpg ./photo2.jpg
 *
 * 1. 실제 프로필 사진 샘플들을 다양한 포맷/품질로 인코딩해서 용량 비교
 * 2. 크롭 포지션(attention/center/north 등)을 비교해서 얼굴이 잘리지 않는 전략 확인
 */
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const TARGET_WIDTH = 284;
const TARGET_HEIGHT = 392;
const BEST_QUALITY = 85; // 포맷 비교에서 화질/용량 밸런스가 좋았던 값

const FORMAT_CANDIDATES = [
    { label: "jpeg-mozjpeg-q80", encode: (img) => img.jpeg({ quality: 80, mozjpeg: true, chromaSubsampling: "4:2:0" }) },
    { label: "jpeg-mozjpeg-q90-444", encode: (img) => img.jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: "4:4:4" }) },
    { label: "webp-q75", encode: (img) => img.webp({ quality: 75, effort: 4 }) },
    { label: "webp-q85", encode: (img) => img.webp({ quality: 85, effort: 4 }) },
    { label: "webp-q90", encode: (img) => img.webp({ quality: 90, effort: 4 }) },
];

// 크롭 위치 후보 — 얼굴이 잘리지 않는 전략을 찾기 위한 비교용
const CROP_POSITIONS = [
    { label: "attention", position: "attention" }, // libvips 자동 saliency 감지 (기존 방식)
    { label: "entropy", position: "entropy" },      // 엔트로피 기반, attention과 다른 알고리즘
    { label: "center", position: "centre" },        // 단순 중앙 크롭
    { label: "north", position: "north" },           // 상단 기준 크롭 (얼굴이 보통 위쪽에 있는 경우)
];

async function main() {
    const files = process.argv.slice(2);
    if (files.length === 0) {
        console.error("사용법: node compare-formats.js <이미지파일...>");
        process.exit(1);
    }

    const outDir = "./format-comparison-output";
    fs.mkdirSync(outDir, { recursive: true });

    for (const file of files) {
        if (!fs.existsSync(file)) {
            console.warn(`⚠️  파일 없음, 건너뜀: ${file}`);
            continue;
        }

        const basename = path.basename(file, path.extname(file));
        const originalBuffer = fs.readFileSync(file);
        const originalSize = originalBuffer.length;

        console.log(`\n=== ${basename} (원본 ${(originalSize / 1024).toFixed(1)}KB) ===`);

        // --- 1. 포맷/품질 비교 (기존 기능, attention 크롭 고정) ---
        console.log("-- 포맷 비교 (crop: attention) --");
        const resizedForFormat = sharp(originalBuffer)
            .rotate()
            .resize({ width: TARGET_WIDTH, height: TARGET_HEIGHT, fit: "cover", position: "attention" });

        for (const candidate of FORMAT_CANDIDATES) {
            const buffer = await candidate.encode(resizedForFormat.clone()).toBuffer();
            const ext = candidate.label.startsWith("jpeg") ? "jpg" : "webp";
            const outPath = path.join(outDir, `${basename}-format-${candidate.label}.${ext}`);
            fs.writeFileSync(outPath, buffer);

            const sizeKB = (buffer.length / 1024).toFixed(1);
            const ratio = ((buffer.length / originalSize) * 100).toFixed(0);
            console.log(`  ${candidate.label.padEnd(20)} ${sizeKB}KB (원본 대비 ${ratio}%)`);
        }

        // --- 2. 크롭 포지션 비교 (얼굴 잘림 확인용, webp-q85 고정) ---
        console.log("-- 크롭 포지션 비교 (format: webp q85) --");
        for (const crop of CROP_POSITIONS) {
            const buffer = await sharp(originalBuffer)
                .rotate()
                .resize({ width: TARGET_WIDTH, height: TARGET_HEIGHT, fit: "cover", position: crop.position })
                .webp({ quality: BEST_QUALITY, effort: 4 })
                .toBuffer();

            const outPath = path.join(outDir, `${basename}-crop-${crop.label}.webp`);
            fs.writeFileSync(outPath, buffer);
            console.log(`  ${crop.label.padEnd(12)} -> ${outPath}`);
        }

        // --- 3. 보관함 썸네일: 원본에서 직접 크롭 vs 메인에서 재활용 크롭 ---
        console.log("-- 썸네일 소스 비교 (원본 직접 vs 메인 재활용) --");

        const mainBuffer = await sharp(originalBuffer)
            .rotate()
            .resize({ width: TARGET_WIDTH, height: TARGET_HEIGHT, fit: "cover", position: "north" })
            .webp({ quality: BEST_QUALITY, effort: 4 })
            .toBuffer();
        fs.writeFileSync(path.join(outDir, `${basename}-main.webp`), mainBuffer);

        const THUMB_WIDTH = 208;
        const THUMB_HEIGHT = 220;

        // 방식 A: 원본에서 직접 크롭
        const thumbFromOriginal = await sharp(originalBuffer)
            .rotate()
            .resize({ width: THUMB_WIDTH, height: THUMB_HEIGHT, fit: "cover", position: "north" })
            .webp({ quality: BEST_QUALITY, effort: 4 })
            .toBuffer();
        fs.writeFileSync(
            path.join(outDir, `${basename}-thumb-from-original.webp`),
            thumbFromOriginal
        );

        // 방식 B: 이미 크롭된 메인 이미지에서 재크롭 (2차 크롭)
        const thumbFromMain = await sharp(mainBuffer)
            .resize({ width: THUMB_WIDTH, height: THUMB_HEIGHT, fit: "cover", position: "north" })
            .webp({ quality: BEST_QUALITY, effort: 4 })
            .toBuffer();
        fs.writeFileSync(
            path.join(outDir, `${basename}-thumb-from-main.webp`),
            thumbFromMain
        );

        console.log(`  thumb-from-original: ${(thumbFromOriginal.length / 1024).toFixed(1)}KB`);
        console.log(`  thumb-from-main:     ${(thumbFromMain.length / 1024).toFixed(1)}KB`);
    }

    console.log(`\n결과가 ${outDir}에 저장됐습니다.`);
    console.log(`- "-format-*" 파일들: 포맷/품질 비교용`);
    console.log(`- "-crop-*" 파일들: 크롭 전략별 비교용 (얼굴이 안 잘리는 걸 골라야 함)`);
    console.log(`- "-thumb-from-original" vs "-thumb-from-main": 2차 크롭 화질/구도 손실 확인용`);
}

main();
