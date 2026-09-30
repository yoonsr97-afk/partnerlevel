require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { google } = require('googleapis');
const { getAuthClient } = require('./auth');
const { sendExamEmails } = require('./mailer');
const { generateCompanyResultPdf, EXAM_TYPE_LABELS } = require('./certificate');
const { sendCertificateNotice, findChannel, listMappedCompanies, TEST_CHANNEL_ID } = require('./slack');
const { RESULT_SHEETS, fetchResultSheetRows, findExistingResult, appendResultRow } = require('./examResults');
const { generateAnswerKeyTemplate, gradePartnersFromForm } = require('./formsGrading');
const { getExamFormStatus, createExamForm, publishExamForm, deleteExamForm } = require('./formCreation');
const { matchExamResponses } = require('./examCheck');

const PORT = process.env.PORT || 4000;

// 세션 토큰 저장소 (메모리, 서버 재시작 시 초기화)
const sessions = new Map(); // token → { username, expiresAt }
const SESSION_TTL_MS = 30 * 60 * 1000; // 30분

/* -------------------------------------------------------------------------
 * 비밀번호 검증
 *
 * 브라우저는 비밀번호 원문을 보내고, 해싱은 서버에서만 한다.
 * 예전에는 브라우저가 SHA-256 해시를 만들어 보내고 서버가 저장된 해시와
 * 문자열 비교만 했는데, 그러면 저장된 해시 자체가 비밀번호가 되어버린다
 * (해시를 손에 넣은 사람은 원문을 몰라도 그대로 보내면 로그인된다).
 *
 * ADMIN_PASSWORD_HASH 가 bcrypt 해시($2a$/$2b$/$2y$로 시작)면 bcrypt로 검증하고,
 * 아직 예전 64자리 SHA-256 값이면 그 방식으로 검증한다. 운영 중에 환경변수를
 * 바꾸기 전까지 로그인이 막히지 않게 하기 위한 한시적 경로다.
 * ------------------------------------------------------------------------- */
function looksLikeBcryptHash(hash) {
  return /^\$2[aby]\$\d{2}\$/.test(hash);
}

function looksLikeLegacySha256(hash) {
  return /^[a-f0-9]{64}$/i.test(hash);
}

// 길이가 다르면 timingSafeEqual이 예외를 던져서 먼저 걸러낸다
function safeEqual(a, b) {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

let legacyHashWarned = false;

async function verifyPassword(password, storedHash) {
  if (looksLikeBcryptHash(storedHash)) {
    return bcrypt.compare(password, storedHash);
  }

  if (looksLikeLegacySha256(storedHash)) {
    if (!legacyHashWarned) {
      console.warn('[보안] ADMIN_PASSWORD_HASH가 아직 SHA-256입니다. '
        + 'node tools/hash-password.js 로 bcrypt 해시를 만들어 교체해 주세요.');
      legacyHashWarned = true;
    }
    const digest = crypto.createHash('sha256').update(password, 'utf8').digest('hex');
    return safeEqual(digest, storedHash.toLowerCase());
  }

  // 형식을 모르면 통과시키지 않는다 - 설정 실수로 인증이 무력화되는 편보다 낫다
  throw new Error('ADMIN_PASSWORD_HASH 형식을 인식할 수 없습니다. bcrypt 해시로 설정해 주세요.');
}

/* -------------------------------------------------------------------------
 * 로그인 시도 제한
 *
 * 계정이 admin 하나뿐이라 시도 횟수를 막지 않으면 계속 두드려볼 수 있다.
 * IP와 계정 두 축으로 나눠서 센다.
 *   - IP 기준은 엄격하게: 5회 실패부터 잠그고 실패할수록 잠금이 길어진다.
 *   - 계정 기준은 느슨하게: 여러 IP를 쓰는 공격을 막되, 공격자가 일부러
 *     실패시켜 진짜 관리자를 잠가버리는 상황(서비스 거부)을 피해야 해서
 *     한계를 훨씬 높게 두고 잠금 시간도 고정이다.
 * ------------------------------------------------------------------------- */
const IP_FAIL_LIMIT = 5;
const IP_LOCK_BASE_MS = 30 * 1000;      // 6회째 30초, 이후 실패마다 2배
const IP_LOCK_MAX_MS = 30 * 60 * 1000;  // 최대 30분
const ACCOUNT_FAIL_LIMIT = 20;
const ACCOUNT_LOCK_MS = 15 * 60 * 1000;
const ATTEMPT_TTL_MS = 60 * 60 * 1000;  // 1시간 조용하면 기록을 버린다

const loginAttempts = new Map(); // key → { fails, lockedUntil, seenAt }

function getAttempt(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.seenAt > ATTEMPT_TTL_MS) {
    const fresh = { fails: 0, lockedUntil: 0, seenAt: now };
    loginAttempts.set(key, fresh);
    return fresh;
  }
  entry.seenAt = now;
  return entry;
}

