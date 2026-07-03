/* =========================================================================
 * 시험 결과 시트(예: "2026 파트너 평가현황(NAC)") 연동
 * -------------------------------------------------------------------------
 * 신청자 명단(1번 시트)과는 별도의, 회사에서 오래 운영해온 실제 결과 기록부다.
 * 한 행에 NAC초급/중급/GPI 결과가 같이 들어있는 구조라, 이 앱은 그 중 "초급"
 * 블록(B~Y열)만 읽고 쓴다. 총점수(V열)/결과(W열)는 시트에 미리 걸려있는 수식이라
 * (`=S{row}+U{row}`, 결과 판정 IF문) 그 패턴을 새 행에도 그대로 복제해 넣어야
 * 자동 계산된다 - 데이터 없는 행에는 수식이 비어있는 걸 직접 확인했다.
 * EDR은 아직 미연동(요청 범위 밖) - RESULT_SHEETS에 EDR을 추가하면 자동으로 켜진다.
 * ========================================================================= */
const path = require('path');
const { google } = require('googleapis');
const { getAuthClient } = require('./auth');

const RESULT_SHEETS = {
  NAC: {
    spreadsheetId: process.env.RESULTS_SPREADSHEET_ID_NAC,
    // 탭 이름이 "{연도} 파트너 평가현황(NAC)" 패턴이라 연도만 끼워 넣으면 매년 그대로 동작한다
    sheetNameForYear: (year) => `${year} 파트너 평가현황(NAC)`,
  },
};

// 결과 시트의 "초급" 블록 컬럼 인덱스 (0-based, A=0)
const COL = {
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

// 결과 시트 전체를 읽어온다 (행 매칭/다음 빈 행 탐색에 공용으로 쓴다)
async function fetchResultSheetRows(resultSheetConfig, year) {
  const sheets = await getSheetsClient();
  const sheetName = resultSheetConfig.sheetNameForYear(year);
  const quotedSheetName = `'${sheetName.replace(/'/g, "''")}'`;

  const result = await sheets.spreadsheets.get({
    spreadsheetId: resultSheetConfig.spreadsheetId,
    ranges: [quotedSheetName],
    fields: 'sheets.data.rowData.values(formattedValue)',
  });

  const rows = (result.data.sheets[0].data[0].rowData) || [];

  // 시트 서식이 데이터 없는 행까지 넓게 적용되어 있어서, rowData 길이만으론 "다음 빈 행"을
  // 알 수 없다 - 이메일 컬럼이 실제로 채워진 마지막 행을 직접 찾는다.
  let lastDataRowIndex = 0; // 0 = 헤더만 있고 데이터 없음
  for (let r = 1; r < rows.length; r++) {
    const cell = rows[r].values && rows[r].values[COL.EMAIL];
    if (cell && cell.formattedValue) lastDataRowIndex = r;
  }

  return { rows, lastDataRowIndex, sheetName };
}

function getCellValue(row, colIndex) {
  const cell = row && row.values && row.values[colIndex];
  return (cell && cell.formattedValue) || '';
}

// 파트너명+평가자명+평가월로 기존 기록을 찾는다.
// 연도는 별도로 비교하지 않는다 - 이 시트 자체가 연도별로 탭이 나뉘어 있어서
// (sheetNameForYear(year)로 이미 그 해의 탭만 골라 읽기 때문에) 탭 선택이 곧 연도 필터다.
// 실제 데이터를 까보니 타임스탬프가 비어있는 행이 많아(수동 입력/이관된 과거 행 등),
// 타임스탬프 기준 연도 교차검증을 하면 그런 행들을 못 찾는 문제가 있었다.
function findExistingResult(sheetRows, { company, name, month }) {
  const targetMonth = `${month}월`;
  const { rows } = sheetRows;

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (getCellValue(row, COL.COMPANY).trim() !== String(company).trim()) continue;
    if (getCellValue(row, COL.NAME).trim() !== String(name).trim()) continue;
    if (getCellValue(row, COL.MONTH) !== targetMonth) continue;

    return {
      objectiveScore: Number(getCellValue(row, COL.OBJECTIVE_SCORE)) || 0,
      subjectiveScore: Number(getCellValue(row, COL.SUBJECTIVE_SCORE)) || 0,
      totalScore: Number(getCellValue(row, COL.TOTAL_SCORE)) || 0,
      result: getCellValue(row, COL.RESULT),
    };
  }
  return null;
}

