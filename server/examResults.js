/* =========================================================================
 * 시험 결과 시트("{연도} 파트너 평가현황(...)") 연동
 * -------------------------------------------------------------------------
 * 신청자 명단(1번 시트)과는 별도의, 회사에서 오래 운영해온 실제 결과 기록부다.
 * NAC과 EDR이 같은 스프레드시트의 서로 다른 탭에 들어있는데, 두 탭의 컬럼 구조가
 * 아예 다르다. 그래서 시험 종류별로 컬럼 맵과 행 생성 방식을 따로 들고 있고,
 * 공용 로직(탭 찾기 / 다음 빈 행 찾기 / 중복 확인)만 여기서 공유한다.
 *
 *  - NAC 초급: 한 행에 초급/중급/GPI가 같이 들어있어 "초급" 블록(B~Y열)만 읽고 쓴다.
 *    총점수(V)/결과(W)는 시트에 걸려있는 수식이라(`=S+U`, 판정 IF문) 새 행에도
 *    같은 수식을 복제해 넣어야 자동 계산된다 - 빈 행에는 수식이 없는 걸 확인했다.
 *  - EDR 초급: 수식이 전혀 없고 점수/총점이 값으로만 들어있다. 객관식·주관식 칸도
 *    "정답 개수"가 아니라 점수 그 자체다(NAC은 개수+점수 두 칸). 그래서 총점과
 *    합격 판정을 앱이 직접 계산해 값으로 기록한다.
 * ========================================================================= */
const { google } = require('googleapis');
const { getAuthClient } = require('./auth');

// 합격 기준 점수 (NAC/EDR 동일, 만점 100)
const PASSING_SCORE = 60;

/* -------------------------------------------------------------------------
 * NAC 초급 결과 탭 - 컬럼 인덱스 (0-based, A=0)
 * 구조가 오래 고정되어 있고 한 행에 여러 과정이 섞여 있어 위치로 고정한다.
 * ------------------------------------------------------------------------- */
const NAC_COL = {
  TIMESTAMP: 0,
  EMAIL: 1,
  VIDEO_TRAINING: 2,
  ITEM_SELECTION: 3,
  MONTH: 4,
  COMPANY: 5,
  COMPANY_ALT: 6,
  DEPARTMENT: 7,
  NAME: 8,
  POSITION: 9,
  PHONE: 10,
  TECH_LEAD_INFO: 11,
  TECH_LEAD_PHONE: 12,
  TECH_LEAD_EMAIL: 13,
  JIRA_ID: 14,
  ENTRY_MARK: 15, // "NAC초급 접수" - O 표시
  FORM_TYPE: 16, // 시험 유형 (A/B/C)
  OBJECTIVE_RAW: 17, // 객관식 정답 개수 (점수 ÷ 1.5로 역산해서 채운다)
  OBJECTIVE_SCORE: 18,
  SUBJECTIVE_RAW: 19, // 주관식 정답 개수 (점수 ÷ 4로 역산해서 채운다)
  SUBJECTIVE_SCORE: 20,
  TOTAL_SCORE: 21, // 수식: =S{row}+U{row}
  RESULT: 22, // 수식: IF(...)
  ACCOUNT_ISSUED: 23,
  ACCOUNT_RENEWED: 24,
};

/* -------------------------------------------------------------------------
 * EDR 초급 결과 탭 - 컬럼을 헤더 이름으로 찾는다.
 * 위치로 고정하지 않는 이유: 2025 탭과 2026 탭이 타임스탬프 유무로 한 칸씩
 * 밀려있던 전력이 있고, "결과" 컬럼이 나중에 어디에 추가될지에 따라 그 뒤가
 * 또 밀린다. 헤더 이름으로 찾으면 컬럼이 끼어들어도 그대로 동작한다.
 * ------------------------------------------------------------------------- */
