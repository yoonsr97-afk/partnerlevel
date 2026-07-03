/* =========================================================================
 * 수료증(정기평가 결과 안내) 생성
 * -------------------------------------------------------------------------
 * server/templates/ 에 있는 예시 docx(회사/이름/종류/점수/결과 표가 포함된 결과
 * 안내문)를 그대로 양식으로 사용한다. 표의 예시 데이터 행 1개를 "행 템플릿"으로
 * 추출해 실제 회사 소속 응시자 수만큼 복제·치환한 뒤, Word(COM 자동화)로 PDF
 * 변환까지 수행한다. 문서는 회사 단위로 1개 생성되며(같은 회사 응시자는 모두
 * 한 표 안에 같이 들어간다), 개인별 다운로드 버튼은 같은 파일을 내려받는다.
 * ========================================================================= */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const JSZip = require('jszip');

const TEMPLATE_PATH = path.join(__dirname, 'templates', '2026년_05월_정기평가_결과안내_글로웰시스템.docx');

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function findTagRanges(xml, openTagPrefix, closeTag) {
  const ranges = [];
  let idx = 0;
  while (true) {
    const s = xml.indexOf(openTagPrefix, idx);
    if (s === -1) break;
    const e = xml.indexOf(closeTag, s) + closeTag.length;
    ranges.push([s, e]);
    idx = e;
  }
  return ranges;
}

// 템플릿 원본의 결과 셀 색상 - 합격은 파랑(2F5496), 불합격은 빨강(C00000)으로 이미 스타일링되어 있다
const RESULT_COLOR = { 합격: '2F5496', 불합격: 'C00000' };

/* 표의 데이터 행 1개(김철수 행)를 받아 실제 회사/이름/종류/점수/결과 값으로 치환한다 */
function fillRow(templateRowXml, { company, name, typeLabel, score, result }) {
  let row = templateRowXml;
  row = row.replace('>글로웰시스템<', `>${escapeXml(company)}<`);
  row = row.replace('>김철수<', `>${escapeXml(name)}<`);
  row = row.replace(
    '<w:r><w:t xml:space="preserve">NAC </w:t></w:r><w:r><w:t>초급</w:t></w:r>',
    `<w:r><w:t xml:space="preserve">${escapeXml(typeLabel)}</w:t></w:r>`
  );
  row = row.replace('>89<', `>${escapeXml(score)}<`);
  // 템플릿 행이 "합격"(파랑) 스타일이므로, 결과 텍스트뿐 아니라 색상(w:color)도 결과에 맞게 같이 바꿔준다
  row = row.replace(
    '<w:r><w:rPr><w:b/><w:bCs/><w:color w:val="2F5496"/></w:rPr><w:t>합격</w:t></w:r>',
    `<w:r><w:rPr><w:b/><w:bCs/><w:color w:val="${RESULT_COLOR[result] || '2F5496'}"/></w:rPr><w:t>${escapeXml(result)}</w:t></w:r>`
  );
  return row;
}

/* members: [{ name, score, result }], company/examType/year/month는 문서 전체에 공통 적용 */
async function buildResultDocxBuffer({ company, examType, year, month, members }) {
  const zip = await JSZip.loadAsync(fs.readFileSync(TEMPLATE_PATH));
  let xml = await zip.file('word/document.xml').async('string');

  const tblStart = xml.indexOf('<w:tbl>');
  const tblEnd = xml.indexOf('</w:tbl>') + '</w:tbl>'.length;
  const tblXml = xml.slice(tblStart, tblEnd);

  const rows = findTagRanges(tblXml, '<w:tr ', '</w:tr>');
  // rows[0] = 헤더(회사/이름/종류/점수/결과 라벨), rows[1]/rows[2] = 예시 데이터 행(김철수/김미영)
  const templateRow = tblXml.slice(rows[1][0], rows[1][1]);

  const typeLabel = `${examType} 초급`;
  const newRowsXml = members
    .map((m) => fillRow(templateRow, { company, name: m.name, typeLabel, score: m.score, result: m.result }))
    .join('');

  const newTblXml = tblXml.slice(0, rows[1][0]) + newRowsXml + tblXml.slice(rows[2][1]);
  xml = xml.slice(0, tblStart) + newTblXml + xml.slice(tblEnd);

  // 머리말의 "2026년 05월" 날짜를 실제 선택된 연/월로 치환
  xml = xml.replace('<w:t>2026</w:t>', `<w:t>${year}</w:t>`);
  xml = xml.replace('<w:t xml:space="preserve"> 05</w:t>', `<w:t xml:space="preserve"> ${String(month).padStart(2, '0')}</w:t>`);

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer' });
}

function convertDocxToPdf(docxPath, pdfPath) {
  return new Promise((resolve, reject) => {
    // LibreOffice headless: Ubuntu는 soffice, Windows에 LibreOffice 설치 시에도 동작
    const outDir = path.dirname(docxPath);
    execFile('soffice', [
      '--headless',
      '--convert-to', 'pdf',
      '--outdir', outDir,
      docxPath,
    ], (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      // LibreOffice는 입력파일명 기반으로 PDF 생성 → pdfPath와 동일하므로 그대로 사용
      resolve();
    });
  });
}

async function generateCompanyResultPdf({ company, examType, year, month, members }) {
  const docxBuffer = await buildResultDocxBuffer({ company, examType, year, month, members });

  const tmpId = crypto.randomBytes(8).toString('hex');
  const docxPath = path.join(os.tmpdir(), `result-${tmpId}.docx`);
  const pdfPath = path.join(os.tmpdir(), `result-${tmpId}.pdf`);

  fs.writeFileSync(docxPath, docxBuffer);
  try {
    await convertDocxToPdf(docxPath, pdfPath);
    return fs.readFileSync(pdfPath);
  } finally {
    fs.unlink(docxPath, () => {});
    fs.unlink(pdfPath, () => {});
  }
}

module.exports = { generateCompanyResultPdf };