// 기존 행들을 보면 객관식/주관식 "점수"는 정답 개수(원점수)에 고정 배율을 곱한 값이다
// (객관식 raw*1.5=점수, 주관식 raw*4=점수 - 여러 실제 행으로 확인됨). 이 앱은 정답 개수를
// 직접 알 수 없으니, 반대로 점수를 배율로 나눠 원점수 칸을 채운다.
const OBJECTIVE_SCORE_MULTIPLIER = 1.5;
const SUBJECTIVE_SCORE_MULTIPLIER = 4;

// 새 결과 행을 추가한다 - 총점수/결과 컬럼에는 기존 행들과 동일한 수식을 그대로 복제해 넣어
// USER_ENTERED로 기록하면, 시트에서 보이는 동작은 "점수만 넣으면 자동 계산"과 동일해진다.
async function appendResultRow(resultSheetConfig, year, data) {
  const sheets = await getSheetsClient();
  const { lastDataRowIndex, sheetName } = await fetchResultSheetRows(resultSheetConfig, year);
  const quotedSheetName = `'${sheetName.replace(/'/g, "''")}'`;
  const targetRow = lastDataRowIndex + 2; // rowData는 0-based, 시트 행 번호는 1-based + 헤더 1행

  const formType = getFormTypeForMonth(data.month);
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

  const totalFormula = `=S${targetRow}+U${targetRow}`;
  const resultFormula = `=if(isblank(P${targetRow}),"",if(AND(P${targetRow} = "O",isblank(V${targetRow})),"미응시",if(V${targetRow} >= 60 , "합격", "불합격")))`;

  // 휴대전화/JIRA 계정ID처럼 숫자로만 이뤄질 수 있는 텍스트는 USER_ENTERED가 숫자로 잘못
  // 해석해서 앞자리 0을 날려버린다(예: "01051139066" -> 1051139066). 맨 앞에 작은따옴표를
  // 붙이면 Sheets가 무조건 텍스트로 받아들이고, 작은따옴표 자체는 저장되지 않는다.
  const asText = (value) => (value ? `'${value}` : '');
  // 점수 ÷ 배율로 역산한 정답 개수는 소수점이 길게 나올 수 있어(예: 32/1.5=21.333...) 1자리로 반올림한다
  const round1 = (value) => Math.round(value * 10) / 10;

  const rowValues = [
    timestamp, // A 타임스탬프
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

  await sheets.spreadsheets.values.update({
    spreadsheetId: resultSheetConfig.spreadsheetId,
    range: `${quotedSheetName}!A${targetRow}:Y${targetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [rowValues] },
  });

  // 정렬: B~O열은 왼쪽 정렬, P~Y열(접수~계정갱신)은 가운데 정렬 - 기존 데이터 행과 동일하게 맞춘다
  const gridId = await getSheetGridId(resultSheetConfig.spreadsheetId, sheetName);
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: resultSheetConfig.spreadsheetId,
    requestBody: {
      requests: [
        {
          repeatCell: {
            range: { sheetId: gridId, startRowIndex: targetRow - 1, endRowIndex: targetRow, startColumnIndex: 1, endColumnIndex: 15 },
            cell: { userEnteredFormat: { horizontalAlignment: 'LEFT' } },
            fields: 'userEnteredFormat.horizontalAlignment',
          },
        },
        {
          repeatCell: {
            range: { sheetId: gridId, startRowIndex: targetRow - 1, endRowIndex: targetRow, startColumnIndex: 15, endColumnIndex: 25 },
            cell: { userEnteredFormat: { horizontalAlignment: 'CENTER' } },
            fields: 'userEnteredFormat.horizontalAlignment',
          },
        },
      ],
    },
  });

  return { row: targetRow, formType, spreadsheetId: resultSheetConfig.spreadsheetId, sheetGid: gridId };
}

module.exports = {
  RESULT_SHEETS,
  fetchResultSheetRows,
  findExistingResult,
  appendResultRow,
  getFormTypeForMonth,
};