const EDR_HEADER_MAP = {
  TIMESTAMP: ['타임스탬프'],
  EMAIL: ['이메일주소'],
  VIDEO_TRAINING: ['제조사동영상교육수강여부'],
  ITEM_SELECTION: ['평가항목선택'],
  MONTH: ['평가월선택'],
  COMPANY: ['파트너명', '파트너면'],
  COMPANY_ALT: ['파트너명(위에미존재시작성)', '파트너면(위에미존재시작성)'],
  DEPARTMENT: ['평가자(소속부서)'],
  NAME: ['평가자명'],
  POSITION: ['평가자직급'],
  PHONE: ['평가자(휴대전화번호)'],
  TECH_LEAD_INFO: ['평가자기술책임자(이름/직급)'],
  TECH_LEAD_PHONE: ['평가자기술책임자(휴대전화번호)'],
  TECH_LEAD_EMAIL: ['평가자기술책임자(이메일주소)'],
  JIRA_ID: ['평가통과시발급될이슈관리시스템(JIRA)계정ID'],
  ACCOUNT_ISSUED: ['계정발급'],
  ACCOUNT_RENEWED: ['계정갱신'],
  FORM_TYPE: ['시험유형'],
  OBJECTIVE_SCORE: ['객관식'],
  SUBJECTIVE_SCORE: ['주관식'],
  TOTAL_SCORE: ['점수', '총점수'],
  RESULT: ['결과'],
  REMARK: ['비고'],
};

// 헤더 텍스트 비교용 정규화 - 줄바꿈("시험\n유형")과 공백 차이를 무시한다
function normalizeHeader(text) {
  return String(text || '').replace(/\s+/g, '');
}

// "파트너명"과 "파트너명(위에 미존재시 작성)"처럼 한쪽이 다른 쪽의 접두사인 헤더가 있어서
// 부분일치로 찾으면 서로 잡아먹는다 - 완전일치만 인정한다.
function resolveColumnsByHeader(headerRow, headerMap) {
  const normalized = headerRow.map((cell) => normalizeHeader(cell && cell.formattedValue));
  const columns = {};
  for (const [key, candidates] of Object.entries(headerMap)) {
    for (const candidate of candidates) {
      const idx = normalized.indexOf(normalizeHeader(candidate));
      if (idx !== -1) {
        columns[key] = idx;
        break;
      }
    }
  }
  return columns;
}

function colLetter(index) {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/* -------------------------------------------------------------------------
 * 시험 종류별 결과 시트 설정
 * ------------------------------------------------------------------------- */
const RESULT_SHEETS = {
  NAC: {
    spreadsheetId: process.env.RESULTS_SPREADSHEET_ID_NAC,
    label: 'NAC 초급',
    // 탭 이름을 고정 문자열로 만들어 쓰다가, 2026년부터 NAC 탭이 초급/중급으로 분리되면서
    // "2026 파트너 평가현황(NAC)"이 사라져 승인이 통째로 실패했다(400 Unable to parse range).
    // 그래서 이름을 만들어 던지는 대신, 실제 탭 목록에서 이 패턴에 맞는 탭을 찾아 쓴다.
    //   2025 -> "2025 파트너 평가현황(NAC)"
    //   2026 -> "2026 파트너 평가현황(NAC 초급)"
    // 이 앱은 초급만 처리하므로 "중급" 탭은 패턴에서 의도적으로 제외한다.
    sheetNamePattern: (year) => new RegExp(`^${year}\\s*파트너\\s*평가현황\\s*\\(\\s*NAC(\\s*초급)?\\s*\\)$`),
    // 탭을 못 찾았을 때 사용자에게 보여줄 예시 이름
    sheetNameExample: (year) => `${year} 파트너 평가현황(NAC 초급)`,
    resolveColumns: () => NAC_COL,
    buildRow: buildNacRow,
  },
  EDR: {
    spreadsheetId: process.env.RESULTS_SPREADSHEET_ID_EDR || process.env.RESULTS_SPREADSHEET_ID_NAC,
    label: 'EDR 초급',
    sheetNamePattern: (year) => new RegExp(`^${year}\\s*파트너\\s*평가현황\\s*\\(\\s*EDR(\\s*초급)?\\s*\\)$`),
    sheetNameExample: (year) => `${year} 파트너 평가현황(EDR)`,
    resolveColumns: (headerRow) => resolveColumnsByHeader(headerRow, EDR_HEADER_MAP),
    buildRow: buildEdrRow,
    // EDR은 A형 한 종류뿐이다 (NAC처럼 월별로 A/B/C를 돌리지 않는다)
    fixedFormType: 'A',
  },
};

async function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthClient(['https://www.googleapis.com/auth/spreadsheets']) });
}

