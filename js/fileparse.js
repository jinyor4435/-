/**
 * 공고문 파일에서 텍스트를 뽑아낸다 — 전부 브라우저 안에서 처리하며 파일을 밖으로 보내지 않는다.
 *
 * 지원: HWP(한글 5.0 바이너리) · HWPX · PDF · DOCX · PPTX · TXT/MD
 * 한국 공공기관 파일은 확장자와 실제 형식이 다른 경우가 잦으므로 매직 바이트로 판별한다.
 */

/* ─────────────── 압축 해제 (브라우저 내장 DecompressionStream) ─────────────── */

async function inflate(bytes, format) {
  const ds = new DecompressionStream(format);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** raw deflate 우선, 실패 시 zlib 헤더 형식으로 재시도 */
async function inflateAuto(bytes) {
  try { return await inflate(bytes, 'deflate-raw'); } catch (e) { /* 아래에서 재시도 */ }
  return await inflate(bytes, 'deflate');
}

/* ─────────────── ZIP (DOCX·HWPX·PPTX 및 위장 PDF 공용) ─────────────── */

/** ZIP 아카이브를 {파일명: Uint8Array} 로 푼다. 중앙 디렉터리를 기준으로 읽는다. */
async function readZip(buf) {
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  // End of Central Directory 를 뒤에서부터 찾는다 (주석이 붙어 있을 수 있다)
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 22 - 65536; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 구조를 찾지 못했습니다');

  let count = view.getUint16(eocd + 10, true);
  let cdOffset = view.getUint32(eocd + 16, true);

  // ZIP64 — 공고문 크기에선 사실상 없지만 방어적으로 처리
  if (cdOffset === 0xffffffff || count === 0xffff) {
    for (let i = eocd - 20; i >= 0; i--) {
      if (view.getUint32(i, true) === 0x07064b50) {
        const z64 = Number(view.getBigUint64(i + 8, true));
        count = Number(view.getBigUint64(z64 + 32, true));
        cdOffset = Number(view.getBigUint64(z64 + 48, true));
        break;
      }
    }
  }

  const files = {};
  let p = cdOffset;
  for (let i = 0; i < count && p + 46 <= u8.length; i++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    // 로컬 헤더에서 실제 데이터 시작 위치를 계산한다
    if (view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(start, start + compSize);

    try {
      files[name] = method === 0 ? raw : await inflate(raw, 'deflate-raw');
    } catch (e) { /* 개별 항목 실패는 건너뛴다 */ }
  }
  return files;
}

/* ─────────────── XML 기반 포맷 (DOCX · HWPX · PPTX) ─────────────── */

function decodeXmlEntities(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * 문단·표 구분을 살려 XML에서 텍스트를 뽑는다.
 * 텍스트 태그와 경계 태그를 한 번에 훑어, 조각을 이으면서 줄바꿈과 칸 구분을 넣는다.
 */
function xmlToText(xml, opts) {
  const o = opts || {};
  const textPat = '<(?:' + o.textTags + ')(?:\\s[^>]*)?>([\\s\\S]*?)</(?:' + o.textTags + ')>';
  const parts = [textPat];
  const kinds = [null];  // 각 대안이 어떤 경계인지 (null = 텍스트)
  const add = (pat, kind) => { parts.push(pat); kinds.push(kind); };
  if (o.paraEnd) add('</(?:' + o.paraEnd + ')>', 'para');
  if (o.rowEnd) add('</(?:' + o.rowEnd + ')>', 'row');
  if (o.breakTag) add('<(?:' + o.breakTag + ')[^>]*/?>', 'para');
  if (o.cellEnd) add('</(?:' + o.cellEnd + ')>', 'cell');

  const re = new RegExp(parts.join('|'), 'g');
  // 어떤 대안이 매치됐는지는 그룹 번호로 판단한다 (텍스트 대안만 캡처 그룹을 가진다)
  const checks = kinds.map((kind, i) => ({
    kind, re: i === 0 ? null : new RegExp('^(?:' + parts[i] + ')$')
  }));

  let out = '';
  let m;
  while ((m = re.exec(xml))) {
    if (m[1] !== undefined) {
      out += decodeXmlEntities(m[1].replace(/<[^>]*>/g, ''));
      continue;
    }
    const hit = checks.find((c) => c.re && c.re.test(m[0]));
    if (!hit) continue;
    if (hit.kind === 'cell') {
      // 셀 안의 문단 줄바꿈은 칸 구분으로 바꾼다
      out = out.replace(/\s+$/, '');
      if (out && !/\|\s*$/.test(out)) out += ' | ';
    } else if (hit.kind === 'row') {
      out = out.replace(/(\s*\|)?\s*$/, '');
      if (out) out += '\n';
    } else if (!/\n$/.test(out)) {
      if (/\|\s*$/.test(out)) continue;  // 셀 경계 직후의 문단 끝은 무시
      out += '\n';
    }
  }
  return out;
}

function sortedSections(files, re) {
  return Object.keys(files).filter((n) => re.test(n))
    .sort((a, b) => {
      const na = Number((a.match(/(\d+)/) || [0, 0])[1]);
      const nb = Number((b.match(/(\d+)/) || [0, 0])[1]);
      return na - nb || a.localeCompare(b);
    });
}

async function parseDocx(buf) {
  const files = await readZip(buf);
  const parts = ['word/document.xml'].concat(sortedSections(files, /^word\/(header|footer)\d*\.xml$/));
  let text = '';
  for (const name of parts) {
    if (!files[name]) continue;
    const xml = new TextDecoder('utf-8').decode(files[name]);
    text += xmlToText(xml, { textTags: 'w:t', paraEnd: 'w:p', cellEnd: 'w:tc', rowEnd: 'w:tr', breakTag: 'w:br' }) + '\n';
  }
  return text;
}

async function parseHwpx(buf) {
  const files = await readZip(buf);
  const names = sortedSections(files, /^Contents\/section\d*\.xml$/i);
  if (!names.length) throw new Error('HWPX 본문(Contents/section*.xml)을 찾지 못했습니다');
  let text = '';
  for (const name of names) {
    const xml = new TextDecoder('utf-8').decode(files[name]);
    text += xmlToText(xml, { textTags: 'hp:t|hp:tx', paraEnd: 'hp:p', cellEnd: 'hp:tc', rowEnd: 'hp:tr', breakTag: 'hp:lineBreak' }) + '\n';
  }
  return text;
}

async function parsePptx(buf) {
  const files = await readZip(buf);
  const names = sortedSections(files, /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/);
  let text = '';
  for (const name of names) {
    const xml = new TextDecoder('utf-8').decode(files[name]);
    text += xmlToText(xml, { textTags: 'a:t', paraEnd: 'a:p', cellEnd: 'a:tc', rowEnd: 'a:tr' }) + '\n\n';
  }
  return text;
}

/** 확장자만 PDF인 ZIP(스캔 JPEG + OCR 텍스트) */
async function parseZipTextBundle(buf) {
  const files = await readZip(buf);
  const names = sortedSections(files, /\.txt$/i);
  if (!names.length) throw new Error('ZIP 안에서 텍스트를 찾지 못했습니다');
  return names.map((n) => new TextDecoder('utf-8').decode(files[n])).join('\n');
}

/* ─────────────── HWP 5.0 (OLE 복합문서) ─────────────── */

/** OLE 복합문서를 파싱해 {스트림경로: Uint8Array} 로 돌려준다. */
function readCompoundFile(buf) {
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);
  const sectorSize = 1 << view.getUint16(0x1e, true);
  const miniSectorSize = 1 << view.getUint16(0x20, true);
  const numFatSectors = view.getUint32(0x2c, true);
  const firstDirSector = view.getUint32(0x30, true);
  const miniCutoff = view.getUint32(0x38, true);
  const firstMiniFat = view.getUint32(0x3c, true);
  const firstDifat = view.getUint32(0x44, true);
  const numDifat = view.getUint32(0x48, true);

  const sectorOffset = (s) => (s + 1) * sectorSize;
  const entriesPerSector = sectorSize / 4;

  // DIFAT: 헤더의 109개 + 추가 DIFAT 섹터 체인
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < numFatSectors; i++) {
    const s = view.getUint32(0x4c + i * 4, true);
    if (s <= 0xfffffffa) fatSectors.push(s);
  }
  let difat = firstDifat;
  for (let n = 0; n < numDifat && difat <= 0xfffffffa; n++) {
    const base = sectorOffset(difat);
    for (let i = 0; i < entriesPerSector - 1; i++) {
      const s = view.getUint32(base + i * 4, true);
      if (s <= 0xfffffffa) fatSectors.push(s);
    }
    difat = view.getUint32(base + (entriesPerSector - 1) * 4, true);
  }

  const fat = [];
  for (const s of fatSectors) {
    const base = sectorOffset(s);
    for (let i = 0; i < entriesPerSector; i++) fat.push(view.getUint32(base + i * 4, true));
  }

  const chain = (start, table) => {
    const out = [];
    const seen = new Set();
    let s = start;
    while (s <= 0xfffffffa && !seen.has(s)) { seen.add(s); out.push(s); s = table[s]; }
    return out;
  };

  const readChain = (start, size) => {
    const ids = chain(start, fat);
    const total = new Uint8Array(ids.length * sectorSize);
    ids.forEach((s, i) => total.set(u8.subarray(sectorOffset(s), sectorOffset(s) + sectorSize), i * sectorSize));
    return size == null ? total : total.subarray(0, size);
  };

  // 디렉터리 엔트리 수집
  const dirBytes = readChain(firstDirSector);
  const entries = [];
  for (let off = 0; off + 128 <= dirBytes.length; off += 128) {
    const d = new DataView(dirBytes.buffer, dirBytes.byteOffset + off, 128);
    const nameLen = d.getUint16(64, true);
    if (nameLen < 2) { entries.push(null); continue; }
    let name = '';
    for (let i = 0; i < nameLen / 2 - 1; i++) name += String.fromCharCode(d.getUint16(i * 2, true));
    entries.push({
      name, type: d.getUint8(66), child: d.getUint32(76, true),
      left: d.getUint32(68, true), right: d.getUint32(72, true),
      start: d.getUint32(116, true), size: d.getUint32(120, true)
    });
  }
  const root = entries.find((e) => e && e.type === 5);
  if (!root) throw new Error('OLE 루트 항목이 없습니다');

  // 미니 스트림 (작은 스트림은 별도 컨테이너에 담긴다)
  const miniFat = [];
  for (const s of chain(firstMiniFat, fat)) {
    const base = sectorOffset(s);
    for (let i = 0; i < entriesPerSector; i++) miniFat.push(view.getUint32(base + i * 4, true));
  }
  const miniContainer = readChain(root.start, root.size);
  const readMini = (start, size) => {
    const ids = chain(start, miniFat);
    const out = new Uint8Array(ids.length * miniSectorSize);
    ids.forEach((s, i) => out.set(miniContainer.subarray(s * miniSectorSize, (s + 1) * miniSectorSize), i * miniSectorSize));
    return out.subarray(0, size);
  };

  // 디렉터리 트리를 순회해 전체 경로를 만든다
  const streams = {};
  const walk = (idx, prefix) => {
    if (idx > 0xfffffffa || idx >= entries.length) return;
    const e = entries[idx];
    if (!e) return;
    walk(e.left, prefix);
    const full = prefix ? prefix + '/' + e.name : e.name;
    if (e.type === 2) {
      streams[full] = e.size < miniCutoff ? readMini(e.start, e.size) : readChain(e.start, e.size);
    } else if (e.type === 1) {
      walk(e.child, full);
    }
    walk(e.right, prefix);
  };
  walk(root.child, '');
  return streams;
}

/**
 * HWP 본문 레코드에서 문단 텍스트만 추출한다.
 * 제어 문자 일부는 16바이트를 차지하므로, 폭을 정확히 건너뛰지 않으면 본문이 깨진다.
 */
function hwpRecordsToText(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const WIDE = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]);
  const out = [];
  let i = 0;
  while (i + 4 <= data.length) {
    const header = view.getUint32(i, true);
    const tag = header & 0x3ff;
    let size = (header >> 20) & 0xfff;
    i += 4;
    if (size === 0xfff) { if (i + 4 > data.length) break; size = view.getUint32(i, true); i += 4; }
    if (i + size > data.length) break;

    if (tag === 67) { // HWPTAG_PARA_TEXT
      let s = '';
      for (let w = 0; w + 1 < size; w += 2) {
        const c = view.getUint16(i + w, true);
        if (c === 9) { s += '\t'; w += 14; }
        else if (c === 10 || c === 13) s += '\n';
        else if (WIDE.has(c)) w += 14;
        else if (c >= 32) s += String.fromCharCode(c);
      }
      const t = s.replace(/[ \t]+$/gm, '').trim();
      if (t) out.push(t);
    }
    i += size;
  }
  return out.join('\n');
}

