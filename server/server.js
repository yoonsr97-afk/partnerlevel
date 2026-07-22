require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
const { getAuthClient } = require('./auth');
const { sendExamEmails } = require('./mailer');
const { generateCompanyResultPdf } = require('./certificate');
const { RESULT_SHEETS, fetchResultSheetRows, findExistingResult, appendResultRow } = require('./examResults');
const { generateAnswerKeyTemplate, gradePartnersFromForm } = require('./formsGrading');
const { getExamFormStatus, createExamForm, publishExamForm, deleteExamForm } = require('./formCreation');
const { matchExamResponses } = require('./examCheck');

const PORT = process.env.PORT || 4000;
const SERVER_ACCESS_KEY = process.env.SERVER_ACCESS_KEY;

// 세션 토큰 저장소 (메모리, 서버 재시작 시 초기화)
const sessions = new Map(); // token → { username, expiresAt }
const SESSION_TTL_MS = 30 * 60 * 1000; // 30분

function isAuthorized(req) {
  const key = req.query.key;
  if (!key) return false;
  // 기존 SERVER_ACCESS_KEY 방식 (하위 호환)
  if (SERVER_ACCESS_KEY && key === SERVER_ACCESS_KEY) return true;
  // 세션 토큰 방식
  const session = sessions.get(key);
  if (session && session.expiresAt > Date.now()) return true;
  return false;
}
const SERVICE_ACCOUNT_KEY_PATH = process.env.SERVICE_ACCOUNT_KEY_PATH
  ? path.resolve(__dirname, process.env.SERVICE_ACCOUNT_KEY_PATH)
  : path.join(__dirname, 'service-account.json');

// 시험 종류별 신청자 명단 스프레드시트 - 각 시험은 별도의 구글폼/스프레드시트를 사용한다
const EXAM_SHEETS = {
  NAC: {
    spreadsheetId: process.env.SPREADSHEET_ID_NAC,
    sheetName: process.env.SHEET_NAME_NAC || '설문지 응답 시트1',
  },
  EDR: {
    spreadsheetId: process.env.SPREADSHEET_ID_EDR,
    sheetName: process.env.SHEET_NAME_EDR || '설문지 응답 시트1',
  },
};

// 출석 여부를 나타내는 행 배경색 (Google Sheets 기본 팔레트, 0~1 RGB 비율)
const COLOR_PRESENT = { red: 1, green: 1, blue: 0 }; // 노랑 = 출석
const COLOR_ABSENT = { red: 1, green: 0, blue: 0 };  // 빨강 = 결석

function colorsMatch(a, b) {
  if (!a) return false;
  const round = (n) => Math.round((n || 0) * 100) / 100;
  return round(a.red) === round(b.red) && round(a.green) === round(b.green) && round(a.blue) === round(b.blue);
}

function resolveAttendance(backgroundColor) {
  if (colorsMatch(backgroundColor, COLOR_PRESENT)) return '출석';
  if (colorsMatch(backgroundColor, COLOR_ABSENT)) return '결석';
  return '신청만';
}

// 시트의 "타임스탬프" 셀 표시값(예: "2026. 6. 1 오후 3:06:21")에서 연/월/일을 추출한다
function extractDateParts(timestampText) {
  const match = timestampText.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
  if (!match) return null;
  const [, year, month, day] = match;
  return { year: Number(year), month: Number(month), day: Number(day) };
}

async function getSheetsClient() {
  return google.sheets({ version: 'v4', auth: getAuthClient(['https://www.googleapis.com/auth/spreadsheets']) });
}

// 시트(탭)의 내부 grid ID를 조회한다 - 색상 변경(batchUpdate)에 필요하다
async function getSheetGridId(sheetConfig) {
  const sheets = await getSheetsClient();
  const result = await sheets.spreadsheets.get({
    spreadsheetId: sheetConfig.spreadsheetId,
    fields: 'sheets.properties',
  });
  const target = result.data.sheets.find((s) => s.properties.title === sheetConfig.sheetName);
  if (!target) {
    throw new Error(`시트를 찾을 수 없습니다: ${sheetConfig.sheetName}`);
  }
  return target.properties.sheetId;
}