function getFormTypeForMonth(month) {
  const r = month % 3;
  if (r === 1) return 'A';
  if (r === 2) return 'B';
  return 'C';
}

// 시트(탭)의 내부 grid ID를 조회한다 - 정렬 서식 변경(batchUpdate)에 필요하다
async function getSheetGridId(spreadsheetId, sheetName) {
  const sheets = await getSheetsClient();
  const result = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties',
  });
  const target = result.data.sheets.find((s) => s.properties.title === sheetName);
  if (!target) throw new Error(`시트를 찾을 수 없습니다: ${sheetName}`);
  return target.properties.sheetId;
}

/**
 * 결과 시트에서 해당 연도의 탭 이름을 찾는다.
 *
 * 없는 탭 이름을 Sheets API에 그대로 넘기면 "Unable to parse range: '...'"라는,
 * 원인을 짐작하기 어려운 400이 돌아온다. 여기서 먼저 탭 목록을 조회해 맞춰보고
 * 못 찾으면 무엇을 확인해야 하는지 알려주는 메시지로 바꿔 던진다.
 * 던지는 에러에는 code='SHEET_TAB_NOT_FOUND'를 달아, 호출부가 서버 장애(500)가 아닌
 * 설정 문제(400)로 구분해 응답할 수 있게 한다.
 */
async function resolveSheetName(resultSheetConfig, year) {
  const sheets = await getSheetsClient();
  const result = await sheets.spreadsheets.get({
    spreadsheetId: resultSheetConfig.spreadsheetId,
    fields: 'sheets.properties.title',
  });
  const titles = result.data.sheets.map((s) => s.properties.title);

  const pattern = resultSheetConfig.sheetNamePattern(year);
  const matched = titles.find((title) => pattern.test(title.trim()));
  if (matched) return matched;

  const label = resultSheetConfig.label || '결과';
  const err = new Error(
    `${year}년 ${label} 결과 탭을 찾을 수 없습니다. `
    + `결과 시트에 "${resultSheetConfig.sheetNameExample(year)}" 형식의 탭이 있는지 확인해 주세요. `
    + `(현재 탭 목록: ${titles.join(', ')})`
  );
  err.code = 'SHEET_TAB_NOT_FOUND';
  throw err;
}

// 결과 시트 전체를 읽어온다 (행 매칭/다음 빈 행 탐색에 공용으로 쓴다)
async function fetchResultSheetRows(resultSheetConfig, year) {
  const sheets = await getSheetsClient();
  const sheetName = await resolveSheetName(resultSheetConfig, year);
  const quotedSheetName = `'${sheetName.replace(/'/g, "''")}'`;

  const result = await sheets.spreadsheets.get({
    spreadsheetId: resultSheetConfig.spreadsheetId,
    ranges: [quotedSheetName],
    fields: 'sheets.data.rowData.values(formattedValue)',
  });

  const rows = (result.data.sheets[0].data[0].rowData) || [];
  const headerRow = (rows[0] && rows[0].values) || [];
  const columns = resultSheetConfig.resolveColumns(headerRow);

  if (columns.EMAIL == null) {
    const err = new Error(
      `${sheetName} 탭에서 "이메일 주소" 컬럼을 찾을 수 없습니다. 헤더 행(1행)이 바뀌었는지 확인해 주세요.`
    );
    err.code = 'SHEET_COLUMN_NOT_FOUND';
    throw err;
  }

  // 시트 서식이 데이터 없는 행까지 넓게 적용되어 있어서, rowData 길이만으론 "다음 빈 행"을
  // 알 수 없다 - 이메일 컬럼이 실제로 채워진 마지막 행을 직접 찾는다.
  let lastDataRowIndex = 0; // 0 = 헤더만 있고 데이터 없음
  for (let r = 1; r < rows.length; r++) {
    const cell = rows[r].values && rows[r].values[columns.EMAIL];
    if (cell && cell.formattedValue) lastDataRowIndex = r;
  }

  return { rows, lastDataRowIndex, sheetName, columns };
}