async function parseHwp(buf) {
  const streams = readCompoundFile(buf);
  const header = streams['FileHeader'];
  if (!header) throw new Error('HWP 파일 헤더가 없습니다');
  const flags = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(36, true);
  const compressed = !!(flags & 1);
  if (flags & 2) throw new Error('암호가 걸린 HWP는 열 수 없습니다. 한글에서 암호를 푼 뒤 다시 올려주세요.');

  const names = Object.keys(streams)
    .filter((n) => /^BodyText\/Section\d+$/i.test(n))
    .sort((a, b) => Number(a.match(/(\d+)/)[1]) - Number(b.match(/(\d+)/)[1]));

  let text = '';
  for (const name of names) {
    let data = streams[name];
    if (compressed) {
      try { data = await inflateAuto(data); } catch (e) { continue; }
    }
    text += hwpRecordsToText(data) + '\n';
  }

  // 본문을 못 읽으면 미리보기 스트림이라도 쓴다 (중간에서 잘리므로 경고와 함께)
  if (text.trim().length < 50 && streams['PrvText']) {
    const prv = new TextDecoder('utf-16le').decode(streams['PrvText']);
    if (prv.trim()) {
      return { text: prv, warning: '본문을 읽지 못해 미리보기 텍스트만 추출했습니다. 내용이 중간에서 잘렸을 수 있으니 원본과 대조하세요.' };
    }
  }
  return text;
}

