const path = require("path");
const fs = require("fs");

const IMG_DIR = path.resolve(__dirname, "../../img");
const OUT_DIR = path.join(IMG_DIR, "optimized");

function listSourceImages() {
    return fs
        .readdirSync(IMG_DIR)
        .filter((f) => /\.jpe?g$/i.test(f))
        .filter((f) => fs.statSync(path.join(IMG_DIR, f)).isFile());
}

// buildBuffer(quality) => Promise<Buffer>. 이진 탐색으로 [minBytes, maxBytes] 범위에 가장 가까운 결과를 채택.
async function compressToTargetRange(buildBuffer, minBytes, maxBytes) {
    let lo = 30;
    let hi = 95;
    let best = null;

    while (lo <= hi) {
        const quality = Math.round((lo + hi) / 2);
        const buffer = await buildBuffer(quality);
        const size = buffer.length;

        if (size >= minBytes && size <= maxBytes) {
            best = { buffer, quality, size };
            break;
        }

        if (size > maxBytes) {
            hi = quality - 1;
        } else {
            lo = quality + 1;
            best = { buffer, quality, size };
        }
    }

    return best;
}

module.exports = { IMG_DIR, OUT_DIR, listSourceImages, compressToTargetRange };