function getCellValue(row, colIndex) {
  if (colIndex == null) return '';
  const cell = row && row.values && row.values[colIndex];
  return (cell && cell.formattedValue) || '';
}

// 파트너명+평가자명+평가월로 기존 기록을 찾는다.
// 연도는 별도로 비교하지 않는다 - 이 시트 자체가 연도별로 탭이 나뉘어 있어서
// (resolveSheetName(year)로 이미 그 해의 탭만 골라 읽기 때문에) 탭 선택이 곧 연도 필터다.
// 실제 데이터를 까보니 타임스탬프가 비어있는 행이 많아(수동 입력/이관된 과거 행 등),
// 타임스탬프 기준 연도 교차검증을 하면 그런 행들을 못 찾는 문제가 있었다.
function findExistingResult(sheetRows, { company, name, month }) {
  const targetMonth = `${month}월`;
  const { rows, columns } = sheetRows;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (getCellValue(row, columns.COMPANY).trim() !== String(company).trim()) continue;
    if (getCellValue(row, columns.NAME).trim() !== String(name).trim()) continue;
    if (getCellValue(row, columns.MONTH) !== targetMonth) continue;

    return {
      objectiveScore: Number(getCellValue(row, columns.OBJECTIVE_SCORE)) || 0,
      subjectiveScore: Number(getCellValue(row, columns.SUBJECTIVE_SCORE)) || 0,
      totalScore: Number(getCellValue(row, columns.TOTAL_SCORE)) || 0,
      result: getCellValue(row, columns.RESULT),
    };
  }
  return null;
}

// NAC 기존 행들을 보면 객관식/주관식 "점수"는 정답 개수(원점수)에 고정 배율을 곱한 값이다
// (객관식 raw*1.5=점수, 주관식 raw*4=점수 - 여러 실제 행으로 확인됨). 이 앱은 정답 개수를
// 직접 알 수 없으니, 반대로 점수를 배율로 나눠 원점수 칸을 채운다.
const OBJECTIVE_SCORE_MULTIPLIER = 1.5;
const SUBJECTIVE_SCORE_MULTIPLIER = 4;

// 휴대전화/JIRA 계정ID처럼 숫자로만 이뤄질 수 있는 텍스트는 USER_ENTERED가 숫자로 잘못
// 해석해서 앞자리 0을 날려버린다(예: "01051139066" -> 1051139066). 맨 앞에 작은따옴표를
// 붙이면 Sheets가 무조건 텍스트로 받아들이고, 작은따옴표 자체는 저장되지 않는다.
const asText = (value) => (value ? `'${value}` : '');
// 점수 ÷ 배율로 역산한 정답 개수는 소수점이 길게 나올 수 있어(예: 32/1.5=21.333...) 1자리로 반올림한다
const round1 = (value) => Math.round(value * 10) / 10;

function buildTimestamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

/* -------------------------------------------------------------------------
 * NAC 초급 행 생성 - A~Y열을 순서대로 채운다.
 * 총점수(V)/결과(W)는 시트에 걸려있던 수식을 그대로 복제해 넣는다.
 * ------------------------------------------------------------------------- */