// 잠겨 있으면 남은 시간(ms), 아니면 0
function lockRemaining(key) {
  const entry = loginAttempts.get(key);
  if (!entry) return 0;
  return Math.max(0, entry.lockedUntil - Date.now());
}

function recordFailure(key, { limit, lockMs, escalate }) {
  const entry = getAttempt(key);
  entry.fails += 1;
  if (entry.fails >= limit) {
    const over = entry.fails - limit;
    entry.lockedUntil = Date.now() + (escalate
      ? Math.min(lockMs * Math.pow(2, over), IP_LOCK_MAX_MS)
      : lockMs);
  }
  return entry;
}

function clearAttempts(...keys) {
  keys.forEach((k) => loginAttempts.delete(k));
}

// 만료된 기록을 주기적으로 버린다 (놔두면 Map이 계속 커진다)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of loginAttempts) {
    if (now - entry.seenAt > ATTEMPT_TTL_MS) loginAttempts.delete(key);
  }
}, 10 * 60 * 1000).unref();

/* 로그인으로 발급된 세션 토큰만 인정한다.
 * 예전에는 SERVER_ACCESS_KEY라는 고정 키로도 통과시켰는데, 만료가 없어서
 * 한 번 새면 영구 관리자 권한이 되고 로그인 체계를 통째로 우회했다. */
function isAuthorized(req) {
  const key = req.query.key;
  if (!key) return false;
  const session = sessions.get(key);
  return !!(session && session.expiresAt > Date.now());
}
const SERVICE_ACCOUNT_KEY_PATH = process.env.SERVICE_ACCOUNT_KEY_PATH
  ? path.resolve(__dirname, process.env.SERVICE_ACCOUNT_KEY_PATH)
  : path.join(__dirname, 'service-account.json');

// 시험 종류별 신청자 명단 스프레드시트
// NAC과 GPI는 같은 신청서(같은 시트)를 쓰고 "평가 항목 선택" 값으로만 구분된다.
// 한 사람이 "NAC 초급 (신규), GPI 초급 (신규)"처럼 둘 다 신청할 수 있어서,
// itemKeyword 포함 여부로 거른다(둘 다 신청했으면 양쪽 탭에 모두 나타난다).
// EDR은 전용 신청서라 걸러낼 필요가 없다.
const EXAM_SHEETS = {
  NAC: {
    spreadsheetId: process.env.SPREADSHEET_ID_NAC,
    sheetName: process.env.SHEET_NAME_NAC || '설문지 응답 시트1',
    itemKeyword: 'NAC 초급',
  },
  EDR: {
    spreadsheetId: process.env.SPREADSHEET_ID_EDR,
    sheetName: process.env.SHEET_NAME_EDR || '설문지 응답 시트1',
    itemKeyword: null,
  },
  NAC_MID: {
    spreadsheetId: process.env.SPREADSHEET_ID_NAC_MID || process.env.SPREADSHEET_ID_NAC,
    sheetName: process.env.SHEET_NAME_NAC_MID || process.env.SHEET_NAME_NAC || '설문지 응답 시트1',
    itemKeyword: 'NAC 중급',
  },
  GPI: {
    spreadsheetId: process.env.SPREADSHEET_ID_GPI || process.env.SPREADSHEET_ID_NAC,
    sheetName: process.env.SHEET_NAME_GPI || process.env.SHEET_NAME_NAC || '설문지 응답 시트1',
    itemKeyword: 'GPI',
  },
};

