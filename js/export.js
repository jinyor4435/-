/**
 * 내보내기 — DOCX(docx.js), PPTX(PptxGenJS), PDF(브라우저 인쇄), HWP 호환(클립보드 HTML + 변환 안내).
 * HWP는 비공개 바이너리 포맷이라 직접 생성이 불가능하므로, 한글 2014+가 .docx를 직접 열 수 있는
 * 점을 이용해 "docx 다운로드 → 한글에서 열기 → .hwp로 저장" 경로를 안내한다.
 */

/* ─────────────── 개조식 텍스트 파서 (공용) ─────────────── */

/**
 * 섹션 본문을 라인 단위로 분류한다.
 * 반환: [{type:'table', rows:[[...]]}, {type:'h', text}, {type:'li', level, text}, {type:'p', text}]
 */
function parseContent(text) {
  const out = [];
  const lines = (text || '').split('\n');
  let table = null;

  const flushTable = () => {
    if (table && table.length) out.push({ type: 'table', rows: table });
    table = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushTable(); continue; }

    if (/^\|.*\|$/.test(line)) {
      const cells = line.slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 구분선 행
      if (!table) table = [];
      table.push(cells);
      continue;
    }
    flushTable();

    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) { out.push({ type: 'h', text: h[1] }); continue; }

    const m0 = line.match(/^[□■◆▶]\s*(.*)$/);
    if (m0) { out.push({ type: 'li', level: 0, text: m0[1] }); continue; }
    const m1 = line.match(/^[○◦●∙]\s*(.*)$/);
    if (m1) { out.push({ type: 'li', level: 1, text: m1[1] }); continue; }
    const m2 = line.match(/^[-–•*]\s+(.*)$/);
    if (m2) { out.push({ type: 'li', level: 2, text: m2[1] }); continue; }

    out.push({ type: 'p', text: line });
  }
  flushTable();
  return out;
}

const LI_MARKS = ['□ ', '○ ', '- '];