function buildNacRow({ data, targetRow }) {
  const formType = getFormTypeForMonth(data.month);
  const totalFormula = `=S${targetRow}+U${targetRow}`;
  const resultFormula = `=if(isblank(P${targetRow}),"",if(AND(P${targetRow} = "O",isblank(V${targetRow})),"미응시",if(V${targetRow} >= ${PASSING_SCORE} , "합격", "불합격")))`;

  const values = [
    buildTimestamp(), // A 타임스탬프
    data.email || '', // B 이메일 주소
    '', // C 제조사 동영상 교육 수강 여부 - 앱이 모르는 값
    data.itemSelection || '', // D 평가 항목 선택
    `${data.month}월`, // E 평가 월 선택
    data.company || '', // F 파트너명
    '', // G 파트너명(위에 미존재시 작성)
    data.department || '', // H 평가자 (소속 부서)
    data.name || '', // I 평가자명
    data.position || '', // J 평가자 직급
    asText(data.phone), // K 평가자 (휴대전화 번호)
    '', '', '', // L M N - 기술책임자 관련, 앱이 모르는 값
    asText(data.jiraId), // O JIRA 계정 ID
    'O', // P NAC초급 접수
    formType, // Q 시험 유형
    data.objectiveCorrectCount != null
      ? data.objectiveCorrectCount
      : round1(data.objectiveScore / OBJECTIVE_SCORE_MULTIPLIER), // R 객관식 정답 개수 (직접값 우선, 없으면 역산)
    data.objectiveScore, // S 객관식 점수
    round1(data.subjectiveScore / SUBJECTIVE_SCORE_MULTIPLIER), // T 주관식(정답 개수, 점수 역산)
    data.subjectiveScore, // U 주관식 점수
    totalFormula, // V 총점수 (수식)
    resultFormula, // W 결과 (수식)
    '', // X 계정발급 - 비워둠
    '', // Y 계정갱신 - 비워둠
  ];

  return {
    startColumnIndex: 0,
    values,
    formType,
    // 기존 데이터 행과 동일하게: B~O열 왼쪽 정렬, P~Y열(접수~계정갱신) 가운데 정렬
    alignments: [
      { start: 1, end: 15, horizontalAlignment: 'LEFT' },
      { start: 15, end: 25, horizontalAlignment: 'CENTER' },
    ],
  };
}

/* -------------------------------------------------------------------------
 * EDR 초급 행 생성 - 수식이 없는 시트라 총점과 합격 판정을 직접 계산해 값으로 넣는다.
 * 객관식/주관식 칸은 "정답 개수"가 아니라 점수 그 자체다(NAC과 다른 점).
 * 시험 유형은 A형만 운영하므로 'A' 고정, 계정발급/계정갱신은 비워둔다.
 * ------------------------------------------------------------------------- */
