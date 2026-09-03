// scripts/mosaic.js
// 사진 속 식별 가능한 타인 얼굴·차량 번호판·전화번호 등을 모자이크 처리한다.
// 원본은 절대 덮어쓰지 않는다 — 결과물은 input/photos/_mosaic/ 에 생성된다.
//
// 사용법: node scripts/mosaic.js <spec.json>
//
// spec.json 형식:
// {
//   "image": "input/photos/foo.jpg",
//   "pixelSize": 16,                 // 선택, 기본 16 (작을수록 더 잘게 쪼개져 잘 안 가려짐 — 크게 잡을수록 확실히 가려짐)
//   "regions": [
//     { "x0": 0.10, "y0": 0.20, "x1": 0.30, "y1": 0.45 }   // 0~1 상대 좌표, 화면에 보이는 기준(EXIF 회전 보정 후)
//   ]
// }
//
// 구현 함정 2가지 (CLAUDE.md 실측 지식):
// 1) 좌표 기준은 반드시 EXIF 회전 보정 후(보이는 화면 기준)로 잡는다 — .rotate()로 먼저 정규화한 버퍼 위에서 좌표를 계산한다.
// 2) sharp는 한 파이프라인에 resize를 1회만 적용하므로, 축소 후 buffer로 끊고 다시 새 sharp 인스턴스에서 확대(nearest)한다.

const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

async function pixelateRegion(sourceBuffer, region, pixelSize) {
  const { width, height } = region;
  const downW = Math.max(1, Math.round(width / pixelSize));
  const downH = Math.max(1, Math.round(height / pixelSize));

  // 1단계: 축소
  const downscaled = await sharp(sourceBuffer)
    .resize(downW, downH, { fit: 'fill' })
    .toBuffer();

  // 2단계: 확대 (nearest — 경계가 뭉개지지 않고 블록처럼 보이도록)
  const pixelated = await sharp(downscaled)
    .resize(width, height, { fit: 'fill', kernel: 'nearest' })
    .toBuffer();

  return pixelated;
}

async function main() {
  const specPath = process.argv[2];
  if (!specPath) {
    console.error('사용법: node scripts/mosaic.js <spec.json>');
    process.exit(1);
  }

  const root = path.join(__dirname, '..');
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf-8'));
  const pixelSize = spec.pixelSize || 16;

  const inputPath = path.isAbsolute(spec.image) ? spec.image : path.join(root, spec.image);
  if (!fs.existsSync(inputPath)) {
    console.error(`이미지를 찾을 수 없습니다: ${inputPath}`);
    process.exit(1);
  }

  // EXIF 회전 보정 후의 버퍼를 기준 이미지로 삼는다 (좌표 기준 = 보이는 화면 기준)
  const normalizedBuffer = await sharp(inputPath).rotate().toBuffer();
  const { width: imgW, height: imgH } = await sharp(normalizedBuffer).metadata();

  let composites = [];
  for (const r of spec.regions || []) {
    const x0 = Math.max(0, Math.min(1, r.x0));
    const y0 = Math.max(0, Math.min(1, r.y0));
    const x1 = Math.max(0, Math.min(1, r.x1));
    const y1 = Math.max(0, Math.min(1, r.y1));

    const left = Math.round(Math.min(x0, x1) * imgW);
    const top = Math.round(Math.min(y0, y1) * imgH);
    const width = Math.max(1, Math.round(Math.abs(x1 - x0) * imgW));
    const height = Math.max(1, Math.round(Math.abs(y1 - y0) * imgH));

    const regionBuffer = await sharp(normalizedBuffer)
      .extract({ left, top, width, height })
      .toBuffer();

    const pixelated = await pixelateRegion(regionBuffer, { width, height }, pixelSize);
    composites.push({ input: pixelated, left, top });
  }

  const outDir = path.join(root, 'input', 'photos', '_mosaic');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, path.basename(inputPath));

  await sharp(normalizedBuffer).composite(composites).toFile(outPath);

  console.log(`✅ 모자이크 처리 완료: ${outPath}`);
  console.log(`   영역 ${composites.length}개, pixelSize=${pixelSize}`);
  console.log('   처리본을 Read로 열어 실제로 가려졌는지 반드시 확인할 것. 덜 가려졌으면 좌표를 키우거나 pixelSize를 키워 재실행.');
}

main().catch((err) => {
  console.error('모자이크 처리 중 오류:', err);
  process.exit(1);
});