/* ─────────────── PDF ─────────────── */

/** 번들된 한국어 CMap을 pdf.js에 공급한다 (외부 요청 없이 한글 인코딩 처리) */
function makeCMapFactory() {
  return class {
    async fetch(params) {
      const b64 = (window.__KO_CMAPS || {})[params.name];
      if (!b64) throw new Error('CMap 없음: ' + params.name);
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { cMapData: bytes, compressionType: 1 };
    }
  };
}

/** 같은 줄의 조각들을 좌표로 다시 이어 붙여 표 구조를 최대한 살린다 */
function textContentToLines(items) {
  const lines = [];
  for (const it of items) {
    if (!it.str) continue;
    const y = Math.round(it.transform[5]);
    const x = it.transform[4];
    let line = lines.find((l) => Math.abs(l.y - y) <= 2);
    if (!line) { line = { y, parts: [] }; lines.push(line); }
    line.parts.push({ x, str: it.str, w: it.width || 0 });
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((l) => {
    l.parts.sort((a, b) => a.x - b.x);
    let s = '';
    let prevEnd = null;
    for (const p of l.parts) {
      if (prevEnd !== null) {
        const gap = p.x - prevEnd;
        if (gap > 12) s += '   ';       // 칸 구분으로 보이는 넓은 간격
        else if (gap > 1.5) s += ' ';
      }
      s += p.str;
      prevEnd = p.x + p.w;
    }
    return s.replace(/\s+$/, '');
  }).filter((s) => s.trim()).join('\n');
}

async function parsePdf(buf, onProgress) {
  if (typeof window === 'undefined' || !window.pdfjsLib) throw new Error('PDF 처리 모듈이 로드되지 않았습니다');
  const pdfjsLib = window.pdfjsLib;
  // 워커 스크립트를 같은 페이지에 포함해 두었으므로 메인 스레드에서 처리된다
  pdfjsLib.GlobalWorkerOptions.workerSrc = '';

  const doc = await pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    isEvalSupported: false,
    useWorkerFetch: false,
    cMapPacked: true,
    CMapReaderFactory: makeCMapFactory(),
    verbosity: 0
  }).promise;

  const chunks = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (onProgress) onProgress(n, doc.numPages);
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const pageText = textContentToLines(content.items);
    if (pageText.trim()) chunks.push(pageText);
    page.cleanup();
  }
  const text = chunks.join('\n\n');
  if (!text.trim()) {
    return { text: '', warning: '이 PDF에는 추출 가능한 텍스트가 없습니다(스캔 이미지로 보입니다). HWP나 워드 원본을 올려주세요.' };
  }
  return text;
}