// 신청자 한 명(행)의 배경색을 출석/결석 색으로 바꾼다
async function setRowAttendanceColor(sheetConfig, rowIndex, status) {
  const sheets = await getSheetsClient();
  const gridId = await getSheetGridId(sheetConfig);
  const color = status === '출석' ? COLOR_PRESENT : COLOR_ABSENT;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sheetConfig.spreadsheetId,
    requestBody: {
      requests: [{
        repeatCell: {
          range: {
            sheetId: gridId,
            startRowIndex: rowIndex,
            endRowIndex: rowIndex + 1,
            // 컬럼 범위를 지정하지 않으면 행 전체(끝까지)에 색이 적용된다
          },
          cell: { userEnteredFormat: { backgroundColor: color } },
          fields: 'userEnteredFormat.backgroundColor',
        },
      }],
    },
  });
}

async function fetchPartnersFromSheet(sheetConfig, { targetMonth, targetYear }) {
  const sheets = await getSheetsClient();
  // 시트 이름에 공백/괄호 등 특수문자가 있어도 A1 표기법으로 정상 인식되도록 작은따옴표로 감싼다
  const quotedSheetName = `'${sheetConfig.sheetName.replace(/'/g, "''")}'`;
  const result = await sheets.spreadsheets.get({
    spreadsheetId: sheetConfig.spreadsheetId,
    ranges: [quotedSheetName],
    fields: 'sheets.data.rowData.values(formattedValue,userEnteredFormat.backgroundColor)',
  });

  const rows = (result.data.sheets[0].data[0].rowData) || [];
  if (rows.length === 0) return [];

  const getCellValue = (row, colIndex) => {
    const cell = row.values && row.values[colIndex];
    return (cell && cell.formattedValue) || '';
  };

  const headerRow = rows[0];
  const idx = (headerName) => {
    const values = headerRow.values || [];
    return values.findIndex((c) => c.formattedValue === headerName);
  };

  const idxTimestamp = idx('타임스탬프');
  const idxEmail = idx('이메일 주소');
  const idxMonth = idx('평가 월 선택');
  const idxCompany = idx('파트너명');
  const idxName = idx('평가자명');
  const idxPosition = idx('평가자 직급');
  // 결과 시트(평가현황)에 그대로 옮겨 적을 때 쓰는 필드들 - 1번 시트(신청서)에 동일한 헤더로 존재한다
  const idxItemSelection = idx('평가 항목 선택');
  const idxDepartment = idx('평가자 (소속 부서)');
  const idxPhone = idx('평가자 (휴대전화 번호)');
  const idxJiraId = idx('평가 통과시 발급될 이슈관리시스템(JIRA) 계정 ID ');

  const partners = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (getCellValue(row, idxMonth) !== targetMonth) continue;

    // "평가 월 선택"엔 연도가 없으므로, 타임스탬프의 실제 연도가 올해(targetYear)인 경우만 포함한다.
    // (이게 없으면 작년/재작년에 같은 월을 선택했던 과거 신청 건도 같이 잡힌다)
    const dateParts = extractDateParts(getCellValue(row, idxTimestamp));
    if (!dateParts || dateParts.year !== targetYear) continue;

    const firstCell = row.values && row.values[0];
    const rowColor = firstCell && firstCell.userEnteredFormat && firstCell.userEnteredFormat.backgroundColor;

    partners.push({
      name: getCellValue(row, idxName),
      email: getCellValue(row, idxEmail),
      company: getCellValue(row, idxCompany),
      position: getCellValue(row, idxPosition),
      department: getCellValue(row, idxDepartment),
      phone: getCellValue(row, idxPhone),
      jiraId: getCellValue(row, idxJiraId),
      itemSelection: getCellValue(row, idxItemSelection),
      applicationDate: `${dateParts.month}월 ${dateParts.day}일`,
      attendanceHint: resolveAttendance(rowColor),
      rowIndex: r, // 출석 변경 시 어느 행을 칠할지 식별하기 위한 시트상의 실제 행 위치(0-based)
    });
  }

  return partners;
}

// ALLOWED_ORIGINS: 쉼표로 구분된 허용 도메인 목록 (.env 또는 Railway 환경변수로 설정)
// 미설정 시 로컬 개발용으로 전체 허용
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim())
  : null;