// 평가 수준은 시험 종류가 결정한다 - NAC_MID만 중급이고 나머지는 전부 초급이다.
// 프론트에서 넘어오는 level은 무시한다. 예전에는 화면의 초급/중급 토글 값을 그대로 썼는데,
// 그러면 "Genian EDR 중급"처럼 존재하지 않는 평가명으로 안내 메일이 나갈 수 있었다.
function normalizeLevel(examType) {
  return examType === 'NAC_MID' ? '중급' : '초급';
}

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

    // NAC/GPI는 같은 신청서를 공유하므로 "평가 항목 선택"으로 이 시험 신청 건만 골라낸다
    if (sheetConfig.itemKeyword
      && !getCellValue(row, idxItemSelection).toUpperCase().includes(sheetConfig.itemKeyword)) continue;

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
// Railway는 프록시 뒤에서 앱을 돌린다. 이 설정이 없으면 req.ip가 프록시 주소로
// 고정되어, 로그인 시도 제한이 모든 접속자를 한 덩어리로 묶어버린다.
app.set('trust proxy', 1);
app.use(cors({
  origin: (origin, callback) => {
    if (!ALLOWED_ORIGINS) return callback(null, true); // 로컬: 전체 허용
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS 차단: ${origin}`));
  },
  credentials: true,
}));
// Slack 발송 시 첨부 파일을 base64로 실어 보내서 기본값(100kb)으로는 부족하다.
// base64는 원본보다 약 1/3 커지므로 여유를 두고 잡는다.
app.use(express.json({ limit: '30mb' }));

/* 살아있는지만 알려준다. Railway 헬스체크가 이 경로를 볼 수 있어 남겨두되,
 * 인증 없이 열려 있는 만큼 서버 내부 사정은 하나도 싣지 않는다.
 * 설정 상태는 아래 /api/diagnostics 에서 로그인한 뒤에 본다. */
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

/* 배포 후 설정 점검용. 예전에는 이 내용이 /api/health로 인증 없이 나갔다.
 * Google 토큰까지 실제로 받아보므로 헬스체크처럼 자주 부를 것은 아니다. */
app.get('/api/diagnostics', async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

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

// 로그인 - 비밀번호를 받아 서버에서 검증하고 세션 토큰을 돌려준다
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const storedUsername = process.env.ADMIN_USERNAME || 'admin';
  const storedHash = process.env.ADMIN_PASSWORD_HASH;

  if (!storedHash) return res.status(500).json({ error: '서버 계정 정보가 설정되지 않았습니다.' });

  // 예전 화면이 브라우저에 캐시된 경우 - 비밀번호 대신 해시를 보낸다
  if (!password && req.body && req.body.passwordHash) {
    return res.status(400).json({ error: '페이지가 오래되었습니다. 새로고침(Ctrl+Shift+R) 후 다시 로그인해 주세요.' });
  }
  if (!username || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요.' });

  const ipKey = `ip:${req.ip}`;
  const accountKey = `user:${String(username).toLowerCase()}`;

  // 잠금 확인 - 비밀번호를 대조하기 전에 막는다
  const locked = Math.max(lockRemaining(ipKey), lockRemaining(accountKey));
  if (locked > 0) {
    const minutes = Math.ceil(locked / 60000);
    return res.status(429).json({
      error: `로그인 시도가 많아 잠시 차단되었습니다. ${minutes}분 후 다시 시도해 주세요.`,
      retryAfterMs: locked,
    });
  }

  let passwordOk = false;
  try {
    passwordOk = await verifyPassword(password, storedHash);
  } catch (err) {
    console.error('[로그인] 비밀번호 검증 실패:', err.message);
    return res.status(500).json({ error: '서버 계정 설정에 문제가 있습니다. 관리자에게 문의해 주세요.' });
  }

  // 아이디가 틀려도 비밀번호 대조는 이미 끝난 뒤라 응답 시간으로 아이디 존재 여부를 알기 어렵다
  if (!safeEqual(String(username), storedUsername) || !passwordOk) {
    const ipEntry = recordFailure(ipKey, { limit: IP_FAIL_LIMIT, lockMs: IP_LOCK_BASE_MS, escalate: true });
    recordFailure(accountKey, { limit: ACCOUNT_FAIL_LIMIT, lockMs: ACCOUNT_LOCK_MS, escalate: false });
    if (ipEntry.lockedUntil > Date.now()) {
      console.warn(`[로그인] ${req.ip} 차단 - 실패 ${ipEntry.fails}회`);
    }
    const left = Math.max(0, IP_FAIL_LIMIT - ipEntry.fails);
    return res.status(401).json({
      error: left > 0 && left <= 2
        ? `아이디 또는 비밀번호가 올바르지 않습니다. (${left}회 더 실패하면 일시 차단됩니다)`
        : '아이디 또는 비밀번호가 올바르지 않습니다.',
    });
  }

  clearAttempts(ipKey, accountKey);

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
  const level = normalizeLevel(examType);
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
    const status = await getExamFormStatus(year, month, level, examType);
    if (status.form && !status.form.published) {
      return res.status(409).json({
        error: `${year}년 ${month}월 ${examType} ${level} 폼이 아직 게시되지 않았습니다. 먼저 게시한 뒤 발송해주세요.`,
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
    res.json({ success: true, ...written });
  } catch (err) {
    console.error(err);
    // 결과 탭/컬럼을 못 찾은 건 서버 장애가 아니라 시트 설정 문제라, 원인이 드러나는 400으로 구분해 내려준다
    if (err.code === 'SHEET_TAB_NOT_FOUND' || err.code === 'SHEET_COLUMN_NOT_FOUND') {
      return res.status(400).json({ error: err.message, code: err.code });
    }
    res.status(500).json({ error: err.message });
  }
});

/* 첨부 파일 검증 - 화면에서 base64로 실어 보낸 것을 Buffer로 되돌린다.
 * Slack 업로드 전에 개수/크기/형식을 걸러 실패를 앞당긴다. */
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 파일당 10MB
const MAX_ATTACHMENT_TOTAL = 20 * 1024 * 1024; // 합계 20MB

function decodeAttachments(raw) {
  if (!raw) return [];
  if (!Array.isArray(raw)) throw new Error('attachments는 배열이어야 합니다.');
  if (raw.length > MAX_ATTACHMENTS) {
    throw new Error(`첨부는 최대 ${MAX_ATTACHMENTS}개까지 가능합니다. (요청 ${raw.length}개)`);
  }

  let total = 0;
  return raw.map((a, i) => {
    const filename = String((a && a.filename) || '').trim();
    if (!filename) throw new Error(`${i + 1}번째 첨부의 파일명이 없습니다.`);
    if (!a.data) throw new Error(`"${filename}"의 내용이 비어 있습니다.`);

    const buffer = Buffer.from(String(a.data), 'base64');
    if (buffer.length === 0) throw new Error(`"${filename}"을 읽지 못했습니다.`);
    if (buffer.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`"${filename}"이 너무 큽니다. 파일당 ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB까지 가능합니다.`);
    }
    total += buffer.length;
    if (total > MAX_ATTACHMENT_TOTAL) {
      throw new Error(`첨부 합계가 ${MAX_ATTACHMENT_TOTAL / 1024 / 1024}MB를 넘습니다.`);
    }

    return { filename, buffer, contentType: a.contentType || 'application/octet-stream' };
  });
}

/* =========================================================================
 * 수료증 Slack 발송
 * 파트너사 채널에 결과 안내 메시지를 올리면서 수료증 PDF를 본문에 첨부한다.
 * 수료증은 회사 단위 문서라 발송도 회사 단위로 한 번만 나간다.
 * ========================================================================= */
app.post('/api/slack-certificate', async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { company, examType, year, month, members } = req.body;
  // test=true 면 파트너사 채널 대신 테스트 채널로 보낸다 (문구/첨부 형태 확인용)
  const isTest = req.body.test === true;
  if (!company || !examType || !year || !month || !Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'company, examType, year, month, members가 필요합니다.' });
  }

  // 관리자가 직접 고른 추가 첨부 (base64로 실려온다). 수료증 뒤에 순서대로 붙는다.
  let extraFiles;
  try {
    extraFiles = decodeAttachments(req.body.attachments);
  } catch (err) {
    return res.status(400).json({ error: err.message, code: 'INVALID_ATTACHMENT' });
  }

  // 채널이 등록되지 않은 파트너사는 PDF를 만들기 전에 막는다 (불필요한 변환 비용 방지).
  // 테스트 발송은 고정 채널로 나가므로 이 검사를 건너뛴다.
  if (!isTest && !findChannel(company)) {
    return res.status(400).json({
      error: `"${company}"의 Slack 채널이 등록되어 있지 않습니다. server/slackChannels.json에 추가해 주세요.`,
      code: 'SLACK_CHANNEL_NOT_MAPPED',
    });
  }

  try {
    const examLabel = EXAM_TYPE_LABELS[examType] || examType;
    const pdfBuffer = await generateCompanyResultPdf({ company, examType, year, month, members });
    const filename = `${company}_${examLabel}_${year}${String(month).padStart(2, '0')}_평가결과.pdf`;

    const result = await sendCertificateNotice({
      company, examLabel, year, month, pdfBuffer, filename, isTest, extraFiles,
    });
    res.json({ success: true, ...result, memberCount: members.length });
  } catch (err) {
    console.error(err);
    // 설정/권한 문제는 서버 장애가 아니라 관리자가 고칠 수 있는 문제라 400으로 구분한다
    const configErrors = ['SLACK_NOT_CONFIGURED', 'SLACK_CHANNEL_NOT_MAPPED', 'not_in_channel',
      'channel_not_found', 'invalid_auth', 'not_authed', 'missing_scope', 'token_revoked'];
    const status = configErrors.includes(err.code) ? 400 : 500;
    res.status(status).json({ error: err.message, code: err.code || null });
  }
});

// Slack 연동 상태 확인 - 토큰 설정 여부와 채널이 등록된 파트너사 목록
app.get('/api/slack-status', (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({
    configured: !!(process.env.SLACK_BOT_TOKEN || '').trim(),
    mappedCompanies: listMappedCompanies(),
    testChannelId: TEST_CHANNEL_ID,
  });
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

  const { year, month, examType, formUrl, partners, skipSubjectiveGrading = false } = req.body;
  const level = normalizeLevel((examType || '').toUpperCase());
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
  const examType = (req.query.examType || 'NAC').toUpperCase();
  const level = normalizeLevel(examType);
  if (!year || !month) return res.status(400).json({ error: 'year, month 필요' });

  try {
    const status = await getExamFormStatus(year, month, level, examType);
    res.json(status);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// 폼 생성 (템플릿 복사)
app.post('/api/exam-forms/create', async (req, res) => {
  if (!isAuthorized(req)) return res.status(401).json({ error: 'unauthorized' });

  const { year, month } = req.body;
  const examType = (req.body.examType || 'NAC').toUpperCase();
  const level = normalizeLevel(examType);
  if (!year || !month) return res.status(400).json({ error: 'year, month 필요' });

  try {
    const result = await createExamForm(year, month, level, examType);
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

  const { year, month, partners } = req.body;
  const examType = (req.body.examType || 'NAC').toUpperCase();
  const level = normalizeLevel(examType);
  if (!year || !month) return res.status(400).json({ error: 'year, month 필요' });
  if (!Array.isArray(partners)) return res.status(400).json({ error: 'partners 배열 필요' });

  try {
    const status = await getExamFormStatus(Number(year), Number(month), level, examType);
    if (!status.form) {
      return res.status(404).json({ error: `${year}년 ${month}월 ${examType} ${level} 시험 폼이 존재하지 않습니다. 문제 폼 생성 탭에서 먼저 생성하세요.` });
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