function buildEdrRow({ data, columns, sheetName }) {
  const objectiveScore = Number(data.objectiveScore) || 0;
  const subjectiveScore = Number(data.subjectiveScore) || 0;
  const totalScore = round1(objectiveScore + subjectiveScore);

  const cells = {
    TIMESTAMP: buildTimestamp(),
    EMAIL: data.email || '',
    ITEM_SELECTION: data.itemSelection || '',
    MONTH: `${data.month}월`,
    COMPANY: data.company || '',
    DEPARTMENT: data.department || '',
    NAME: data.name || '',
    POSITION: data.position || '',
    PHONE: asText(data.phone),
    JIRA_ID: asText(data.jiraId),
    ACCOUNT_ISSUED: '', // 비워둠
    ACCOUNT_RENEWED: '', // 비워둠
    FORM_TYPE: RESULT_SHEETS.EDR.fixedFormType,
    OBJECTIVE_SCORE: objectiveScore,
    SUBJECTIVE_SCORE: subjectiveScore,
    TOTAL_SCORE: totalScore,
    RESULT: totalScore >= PASSING_SCORE ? '합격' : '불합격',
  };

  // "결과" 컬럼이 아직 없는 탭에서는 판정을 기록할 자리가 없다 - 점수까지만 쓰고 경고를 남긴다.
  // (컬럼을 추가하면 헤더 이름으로 자동 인식되어 다음 기록부터 채워진다)
  if (columns.RESULT == null) {
    delete cells.RESULT;
    console.warn(
      `${sheetName} 탭에 "결과" 컬럼이 없어 합격/불합격 판정을 기록하지 못했습니다. `
      + `헤더 행에 "결과" 열을 추가하면 자동으로 함께 기록됩니다. (계산된 판정: ${totalScore >= PASSING_SCORE ? '합격' : '불합격'})`
    );
  }

  const writtenIndexes = Object.keys(cells)
    .map((key) => columns[key])
    .filter((idx) => idx != null);
  if (writtenIndexes.length === 0) {
    throw new Error(`${sheetName} 탭에서 기록할 컬럼을 찾지 못했습니다.`);
  }
  const lastIndex = Math.max(...writtenIndexes);

  // 값 배열은 A열부터 연속이어야 해서, 자리를 못 찾은 컬럼은 빈 문자열로 남긴다.
  // (빈 문자열은 기존 값을 지우므로, 새 행에만 쓰는 지금 흐름에서만 안전하다)
  const values = new Array(lastIndex + 1).fill('');
  for (const [key, value] of Object.entries(cells)) {
    if (columns[key] != null) values[columns[key]] = value;
  }

  const alignments = [];
  if (columns.EMAIL != null && columns.JIRA_ID != null) {
    alignments.push({ start: columns.EMAIL, end: columns.JIRA_ID + 1, horizontalAlignment: 'LEFT' });
    alignments.push({ start: columns.JIRA_ID + 1, end: lastIndex + 1, horizontalAlignment: 'CENTER' });
  }

  return {
    startColumnIndex: 0,
    values,
    formType: RESULT_SHEETS.EDR.fixedFormType,
    alignments,
  };
}

/* -------------------------------------------------------------------------
 * 새 결과 행 추가 (시험 종류별 buildRow를 호출해 만든 값을 그대로 기록한다)
 * ------------------------------------------------------------------------- */
async function appendResultRow(resultSheetConfig, year, data) {
  const sheets = await getSheetsClient();
  const { lastDataRowIndex, sheetName, columns } = await fetchResultSheetRows(resultSheetConfig, year);
  const quotedSheetName = `'${sheetName.replace(/'/g, "''")}'`;
  const targetRow = lastDataRowIndex + 2; // rowData는 0-based, 시트 행 번호는 1-based + 헤더 1행

  const { values, formType, alignments } = resultSheetConfig.buildRow({ data, columns, targetRow, sheetName });
  const endColumn = colLetter(values.length - 1);

  await sheets.spreadsheets.values.update({
    spreadsheetId: resultSheetConfig.spreadsheetId,
    range: `${quotedSheetName}!A${targetRow}:${endColumn}${targetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [values] },
  });

  // 정렬을 기존 데이터 행과 동일하게 맞춘다
  const gridId = await getSheetGridId(resultSheetConfig.spreadsheetId, sheetName);
  if (alignments.length > 0) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: resultSheetConfig.spreadsheetId,
      requestBody: {
        requests: alignments.map((a) => ({
          repeatCell: {
            range: {
              sheetId: gridId,
              startRowIndex: targetRow - 1,
              endRowIndex: targetRow,
              startColumnIndex: a.start,
              endColumnIndex: a.end,
            },
            cell: { userEnteredFormat: { horizontalAlignment: a.horizontalAlignment } },
            fields: 'userEnteredFormat.horizontalAlignment',
          },
        })),
      },
    });
  }

  return { row: targetRow, formType, spreadsheetId: resultSheetConfig.spreadsheetId, sheetGid: gridId, sheetName };
}

module.exports = {
  RESULT_SHEETS,
  PASSING_SCORE,
  resolveSheetName,
  fetchResultSheetRows,
  findExistingResult,
  appendResultRow,
  getFormTypeForMonth,
};