const app = express();
app.use(cors({
  origin: (origin, callback) => {
    if (!ALLOWED_ORIGINS) return callback(null, true); // 로컬: 전체 허용
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS 차단: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json());

// 임시 진단 엔드포인트 - 배포 확인 후 삭제
app.get('/api/health', async (req, res) => {
  const hasJson = !!process.env.SERVICE_ACCOUNT_JSON;
  let parseOk = false;
  let parseError = null;
  if (hasJson) {
    try { JSON.parse(process.env.SERVICE_ACCOUNT_JSON); parseOk = true; }
    catch (e) { parseError = e.message; }
  }

  // Google API 네트워크 연결 테스트
  let googleReachable = false;
  let googleError = null;
  try {
    const { getAuthClient: _getAuth } = require('./auth');
    const client = _getAuth(['https://www.googleapis.com/auth/spreadsheets']);
    await client.getAccessToken();
    googleReachable = true;
  } catch (e) {
    googleError = e.message;
  }

  res.json({ ok: true, hasServiceAccountJson: hasJson, jsonParseOk: parseOk, parseError, googleReachable, googleError });
});

// 로그인 - 클라이언트에서 SHA-256 해시된 비밀번호를 받아 검증 후 세션 토큰 반환
app.post('/api/login', (req, res) => {
  const { username, passwordHash } = req.body || {};
  const storedUsername = process.env.ADMIN_USERNAME || 'admin';
  const storedHash = process.env.ADMIN_PASSWORD_HASH;

  if (!storedHash) return res.status(500).json({ error: '서버 계정 정보가 설정되지 않았습니다.' });
  if (!username || !passwordHash) return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });
  if (username !== storedUsername || passwordHash !== storedHash) {
    return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, { username, expiresAt });
  res.json({ token, expiresAt });
});

// 세션 갱신 - 30분 연장
app.post('/api/session/refresh', (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'session_expired' });
  const session = sessions.get(req.query.key);
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  res.json({ ok: true, expiresAt: session.expiresAt });
});

// 로그아웃
app.post('/api/logout', (req, res) => {
  const key = req.query.key;
  if (key) sessions.delete(key);
  res.json({ ok: true });
});