/** 굵게(**) 마크다운만 처리하는 미니 인라인 파서 → [{text, bold}] */
function parseInline(text) {
  const runs = [];
  const parts = String(text).split(/\*\*([^*]+)\*\*/);
  parts.forEach((p, i) => { if (p) runs.push({ text: p, bold: i % 2 === 1 }); });
  return runs.length ? runs : [{ text: String(text), bold: false }];
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inlineHtml(text) {
  return parseInline(text).map((r) => (r.bold ? '<b>' + esc(r.text) + '</b>' : esc(r.text))).join('');
}

/* ─────────────── HTML 조립 (미리보기 / PDF / HWP 클립보드 공용) ─────────────── */

function blocksToHtml(blocks) {
  return blocks.map((b) => {
    if (b.type === 'table') {
      const rows = b.rows.map((cells, ri) =>
        '<tr>' + cells.map((c) => (ri === 0 ? '<th>' + inlineHtml(c) + '</th>' : '<td>' + inlineHtml(c) + '</td>')).join('') + '</tr>'
      ).join('');
      return '<table>' + rows + '</table>';
    }
    if (b.type === 'h') return '<h3>' + inlineHtml(b.text) + '</h3>';
    if (b.type === 'li') {
      const mark = LI_MARKS[b.level] || '- ';
      return `<p class="li li${b.level}">${esc(mark)}${inlineHtml(b.text)}</p>`;
    }
    return '<p>' + inlineHtml(b.text) + '</p>';
  }).join('\n');
}

/** 사업계획서 전체 HTML (인쇄·클립보드·미리보기 공용 본문) */
function buildPlanHtml(project) {
  const idea = (project.ideas || [])[project.selectedIdeaIndex] || {};
  const title = (project.company && project.company.name ? project.company.name + ' — ' : '') +
    (idea.title || project.name || '사업계획서');
  const sections = getSections(project);
  const parts = [`<h1>${esc(title)}</h1>`];
  if (idea.oneLiner) parts.push(`<p class="subtitle">${esc(idea.oneLiner)}</p>`);
  for (const sec of sections) {
    const s = (project.sections || {})[sec.id];
    if (!s || !s.content) continue;
    parts.push(`<h2>${esc(sec.title)}</h2>`);
    parts.push(blocksToHtml(parseContent(s.content)));
  }
  return parts.join('\n');
}

const DOC_CSS = `
  body { font-family: '맑은 고딕', 'Malgun Gothic', 'Noto Sans KR', sans-serif;
         font-size: 11pt; line-height: 1.55; color: #111; margin: 2cm; }
  h1 { font-size: 17pt; border-bottom: 2px solid #1a3a6b; padding-bottom: 6px; }
  .subtitle { color: #444; margin-top: -4px; }
  h2 { font-size: 13pt; color: #1a3a6b; margin-top: 22px; border-left: 5px solid #1a3a6b; padding-left: 8px; }
  h3 { font-size: 11.5pt; margin: 12px 0 4px; }
  p { margin: 3px 0; }
  .li0 { font-weight: 600; margin-top: 8px; }
  .li1 { margin-left: 14pt; }
  .li2 { margin-left: 28pt; color: #222; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 10pt; }
  th, td { border: 1px solid #888; padding: 4px 8px; text-align: left; vertical-align: top; }
  th { background: #eef2f8; }
  @media print { h2 { break-after: avoid; } table { break-inside: avoid; } }
`;

/* ─────────────── PDF (인쇄 대화상자) ─────────────── */

function exportPdf(project) {
  const html = buildPlanHtml(project);
  const w = window.open('', '_blank');
  if (!w) { alert('팝업이 차단되었습니다. 이 사이트의 팝업을 허용해 주세요.'); return; }
  w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
    <title>사업계획서 PDF</title><style>${DOC_CSS}</style></head><body>${html}
    <script>window.onload = () => setTimeout(() => window.print(), 300);<\/script></body></html>`);
  w.document.close();
}

/* ─────────────── DOCX ─────────────── */

function blocksToDocxChildren(blocks) {
  const d = window.docx;
  const children = [];
  const runsOf = (text, opts) => parseInline(text).map((r) => new d.TextRun(Object.assign({ text: r.text, bold: r.bold || (opts && opts.bold) }, opts && opts.size ? { size: opts.size } : {})));

  for (const b of blocks) {
    if (b.type === 'table') {
      const rows = b.rows.map((cells, ri) => new d.TableRow({
        children: cells.map((c) => new d.TableCell({
          shading: ri === 0 ? { fill: 'EEF2F8' } : undefined,
          children: [new d.Paragraph({ children: runsOf(c, { bold: ri === 0, size: 20 }) })]
        }))
      }));
      children.push(new d.Table({ rows, width: { size: 100, type: d.WidthType.PERCENTAGE } }));
      children.push(new d.Paragraph({ text: '' }));
    } else if (b.type === 'h') {
      children.push(new d.Paragraph({ children: runsOf(b.text, { bold: true }), spacing: { before: 200, after: 80 } }));
    } else if (b.type === 'li') {
      const mark = LI_MARKS[b.level] || '- ';
      children.push(new d.Paragraph({
        children: runsOf(mark + b.text, b.level === 0 ? { bold: true } : {}),
        indent: { left: b.level * 340 },
        spacing: { before: b.level === 0 ? 160 : 40, after: 40 }
      }));
    } else {
      children.push(new d.Paragraph({ children: runsOf(b.text), spacing: { after: 60 } }));
    }
  }
  return children;
}

async function exportDocx(project) {
  const d = window.docx;
  const idea = (project.ideas || [])[project.selectedIdeaIndex] || {};
  const title = idea.title || project.name || '사업계획서';
  const sections = getSections(project);

  const children = [
    new d.Paragraph({
      children: [new d.TextRun({ text: title, bold: true, size: 40 })],
      spacing: { after: 120 }
    })
  ];
  if (idea.oneLiner) {
    children.push(new d.Paragraph({ children: [new d.TextRun({ text: idea.oneLiner, color: '444444' })], spacing: { after: 240 } }));
  }
  for (const sec of sections) {
    const s = (project.sections || {})[sec.id];
    if (!s || !s.content) continue;
    children.push(new d.Paragraph({
      children: [new d.TextRun({ text: sec.title, bold: true, size: 26, color: '1A3A6B' })],
      spacing: { before: 320, after: 120 },
      border: { left: { style: d.BorderStyle.SINGLE, size: 24, color: '1A3A6B', space: 6 } }
    }));
    children.push(...blocksToDocxChildren(parseContent(s.content)));
  }

  const doc = new d.Document({
    styles: { default: { document: { run: { font: '맑은 고딕', size: 22 } } } },
    sections: [{
      properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
      children
    }]
  });
  const blob = await d.Packer.toBlob(doc);
  downloadBlob(blob, sanitizeFilename(title) + '_사업계획서.docx');
}

/* ─────────────── PPTX (IR Deck) ─────────────── */

const DECK_COLORS = { navy: '1A3A6B', accent: '2E6BD6', gray: '555555', light: 'F4F6FA' };

function exportPptx(project) {
  const deck = project.deck;
  if (!deck || !Array.isArray(deck.slides) || !deck.slides.length) {
    alert('IR Deck 데이터가 없습니다. 5단계에서 Deck 결과를 먼저 저장해 주세요.');
    return;
  }
  const pptx = new window.PptxGenJS();
  pptx.defineLayout({ name: 'WIDE', width: 13.33, height: 7.5 });
  pptx.layout = 'WIDE';

  // 표지
  const cover = pptx.addSlide();
  cover.background = { color: DECK_COLORS.navy };
  cover.addText(deck.title || 'IR Deck', {
    x: 0.8, y: 2.6, w: 11.7, h: 1.4, fontSize: 40, bold: true, color: 'FFFFFF', fontFace: '맑은 고딕'
  });
  if (deck.subtitle) {
    cover.addText(deck.subtitle, { x: 0.8, y: 4.0, w: 11.7, h: 0.8, fontSize: 20, color: 'D9E2F2', fontFace: '맑은 고딕' });
  }
  if (project.company && project.company.name) {
    cover.addText(project.company.name, { x: 0.8, y: 6.5, w: 11.7, h: 0.5, fontSize: 14, color: '9FB4D8', fontFace: '맑은 고딕' });
  }

  deck.slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.18, fill: { color: DECK_COLORS.accent } });
    slide.addText(s.title || `슬라이드 ${i + 1}`, {
      x: 0.7, y: 0.5, w: 12, h: 1.0, fontSize: 27, bold: true, color: DECK_COLORS.navy, fontFace: '맑은 고딕'
    });
    const bullets = (s.bullets || []).map((b) => ({
      text: String(b),
      options: { bullet: { characterCode: '25AA', indent: 14 }, fontSize: 17, color: '222222', paraSpaceAfter: 10, fontFace: '맑은 고딕' }
    }));
    if (bullets.length) slide.addText(bullets, { x: 0.9, y: 1.7, w: 11.5, h: 4.2, valign: 'top' });
    if (s.visual) {
      slide.addText('시각자료 제안: ' + s.visual, {
        x: 0.9, y: 6.3, w: 11.5, h: 0.7, fontSize: 12, italic: true, color: DECK_COLORS.gray,
        fill: { color: DECK_COLORS.light }, fontFace: '맑은 고딕'
      });
    }
    if (s.script) slide.addNotes(s.script);
    slide.addText(String(i + 1), { x: 12.6, y: 7.0, w: 0.5, h: 0.4, fontSize: 10, color: '999999' });
  });

  pptx.writeFile({ fileName: sanitizeFilename(deck.title || project.name || 'IR_Deck') + '_IR_Deck.pptx' });
}

/* ─────────────── HWP 호환 ─────────────── */

async function copyHwpHtml(project) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${DOC_CSS}</style></head><body>${buildPlanHtml(project)}</body></html>`;
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([plainTextOf(project)], { type: 'text/plain' })
      })
    ]);
    return true;
  } catch (e) {
    // Safari/구형 브라우저 폴백
    try {
      const ta = document.createElement('textarea');
      ta.value = plainTextOf(project);
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      return true;
    } catch (e2) { return false; }
  }
}

function plainTextOf(project) {
  const sections = getSections(project);
  return sections.map((sec) => {
    const s = (project.sections || {})[sec.id];
    return s && s.content ? sec.title + '\n\n' + s.content : '';
  }).filter(Boolean).join('\n\n\n');
}

/* ─────────────── 공용 ─────────────── */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

/** 프로젝트 전체를 JSON 파일로 백업 */
function exportProjectJson(project) {
  const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
  downloadBlob(blob, sanitizeFilename(project.name || 'project') + '_백업.json');
}

if (typeof module !== 'undefined') {
  module.exports = { parseContent, parseInline, blocksToHtml, buildPlanHtml, plainTextOf, sanitizeFilename };
}
