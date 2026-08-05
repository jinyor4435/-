/**
 * 한글 문서(HWPX) 생성 — 한컴오피스 한글이 바로 여는 개방형 표준 포맷(OWPML).
 *
 * .hwp 는 비공개 바이너리라 브라우저에서 만들 수 없지만, .hwpx 는 ZIP+XML 이라 생성할 수 있다.
 * 한글 2014 이상에서 그대로 열리고, 열어서 .hwp 로 다시 저장할 수 있다.
 */

/* ─────────────── ZIP 쓰기 (압축 없이 저장 — 문서 크기에선 충분하다) ─────────────── */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** entries: [{name, data:Uint8Array}] → ZIP 바이트 */
function makeZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  const u16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const u32 = (v) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];

  for (const e of entries) {
    const nameBytes = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = [].concat(
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(e.data.length), u32(e.data.length),
      u16(nameBytes.length), u16(0)
    );
    chunks.push(new Uint8Array(local), nameBytes, e.data);

    central.push({ name: nameBytes, crc, size: e.data.length, offset });
    offset += local.length + nameBytes.length + e.data.length;
  }

  const cdStart = offset;
  for (const c of central) {
    const head = [].concat(
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(c.crc), u32(c.size), u32(c.size),
      u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset)
    );
    chunks.push(new Uint8Array(head), c.name);
    offset += head.length + c.name.length;
  }

  const end = [].concat(
    u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
    u32(offset - cdStart), u32(cdStart), u16(0)
  );
  chunks.push(new Uint8Array(end));

  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

/* ─────────────── OWPML 문서 조립 ─────────────── */

const HWPUNIT_PER_MM = 283.465;
const mm = (v) => Math.round(v * HWPUNIT_PER_MM);
const pt = (v) => Math.round(v * 100);   // 글자 크기 단위: 1pt = 100

// XML 1.0 에서 허용되지 않는 제어 문자 (소스를 ASCII로 유지하려고 코드포인트로 만든다)
const XML_BAD_CHARS = (() => {
  let chars = '';
  for (let c = 0x00; c <= 0x1f; c++) {
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;  // 탭·줄바꿈은 허용
    chars += String.fromCharCode(c);
  }
  return new RegExp('[' + chars + ']', 'g');
})();

function xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(XML_BAD_CHARS, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
const LANG_ATTR = 'hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"';
const ratioAttr = (v) => `hangul="${v}" latin="${v}" hanja="${v}" japanese="${v}" other="${v}" symbol="${v}" user="${v}"`;

/** 글자 모양: 0 본문, 1 굵게, 2 문서 제목, 3 장 제목, 4 표 머리글, 5 부제 */
const CHAR_PROPS = [
  { id: 0, size: 11, bold: 0, color: '#000000' },
  { id: 1, size: 11, bold: 1, color: '#000000' },
  { id: 2, size: 17, bold: 1, color: '#1A3A6B' },
  { id: 3, size: 13, bold: 1, color: '#1A3A6B' },
  { id: 4, size: 10, bold: 1, color: '#000000' },
  { id: 5, size: 10, bold: 0, color: '#444444' }
];

/** 문단 모양: 0 본문, 1 1단 들여쓰기, 2 2단 들여쓰기, 3 장 제목, 4 문서 제목 */
const PARA_PROPS = [
  { id: 0, left: 0, before: 0, after: 30 },
  { id: 1, left: pt(10), before: 0, after: 20 },
  { id: 2, left: pt(20), before: 0, after: 20 },
  { id: 3, left: 0, before: 160, after: 60 },
  { id: 4, left: 0, before: 0, after: 120 }
];

function headerXml() {
  const fontfaces = LANGS.map((lang) => `<hh:fontface lang="${lang}" fontCnt="2">
      <hh:font id="0" face="맑은 고딕" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" serifStyle="OBLIQUE_COVE" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font>
      <hh:font id="1" face="함초롬바탕" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_MYUNGJO" serifStyle="OBLIQUE_COVE" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font>
    </hh:fontface>`).join('\n');

  const charPrs = CHAR_PROPS.map((c) => `<hh:charPr id="${c.id}" height="${pt(c.size)}" textColor="${c.color}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1">
      <hh:fontRef ${LANG_ATTR}/>
      <hh:ratio ${ratioAttr(100)}/>
      <hh:spacing ${ratioAttr(0)}/>
      <hh:relSz ${ratioAttr(100)}/>
      <hh:offset ${ratioAttr(0)}/>
      ${c.bold ? '<hh:bold/>' : ''}
    </hh:charPr>`).join('\n');

  const paraPrs = PARA_PROPS.map((p) => `<hh:paraPr id="${p.id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">
      <hh:align horizontal="LEFT" vertical="BASELINE"/>
      <hh:heading type="NONE" idRef="0" level="0"/>
      <hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="BREAK_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>
      <hh:autoSpacing eAsianEng="0" eAsianNum="0"/>
      <hh:margin>
        <hc:intent value="0" unit="HWPUNIT"/>
        <hc:left value="${p.left}" unit="HWPUNIT"/>
        <hc:right value="0" unit="HWPUNIT"/>
        <hc:prev value="${p.before}" unit="HWPUNIT"/>
        <hc:next value="${p.after}" unit="HWPUNIT"/>
      </hh:margin>
      <hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/>
      <hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
    </hh:paraPr>`).join('\n');

  const border = (t) => `<hh:${t} type="SOLID" width="0.12 mm" color="#000000"/>`;
  const borderFills = `
    <hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
      <hh:slash type="NONE" Crooked="0" isCounter="0"/>
      <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
      <hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/>
      <hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>
      <hh:topBorder type="NONE" width="0.1 mm" color="#000000"/>
      <hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>
      <hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>
    </hh:borderFill>
    <hh:borderFill id="2" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
      <hh:slash type="NONE" Crooked="0" isCounter="0"/>
      <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
      ${border('leftBorder')}${border('rightBorder')}${border('topBorder')}${border('bottomBorder')}
      <hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>
    </hh:borderFill>
    <hh:borderFill id="3" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
      <hh:slash type="NONE" Crooked="0" isCounter="0"/>
      <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
      ${border('leftBorder')}${border('rightBorder')}${border('topBorder')}${border('bottomBorder')}
      <hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>
      <hc:fillBrush><hc:winBrush faceColor="#EEF2F8" hatchColor="#999999" alpha="0"/></hc:fillBrush>
    </hh:borderFill>`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" version="1.4" secCnt="1">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList>
    <hh:fontfaces itemCnt="${LANGS.length}">
${fontfaces}
    </hh:fontfaces>
    <hh:borderFills itemCnt="3">${borderFills}</hh:borderFills>
    <hh:charProperties itemCnt="${CHAR_PROPS.length}">
${charPrs}
    </hh:charProperties>
    <hh:tabProperties itemCnt="1">
      <hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/>
    </hh:tabProperties>
    <hh:numberings itemCnt="0"/>
    <hh:paraProperties itemCnt="${PARA_PROPS.length}">
${paraPrs}
    </hh:paraProperties>
    <hh:styles itemCnt="1">
      <hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>
    </hh:styles>
  </hh:refList>
</hh:head>`;
}

const SEC_PR = `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">
  <hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0" strtnum="0"/>
  <hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>
  <hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>
  <hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>
  <hp:pagePr landscape="WIDELY" width="${mm(210)}" height="${mm(297)}" gutterType="LEFT_ONLY">
    <hp:margin header="${mm(10)}" footer="${mm(10)}" gutter="0" left="${mm(20)}" right="${mm(20)}" top="${mm(20)}" bottom="${mm(20)}"/>
  </hp:pagePr>
  <hp:footNotePr>
    <hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>
    <hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/>
    <hp:noteSpacing betweenNotes="850" belowLine="567" aboveLine="850"/>
    <hp:numbering type="CONTINUOUS" newNum="1"/>
    <hp:placement place="EACH_COLUMN" beneathText="0"/>
  </hp:footNotePr>
  <hp:endNotePr>
    <hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>
    <hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/>
    <hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/>
    <hp:numbering type="CONTINUOUS" newNum="1"/>
    <hp:placement place="END_OF_DOCUMENT" beneathText="0"/>
  </hp:endNotePr>
  <hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">
    <hp:offset left="1417" right="1417" top="1417" bottom="1417"/>
  </hp:pageBorderFill>
</hp:secPr>`;

/** 문단 하나를 만든다 */
function para(text, opts) {
  const o = opts || {};
  const runs = (o.runs || [{ text: text || '', charPr: o.charPr || 0 }])
    .map((r) => `<hp:run charPrIDRef="${r.charPr || 0}">${r.first || ''}<hp:t>${xmlEsc(r.text)}</hp:t></hp:run>`)
    .join('');
  return `<hp:p id="0" paraPrIDRef="${o.paraPr || 0}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">${runs}</hp:p>`;
}

/** 표: 모든 셀을 같은 너비로 배치한다 */
function tableXml(rows, availableWidth) {
  const cols = Math.max(...rows.map((r) => r.length));
  const colWidth = Math.floor(availableWidth / cols);
  const rowHeight = 1200;

  const cells = (row, rowIndex) => row.concat(Array(cols - row.length).fill(''))
    .map((cell, colIndex) => {
      const isHead = rowIndex === 0;
      const inner = para(cell, { charPr: isHead ? 4 : 0, paraPr: 0 });
      return `<hp:tc name="" header="${isHead ? 1 : 0}" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="${isHead ? 3 : 2}">
        <hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${inner}</hp:subList>
        <hp:cellAddr colAddr="${colIndex}" rowAddr="${rowIndex}"/>
        <hp:cellSpan colSpan="1" rowSpan="1"/>
        <hp:cellSz width="${colWidth}" height="${rowHeight}"/>
        <hp:cellMargin left="510" right="510" top="141" bottom="141"/>
      </hp:tc>`;
    }).join('');

  const trs = rows.map((r, i) => `<hp:tr>${cells(r, i)}</hp:tr>`).join('');
  const totalW = colWidth * cols;
  const totalH = rowHeight * rows.length;

  const tbl = `<hp:tbl id="0" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${rows.length}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="2" noAdjust="0">
    <hp:sz width="${totalW}" widthRelTo="ABSOLUTE" height="${totalH}" heightRelTo="ABSOLUTE" protect="0"/>
    <hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>
    <hp:outMargin left="0" right="0" top="141" bottom="141"/>
    <hp:inMargin left="510" right="510" top="141" bottom="141"/>
    ${trs}
  </hp:tbl>`;

  return `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${tbl}</hp:run></hp:p>`;
}

/**
 * 사업계획서 전체를 HWPX 바이트로 만든다.
 * blocksOf(text) 는 개조식 파서(parseContent)를 주입받는다.
 */
function buildHwpxBytes(project, opts) {
  const o = opts || {};
  const parse = o.parseContent;
  const sections = o.sections || [];
  const idea = (project.ideas || [])[project.selectedIdeaIndex] || {};
  const title = idea.title || project.name || '사업계획서';
  const usableWidth = mm(210 - 40);

  const body = [];
  let first = true;
  const push = (xml) => {
    // 첫 문단에는 반드시 구역 설정이 들어가야 한다
    if (first) { body.push(xml.replace('<hp:run charPrIDRef="', '<hp:run charPrIDRef="').replace(/(<hp:run charPrIDRef="\d+">)/, '$1' + SEC_PR)); first = false; }
    else body.push(xml);
  };

  push(para(title, { charPr: 2, paraPr: 4 }));
  if (idea.oneLiner) push(para(idea.oneLiner, { charPr: 5, paraPr: 4 }));

  const marks = ['□ ', '○ ', '- '];
  const addBlocks = (text) => {
    for (const b of parse(text)) {
      if (b.type === 'table') push(tableXml(b.rows, usableWidth));
      else if (b.type === 'h') push(para(b.text, { charPr: 1, paraPr: 3 }));
      else if (b.type === 'li') {
        push(para((marks[b.level] || '- ') + b.text, {
          charPr: b.level === 0 ? 1 : 0,
          paraPr: b.level === 0 ? 0 : (b.level === 1 ? 1 : 2)
        }));
      } else push(para(b.text, { charPr: 0, paraPr: 0 }));
    }
  };

  for (const sec of sections) {
    const s = (project.sections || {})[sec.id];
    if (!s || !s.content) continue;
    push(para(sec.title, { charPr: 3, paraPr: 3 }));
    addBlocks(s.content);
  }
  if (o.appendix) {
    push(para(o.appendix.title, { charPr: 3, paraPr: 3 }));
    addBlocks(o.appendix.content);
  }
  if (body.length <= 2) push(para('(작성된 내용이 없습니다)', { charPr: 0, paraPr: 0 }));

  const sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">
${body.join('\n')}
</hs:sec>`;

  const contentHpf = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:dc="http://purl.org/dc/elements/1.1/" version="" unique-identifier="" id="">
  <opf:metadata>
    <opf:title>${xmlEsc(title)}</opf:title>
    <opf:language>ko</opf:language>
    <opf:meta name="creator" content=""/>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>
    <opf:item id="settings" href="settings.xml" media-type="application/xml"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="header" linear="yes"/>
    <opf:itemref idref="section0" linear="yes"/>
  </opf:spine>
</opf:package>`;

  const containerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf">
  <ocf:rootfiles>
    <ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>
  </ocf:rootfiles>
</ocf:container>`;

  const manifestXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" version="1.2">
  <odf:file-entry odf:full-path="/" odf:media-type="application/hwp+zip"/>
  <odf:file-entry odf:full-path="Contents/content.hpf" odf:media-type="application/hwpml-package+xml"/>
  <odf:file-entry odf:full-path="Contents/header.xml" odf:media-type="application/xml"/>
  <odf:file-entry odf:full-path="Contents/section0.xml" odf:media-type="application/xml"/>
</odf:manifest>`;

  const versionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="1" buildNumber="0" os="1" xmlVersion="1.4" application="딥테크 정부지원사업 계획서 생성기" appVersion="1.0"/>`;

  const settingsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="http://www.hancom.co.kr/hwpml/2011/config-item">
  <ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/>
</ha:HWPApplicationSetting>`;

  const enc = new TextEncoder();
  return makeZip([
    { name: 'mimetype', data: enc.encode('application/hwp+zip') },
    { name: 'version.xml', data: enc.encode(versionXml) },
    { name: 'settings.xml', data: enc.encode(settingsXml) },
    { name: 'META-INF/container.xml', data: enc.encode(containerXml) },
    { name: 'META-INF/manifest.xml', data: enc.encode(manifestXml) },
    { name: 'Contents/content.hpf', data: enc.encode(contentHpf) },
    { name: 'Contents/header.xml', data: enc.encode(headerXml()) },
    { name: 'Contents/section0.xml', data: enc.encode(sectionXml) }
  ]);
}

if (typeof module !== 'undefined') {
  module.exports = { buildHwpxBytes, makeZip, crc32, xmlEsc };
}