app.get('/api/partners', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const examType = (req.query.examType || 'NAC').toUpperCase();
  const sheetConfig = EXAM_SHEETS[examType];
  if (!sheetConfig || !sheetConfig.spreadsheetId) {
    return res.status(400).json({ error: `지원하지 않거나 설정되지 않은 examType: ${examType}` });
  }

  const now = new Date();
  const monthParam = req.query.month ? Number(req.query.month) : null;
  const targetYear = req.query.year ? Number(req.query.year) : now.getFullYear();
  const targetMonth = `${monthParam || now.getMonth() + 1}월`;

  try {
    const partners = await fetchPartnersFromSheet(sheetConfig, { targetMonth, targetYear });

    // 결과 시트(평가현황)에 이번 달 기록이 이미 있는 사람이 있으면 점수를 같이 내려준다
    // (있으면 프론트에서 그 점수를 그대로 표시하고 승인 버튼을 비활성화한다)
    const resultSheetConfig = RESULT_SHEETS[examType];
    if (resultSheetConfig && resultSheetConfig.spreadsheetId) {
      try {
        const targetMonthNumber = monthParam || now.getMonth() + 1;
        const sheetRows = await fetchResultSheetRows(resultSheetConfig, targetYear);
        partners.forEach((p) => {
          const existing = findExistingResult(sheetRows, {
            company: p.company,
            name: p.name,
            year: targetYear,
            month: targetMonthNumber,
          });
          if (existing) p.existingResult = existing;
        });
      } catch (err) {
        // 결과 시트 조회가 실패해도 신청자 명단 자체는 정상 반환한다 (결과 연동은 보조 기능)
        console.error('결과 시트 조회 실패 (신청자 명단은 정상 반환):', err.message);
      }
    }

    const resultSheetUrl = (resultSheetConfig && resultSheetConfig.spreadsheetId)
      ? `https://docs.google.com/spreadsheets/d/${resultSheetConfig.spreadsheetId}/edit`
      : null;

    res.json({ examType, month: targetMonth, partners, resultSheetUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 출석/결석 토글 시 호출 - 시트의 해당 행 배경색을 실제로 바꾼다 (편집자 권한 필요)
app.post('/api/attendance', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const examType = (req.body.examType || '').toUpperCase();
  const { rowIndex, status } = req.body;
  const sheetConfig = EXAM_SHEETS[examType];

  if (!sheetConfig || !sheetConfig.spreadsheetId) {
    return res.status(400).json({ error: `지원하지 않거나 설정되지 않은 examType: ${examType}` });
  }
  if (typeof rowIndex !== 'number' || (status !== '출석' && status !== '결석')) {
    return res.status(400).json({ error: 'rowIndex(number)와 status("출석"|"결석")가 필요합니다.' });
  }

  try {
    await setRowAttendanceColor(sheetConfig, rowIndex, status);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 시험 발송 - 출석 인원에게 평가 안내 메일을 보낸다 (한 명씩 개별 발송)
app.post('/api/send-exam-emails', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const examType = (req.body.examType || '').toUpperCase();
  const recipients = req.body.recipients;
  const level = req.body.level || '초급';
  const year = parseInt(req.body.year, 10) || new Date().getFullYear();
  const month = parseInt(req.body.month, 10) || (new Date().getMonth() + 1);

  if (!EXAM_SHEETS[examType]) {
    return res.status(400).json({ error: `지원하지 않는 examType: ${examType}` });
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ error: 'recipients 배열이 필요합니다.' });
  }

  // 공유 드라이브에서 해당 월 폼 URL 자동 조회 (폼이 아직 없으면 링크 없이 발송 진행,
  // 폼은 있는데 미게시 상태면 Drive 권한에 막히는 깨진 링크가 나갈 수 있으므로 발송을 막는다)
  let formUrl = '';
  try {
    const status = await getExamFormStatus(year, month, level);
    if (status.form && !status.form.published) {
      return res.status(409).json({
        error: `${year}년 ${month}월 ${level} 폼이 아직 게시되지 않았습니다. 먼저 게시한 뒤 발송해주세요.`,
      });
    }
    formUrl = status.form?.respondentUrl || '';
  } catch (e) {
    console.warn('시험 폼 URL 조회 실패 (링크 없이 발송):', e.message);
  }

  try {
    const result = await sendExamEmails(examType, recipients, { level, formUrl });
    res.json({ ...result, formUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 수료증(정기평가 결과 안내) - 같은 회사 소속 응시자 전원을 한 표에 묶어 PDF 1개로 생성한다.
// 점수/합격여부는 아직 서버에 저장되지 않는 더미 채점 데이터이므로, 프론트엔드가 회사 소속
// 응시자 목록(members)을 요청 본문에 함께 실어 보낸다.
app.post('/api/certificate', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { company, examType, year, month, members } = req.body;
  if (!company || !examType || !year || !month || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'company, examType, year, month, members가 필요합니다.' });
  }

  try {
    const pdfBuffer = await generateCompanyResultPdf({ company, examType, year, month, members });
    const filename = `${company}_${examType}_${year}${String(month).padStart(2, '0')}_평가결과.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 승인 시 호출 - 결과 시트(평가현황)에 이미 기록이 있으면 그대로 반환하고, 없으면 새 행을 추가한다.
app.post('/api/exam-result', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const examType = (req.body.examType || '').toUpperCase();
  const resultSheetConfig = RESULT_SHEETS[examType];
  if (!resultSheetConfig || !resultSheetConfig.spreadsheetId) {
    return res.status(400).json({ error: `지원하지 않거나 설정되지 않은 examType: ${examType}` });
  }

  const {
    company, name, department, position, phone, jiraId, itemSelection,
    email, month, year, objectiveScore, objectiveCorrectCount, subjectiveScore,
  } = req.body;

  if (!company || !name || !email || !month || !year || objectiveScore == null || subjectiveScore == null) {
    return res.status(400).json({ error: 'company, name, email, month, year, objectiveScore, subjectiveScore가 필요합니다.' });
  }

  try {
    // 다시 한번 중복 체크 - 그 사이 다른 요청으로 이미 기록됐다면 새로 쓰지 않고 기존 값을 돌려준다
    const sheetRows = await fetchResultSheetRows(resultSheetConfig, year);
    const existing = findExistingResult(sheetRows, { company, name, year, month });
    if (existing) {
      return res.json({ alreadyExists: true, ...existing });
    }

    const written = await appendResultRow(resultSheetConfig, year, {
      email, company, name, department, position, phone, jiraId, itemSelection,
      month, objectiveScore, objectiveCorrectCount: objectiveCorrectCount ?? null, subjectiveScore,
    });
    res.json({ success: true, ...written, sheetName: resultSheetConfig.sheetNameForYear(year) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================================================================
 * 정답 파일 템플릿 생성
 * 폼 URL을 받아 문항 구조(questionId 포함)를 읽고, 관리자가 정답만 채우면 되는
 * templates/answer-keys/NAC_{A|B|C}.json 파일을 생성한다.
 * ========================================================================= */
app.post('/api/generate-answer-template', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { formUrl, examType, formType } = req.body;
  if (!formUrl || !examType || !formType) {
    return res.status(400).json({ error: 'formUrl, examType, formType 이 필요합니다.' });
  }

  try {
    const template = await generateAnswerKeyTemplate(
      formUrl,
      examType.toUpperCase(),
      formType.toUpperCase()
    );
    res.json({ success: true, savedAs: `templates/answer-keys/${examType.toUpperCase()}_${formType.toUpperCase()}.json`, objectiveCount: template.objectiveQuestions.length, subjectiveCount: template.subjectiveQuestions.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================================================================
 * 시험 폼 자동 채점
 * 해당 월의 시험 폼을 공유 드라이브에서 이름으로 탐색(또는 formUrl 직접 제공)하여
 * 응답자 답변을 정답 파일과 비교한 뒤 파트너별 채점 결과를 반환한다.
 * ========================================================================= */
app.post('/api/grade-from-form', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { year, month, examType, level = '초급', formUrl, partners, skipSubjectiveGrading = false } = req.body;
  if (!year || !month || !examType || !Array.isArray(partners)) {
    return res.status(400).json({ error: 'year, month, examType, partners 가 필요합니다.' });
  }

  try {
    const result = await gradePartnersFromForm({
      year: Number(year),
      month: Number(month),
      examType: examType.toUpperCase(),
      level,
      formUrl: formUrl || null,
      partners,
      skipSubjectiveGrading,
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================================================================
 * 문제 폼 생성 API
 * ========================================================================= */

// 해당 월 폼 상태 조회 (생성여부·게시여부)
app.get('/api/exam-forms/status', async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const year = parseInt(req.query.year, 10);
  const month = parseInt(req.query.month, 10);
  const level = req.query.level || '초급';
  if (!year || !month) return res.status(400).json({ error: 'year, month 필요' });

  try {
    const status = await getExamFormStatus(year, month, level);
    res.json(status);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 폼 생성 (템플릿 복사)
app.post('/api/exam-forms/create', async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const { year, month, level = '초급' } = req.body;
  if (!year || !month) return res.status(400).json({ error: 'year, month 필요' });

  try {
    const result = await createExamForm(year, month, level);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 폼 게시 (링크 공개 + 응답 수락)
app.post('/api/exam-forms/publish', async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const { formId } = req.body;
  if (!formId) return res.status(400).json({ error: 'formId 필요' });

  try {
    const result = await publishExamForm(formId);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* =========================================================================
 * 응시 확인: 시험 폼 응답 조회 → 파트너 명단과 이름·사명 매칭
 * 프론트엔드에서 파트너 목록을 넘기면, 서버가 폼 응답자와 비교해
 * 미응시 → 응시 로 변경해야 할 사람 목록을 반환한다.
 * ========================================================================= */
app.post('/api/exam-check/match', async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const { year, month, level = '초급', partners } = req.body;
  if (!year || !month) return res.status(400).json({ error: 'year, month 필요' });
  if (!Array.isArray(partners)) return res.status(400).json({ error: 'partners 배열 필요' });

  try {
    const status = await getExamFormStatus(Number(year), Number(month), level);
    if (!status.form) {
      return res.status(404).json({ error: `${year}년 ${month}월 ${level} 시험 폼이 존재하지 않습니다. 문제 폼 생성 탭에서 먼저 생성하세요.` });
    }

    const result = await matchExamResponses(status.form.id, partners);
    res.json({ formName: status.form.name, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 폼 삭제 (Drive 파일 삭제 → 응답 데이터도 함께 삭제됨)
app.post('/api/exam-forms/delete', async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const { formId } = req.body;
  if (!formId) return res.status(400).json({ error: 'formId 필요' });

  try {
    const result = await deleteExamForm(formId);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`파트너 평가 자동화 서버 실행 중: http://localhost:${PORT}`);
});