/* ─────────────── 형식 판별 및 진입점 ─────────────── */

function sniff(u8) {
  if (u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46) return 'pdf';            // %PDF
  if (u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 3 || u8[2] === 5 || u8[2] === 7)) return 'zip'; // PK
  if (u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0) return 'ole';            // 복합문서
  return 'text';
}

/** ZIP 내부 구성으로 실제 포맷을 가린다 */
function zipKind(names) {
  if (names.some((n) => n === 'word/document.xml')) return 'docx';
  if (names.some((n) => /^Contents\/section\d*\.xml$/i.test(n))) return 'hwpx';
  if (names.some((n) => /^ppt\/slides\//.test(n))) return 'pptx';
  if (names.some((n) => /\.txt$/i.test(n))) return 'textbundle';
  return 'unknown';
}

// BOM·폭 없는 공백 등 눈에 보이지 않는 문자 (소스를 ASCII로 유지하려고 코드포인트로 만든다)
const INVISIBLE_RE = new RegExp('[' + String.fromCharCode(0xfeff, 0x200b, 0x200c, 0x200d) + ']', 'g');
const NBSP_RE = new RegExp(String.fromCharCode(0x00a0), 'g');

/** 과도한 빈 줄과 보이지 않는 문자를 정리해 프롬프트에 넣기 좋게 만든다 */
function normalize(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(INVISIBLE_RE, '')
    .replace(NBSP_RE, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 파일 하나에서 텍스트를 추출한다.
 * 반환: { name, kind, text, warning } — 실패 시 error 를 담는다.
 */
async function extractText(file, onProgress) {
  const buf = await file.arrayBuffer();
  const u8 = new Uint8Array(buf);
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const kind = sniff(u8);

  const finish = (label, result) => {
    const text = typeof result === 'string' ? result : (result.text || '');
    const warning = typeof result === 'string' ? null : result.warning;
    return { name: file.name, kind: label, text: normalize(text), warning };
  };

  try {
    if (kind === 'pdf') return finish('PDF', await parsePdf(buf, onProgress));

    if (kind === 'zip') {
      const files = await readZip(buf);
      const k = zipKind(Object.keys(files));
      if (k === 'docx') return finish('DOCX', await parseDocx(buf));
      if (k === 'hwpx') return finish('HWPX', await parseHwpx(buf));
      if (k === 'pptx') return finish('PPTX', await parsePptx(buf));
      if (k === 'textbundle') {
        return finish('스캔본(OCR 텍스트)', {
          text: await parseZipTextBundle(buf),
          warning: 'OCR로 뽑은 텍스트라 오탈자가 있을 수 있습니다. 목차 항목명은 원본과 대조하세요.'
        });
      }
      throw new Error('지원하지 않는 ZIP 형식입니다');
    }

    if (kind === 'ole') return finish('HWP', await parseHwp(buf));

    if (ext === 'hwp') throw new Error('HWP 형식이 아닙니다. 한글에서 다시 저장한 뒤 올려주세요.');

    // 텍스트로 간주 — UTF-8 우선, 깨지면 EUC-KR(CP949)로 재시도
    let text = new TextDecoder('utf-8').decode(u8);
    if (text.indexOf(String.fromCharCode(0xfffd)) >= 0) {
      try { text = new TextDecoder('euc-kr').decode(u8); } catch (e) { /* 원본 유지 */ }
    }
    return finish(ext === 'md' ? 'Markdown' : 'TXT', text);
  } catch (e) {
    return { name: file.name, kind: kind.toUpperCase(), text: '', error: e.message || String(e) };
  }
}

if (typeof module !== 'undefined') {
  module.exports = {
    readZip, parseDocx, parseHwpx, parsePptx, parseZipTextBundle, parseHwp,
    readCompoundFile, hwpRecordsToText, xmlToText, sniff, zipKind, normalize, extractText
  };
}
