/* =========================================================================
 * 파트너 평가 자동화 시스템 - app.js
 * 전역 state 객체를 단일 데이터 소스로 사용하며,
 * 탭 간 데이터는 state.partnersByExam[state.examType] 배열을 공유하여 연결된다.
 * (파트너 목록 -> 출석 -> 응시 -> 채점 -> 승인 -> 합격자)
 * NAC/EDR은 신청자 명단부터 합격자 확인까지 전 과정이 완전히 분리되어 있고,
 * 상단의 시험 종류 선택(NAC/EDR)으로 어느 쪽을 보고 조작할지 전환한다.
 * ========================================================================= */

/* =========================================================================
 * 로그인 / 세션 관리
 * ========================================================================= */

/* 비밀번호는 원문 그대로 서버에 보내고 해싱은 서버에서만 한다(HTTPS로 보호된다).
 * 예전에는 여기서 SHA-256 해시를 만들어 보냈는데, 그러면 서버에 저장된 해시가
 * 그대로 로그인 자격증명이 되어 해시를 아는 사람은 비밀번호 없이 들어올 수 있었다. */

/* ── 세션 타이머 ── */
let sessionExpiresAt = null;
let sessionTimerInterval = null;
let sessionWarningShown = false;
const SESSION_WARNING_MS = 3 * 60 * 1000; // 3분 전 경고

function formatRemaining(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

function showSessionWarning() {
  document.getElementById('sessionWarningPopup').classList.remove('hidden');
}

function hideSessionWarning() {
  document.getElementById('sessionWarningPopup').classList.add('hidden');
}

function updateSessionTimerBadge(remaining) {
  const badge = document.getElementById('sessionTimerBadge');
  const display = document.getElementById('sessionTimerDisplay');
  if (!badge || !display) return;

  badge.classList.remove('hidden');
  display.textContent = formatRemaining(remaining);

  const WARN_MS = 5 * 60 * 1000;   // 5분 이하 → 노란색
  const CRIT_MS = 3 * 60 * 1000;   // 3분 이하 → 빨간 + 깜빡임

  badge.classList.toggle('warning', remaining <= WARN_MS && remaining > CRIT_MS);
  badge.classList.toggle('critical', remaining <= CRIT_MS);
}

function startSessionTimer(expiresAt) {
  sessionExpiresAt = expiresAt;
  sessionWarningShown = false;
  hideSessionWarning();
  clearInterval(sessionTimerInterval);

  // 즉시 한 번 렌더
  updateSessionTimerBadge(sessionExpiresAt - Date.now());

  sessionTimerInterval = setInterval(() => {
    const remaining = sessionExpiresAt - Date.now();

    if (remaining <= 0) {
      clearInterval(sessionTimerInterval);
      hideSessionWarning();
      const badge = document.getElementById('sessionTimerBadge');
      if (badge) badge.classList.add('hidden');
      handleSessionExpired();
      return;
    }

    updateSessionTimerBadge(remaining);

    if (remaining <= SESSION_WARNING_MS && !sessionWarningShown) {
      sessionWarningShown = true;
      showSessionWarning();
    }

    if (sessionWarningShown) {
      document.getElementById('sessionWarningCountdown').textContent = formatRemaining(remaining);
    }
  }, 1000);
}

function handleSessionExpired() {
  sessionStorage.removeItem('sessionToken');
  SHEETS_ACCESS_KEY = '';
  clearInterval(sessionTimerInterval);
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginUsername').value = '';
  const errEl = document.getElementById('loginError');
  errEl.textContent = '세션이 만료되었습니다. 다시 로그인해주세요.';
  errEl.classList.remove('hidden');
}

async function handleSessionRefresh() {
  const btn = document.getElementById('sessionRefreshBtn');
  if (btn) { btn.disabled = true; btn.textContent = '갱신 중...'; }
  try {
    const res = await fetch(`${SHEETS_API_BASE_URL}/api/session/refresh?key=${encodeURIComponent(SHEETS_ACCESS_KEY)}`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    sessionWarningShown = false;
    hideSessionWarning();
    startSessionTimer(data.expiresAt);
    showToast('세션이 30분 연장되었습니다.');
  } catch {
    handleSessionExpired();
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '세션 갱신'; }
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorEl = document.getElementById('loginError');
  const btn = document.getElementById('loginBtn');

  if (!username || !password) {
    errorEl.textContent = '아이디와 비밀번호를 입력해주세요.';
    errorEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = '로그인 중...';
  errorEl.classList.add('hidden');

  try {
    const res = await fetch(`${SHEETS_API_BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || '로그인에 실패했습니다.');

    // 2차 인증이 켜져 있으면 세션 대신 인증 코드 입력 단계로 넘어간다
    if (data.mfaRequired) {
      showMfaStep(data);
      return;
    }

    completeLogin(data);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '로그인';
  }
}

/* ── 2차 인증 (Slack DM 코드) ── */
let pendingMfaToken = null;

function completeLogin(data) {
  sessionStorage.setItem('sessionToken', data.token);
  SHEETS_ACCESS_KEY = data.token;
  document.getElementById('loginOverlay').classList.add('hidden');
  startSessionTimer(data.expiresAt);
}

let mfaCountdownTimer = null;
let mfaResendTimer = null;
let mfaResendsLeft = 0;

/* 코드 유효 시간이 1분이라 남은 시간을 보여준다.
 * 안 보여주면 조용히 만료돼서 왜 안 되는지 알 수 없다. */
function startMfaCountdown(expiresInMs) {
  const el = document.getElementById('mfaCountdown');
  const deadline = Date.now() + (expiresInMs || 60000);

  clearInterval(mfaCountdownTimer);
  const tick = () => {
    const left = Math.max(0, deadline - Date.now());
    if (left <= 0) {
      clearInterval(mfaCountdownTimer);
      mfaCountdownTimer = null;
      el.textContent = '코드가 만료되었습니다. 다시 받아주세요.';
      el.classList.add('mfa-countdown-expired');
      return;
    }
    el.textContent = `${Math.ceil(left / 1000)}초 남음`;
  };

  el.classList.remove('mfa-countdown-expired');
  tick();
  mfaCountdownTimer = setInterval(tick, 1000);
}

/* 재전송 버튼은 쿨다운이 끝날 때까지 잠근다.
 * 서버도 같은 간격으로 막고 있어서, 여기서만 열어봐야 429만 돌아온다. */
function startMfaResendCooldown(cooldownMs) {
  const btn = document.getElementById('mfaResendBtn');
  const until = Date.now() + (cooldownMs || 15000);

  clearInterval(mfaResendTimer);
  const tick = () => {
    const left = Math.max(0, until - Date.now());
    if (left <= 0) {
      clearInterval(mfaResendTimer);
      mfaResendTimer = null;
      btn.disabled = mfaResendsLeft <= 0;
      btn.textContent = mfaResendsLeft > 0 ? `코드 재전송 (${mfaResendsLeft}회 남음)` : '재전송 횟수 초과';
      return;
    }
    btn.disabled = true;
    btn.textContent = `코드 재전송 (${Math.ceil(left / 1000)}초)`;
  };

  tick();
  mfaResendTimer = setInterval(tick, 1000);
}

function stopMfaTimers() {
  clearInterval(mfaCountdownTimer);
  clearInterval(mfaResendTimer);
  mfaCountdownTimer = null;
  mfaResendTimer = null;
}

function showMfaStep(data) {
  pendingMfaToken = data.mfaToken;
  mfaResendsLeft = data.resendsLeft || 0;
  document.getElementById('mfaOverlay').classList.remove('hidden');
  document.getElementById('mfaError').classList.add('hidden');
  startMfaCountdown(data.expiresInMs);
  startMfaResendCooldown(data.resendCooldownMs);
  const input = document.getElementById('mfaCode');
  input.value = '';
  input.focus();
}

// 팝업을 닫고 비밀번호 단계로 되돌린다.
// 서버의 코드는 그대로 두고 시간이 지나면 알아서 버려진다.
function closeMfaStep() {
  pendingMfaToken = null;
  stopMfaTimers();
  document.getElementById('mfaOverlay').classList.add('hidden');
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').classList.add('hidden');
  document.getElementById('loginPassword').focus();
}

async function handleMfaResend() {
  const btn = document.getElementById('mfaResendBtn');
  const errorEl = document.getElementById('mfaError');
  btn.disabled = true;
  errorEl.classList.add('hidden');

  try {
    const res = await fetch(`${SHEETS_API_BASE_URL}/api/login/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaToken: pendingMfaToken }),
    });
    const data = await res.json();

    if (!res.ok) {
      if (data.code === 'MFA_EXPIRED') return expireMfaToLogin(data.error);
      throw new Error(data.error || '재전송에 실패했습니다.');
    }

    mfaResendsLeft = data.resendsLeft;
    startMfaCountdown(data.expiresInMs);
    startMfaResendCooldown(data.resendCooldownMs);
    const input = document.getElementById('mfaCode');
    input.value = '';
    input.focus();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
    btn.disabled = false;
  }
}

// 코드가 완전히 폐기된 경우 - 팝업을 닫고 비밀번호부터 다시 받는다
function expireMfaToLogin(message) {
  closeMfaStep();
  const loginError = document.getElementById('loginError');
  loginError.textContent = message;
  loginError.classList.remove('hidden');
}

async function handleMfaVerify(e) {
  e.preventDefault();
  const code = document.getElementById('mfaCode').value.trim();
  const errorEl = document.getElementById('mfaError');
  const btn = document.getElementById('mfaBtn');

  if (!code) {
    errorEl.textContent = '인증 코드를 입력해주세요.';
    errorEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = '확인 중...';
  errorEl.classList.add('hidden');

  try {
    const res = await fetch(`${SHEETS_API_BASE_URL}/api/login/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mfaToken: pendingMfaToken, code }),
    });
    const data = await res.json();

    if (!res.ok) {
      // 코드가 폐기된 경우(시간 초과, 여러 번 틀림)에는 비밀번호부터 다시 받는다
      if (data.code === 'MFA_EXPIRED' || data.code === 'MFA_RESEND_LIMIT') {
        return expireMfaToLogin(data.error);
      }
      throw new Error(data.error || '인증에 실패했습니다.');
    }

    stopMfaTimers();
    document.getElementById('mfaOverlay').classList.add('hidden');
    completeLogin(data);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '확인';
  }
}

function handleLogout() {
  const token = sessionStorage.getItem('sessionToken');
  if (token) {
    fetch(`${SHEETS_API_BASE_URL}/api/logout?key=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
    sessionStorage.removeItem('sessionToken');
    SHEETS_ACCESS_KEY = '';
  }
  clearInterval(sessionTimerInterval);
  hideSessionWarning();
  // 로그인 화면으로 복귀
  document.getElementById('loginOverlay').classList.remove('hidden');
  document.getElementById('loginPassword').value = '';
  document.getElementById('loginError').classList.add('hidden');
  document.getElementById('loginUsername').value = '';
}

async function initLogin() {
  const token = sessionStorage.getItem('sessionToken');
  if (token) {
    // 서버에 토큰 유효성 확인 - 서버 재시작 등으로 세션이 사라졌을 경우 로그인 화면으로
    try {
      const res = await fetch(
        `${SHEETS_API_BASE_URL}/api/session/refresh?key=${encodeURIComponent(token)}`,
        { method: 'POST' }
      );
      if (res.ok) {
        const data = await res.json();
        SHEETS_ACCESS_KEY = token;
        document.getElementById('loginOverlay').classList.add('hidden');
        startSessionTimer(data.expiresAt);
      } else {
        sessionStorage.removeItem('sessionToken');
      }
    } catch {
      // 서버 연결 실패 시 토큰 유지 (오프라인 상태일 수 있으므로 로그인 강제하지 않음)
      sessionStorage.removeItem('sessionToken');
    }
  }
  document.getElementById('loginForm').addEventListener('submit', handleLogin);
  document.getElementById('mfaForm').addEventListener('submit', handleMfaVerify);
  document.getElementById('mfaCancelBtn').addEventListener('click', closeMfaStep);
  document.getElementById('mfaResendBtn').addEventListener('click', handleMfaResend);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('mfaOverlay').classList.contains('hidden')) {
      closeMfaStep();
    }
  });
  // 숫자만 받는다 - 붙여넣기로 공백이나 하이픈이 섞여 들어오는 것을 막는다
  document.getElementById('mfaCode').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  });
}

/* ----------------------- 전역 state ----------------------- */
const EXAM_TYPES = ['NAC', 'NAC_MID', 'EDR', 'GPI'];

const state = {
  examType: 'NAC', // EXAM_TYPES 중 하나 - 현재 화면에 표시 중인 시험 종류
  partnersByExam: { NAC: [], NAC_MID: [], EDR: [], GPI: [] }, // Google Sheets 연동 이후 채워지는 단일 데이터 소스 (신청자 명단은 실데이터, 채점 점수는 아직 더미)
  resultSheetUrlByExam: { NAC: null, NAC_MID: null, EDR: null, GPI: null }, // 평가현황 시트 URL (examType별)
  isSyncing: false,
  selectedMonth: new Date().getMonth() + 1, // 1~12 - 헤더의 월 선택 드롭다운에서 고른 조회 대상 월
  selectedYear: new Date().getFullYear(), // 같은 월이라도 연도가 다르면 다른 신청 건이므로 항상 같이 사용
};

let nextModalConfirmHandler = null;
const expandedGradingIds = new Set(); // AI 채점 탭에서 주관식 채점 상세를 펼친 파트너 id
const selectedExamSendIds = new Set(); // 시험 발송 탭에서 체크박스로 선택된 파트너 id
const sendingExamEmailIds = new Set(); // 현재 메일 발송 진행 중인 파트너 id (버튼 로딩 표시용)
const downloadingCertificateIds = new Set(); // 현재 수료증(결과 안내 PDF) 다운로드 진행 중인 파트너 id
const sendingSlackCompanies = new Set(); // Slack 발송 진행 중 (키: '회사명' 또는 '회사명::test')
// Slack 발송 시 수료증 뒤에 같이 붙일 추가 파일. 회사명 → [{ filename, contentType, data(base64) }]
// 발송은 회사 단위라 첨부도 회사 단위로 들고 있는다. 새로고침하면 사라지는 임시 선택이다.
const slackAttachmentsByCompany = new Map();
const MAX_SLACK_ATTACHMENTS = 5;
const MAX_SLACK_ATTACHMENT_BYTES = 10 * 1024 * 1024;

function getPartners() {
  return state.partnersByExam[state.examType];
}

/* 백엔드 URL - 로컬/서버 환경 자동 감지
 * 서버 배포 후 아래 PROD_API_URL을 Railway 도메인으로 교체하면 됩니다. */
const PROD_API_URL = 'https://partnerlevel-production.up.railway.app';
const SHEETS_API_BASE_URL = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:4000'
  : PROD_API_URL;
// 로그인 후 sessionStorage에 저장된 세션 토큰을 API key로 사용한다
let SHEETS_ACCESS_KEY = sessionStorage.getItem('sessionToken') || '';

// 모든 API 호출의 공통 래퍼 - 401(세션 만료/미인증)을 감지해 로그인 화면으로 복귀시킨다
async function apiFetch(url, options = {}) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    handleSessionExpired();
    throw new Error('세션이 만료되었습니다. 다시 로그인해주세요.');
  }
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

/* 2/3번 시트(응시 결과·채점) 연동 전까지 사용하는 주관식 더미 문항 - AI 채점 탭 표시용 */
const SUBJECTIVE_QUESTIONS = [
  { question: '당사 NAC 솔루션이 기존 방화벽과 차별화되는 핵심 가치를 고객에게 설명해보세요.', maxScore: 17 },
  { question: '랜섬웨어 침해가 의심되는 상황에서 EDR 솔루션이 수행하는 탐지·대응 프로세스를 서술하세요.', maxScore: 17 },
  { question: '고객사가 제품 도입을 망설일 때, 이를 해소하기 위한 영업 전략을 작성하세요.', maxScore: 16 },
];

/* 응시 결과 시트 연동 전까지 채점 탭이 동작할 수 있도록 임시 점수를 채워준다.
 * aiScore는 AI가 처음 매긴 점수(참고용, 절대 바뀌지 않음), score는 사람이 검토 후 수정할 수 있는
 * "최종 점수"로 처음엔 aiScore와 같다. modelAnswer(정답)는 추후 관리자가 templates에 올리는
 * 채점 기준 파일에서 가져올 예정 - 지금은 더미 placeholder만 채운다. */
function generateDummyGrading() {
  const objectiveScore = 30 + Math.floor(Math.random() * 21); // 30~50
  const subjectiveAnswers = SUBJECTIVE_QUESTIONS.map((q) => {
    const aiScore = Math.round(q.maxScore * (0.55 + Math.random() * 0.4));
    return {
      question: q.question,
      maxScore: q.maxScore,
      aiScore,
      score: aiScore,
      answer: '(응시 결과 시트 연동 전 임시 데이터)',
      modelAnswer: '(정답 미등록 - 추후 templates에 채점 기준 업로드 후 표시 예정)',
      rationale: '(응시 결과 시트 연동 전 임시 데이터)',
      reviewMemo: '',
    };
  });
  return { objectiveScore, subjectiveAnswers };
}

/* =========================================================================
 * 1번 시트(월별 신청자 명단) 연동
 * -------------------------------------------------------------------------
 * server/server.js 가 서비스 계정으로 (비공개 상태인) 시트를 직접 읽어
 * 현재 월에 해당하는 신청자만 골라
 * { month, partners: [{ name, email, company, position, attendanceHint }] }
 * 형태의 JSON으로 반환한다. attendanceHint는 시트 행 배경색(노랑=출석/빨강=결석)을
 * 읽어 판단한 값이며, 앱에서 토글해도 시트 색은 바뀌지 않는다(읽기 전용 동기화).
 * NAC/EDR은 서버에 examType 파라미터로 구분해서 요청한다(각각 별도 스프레드시트).
 * 2/3번 시트(응시 결과·채점)는 아직 미연동이라 채점 데이터는 generateDummyGrading()으로 채운다.
 * ========================================================================= */
function fetchFromSheets(examType) {
  const url = `${SHEETS_API_BASE_URL}/api/partners?key=${encodeURIComponent(SHEETS_ACCESS_KEY)}&examType=${encodeURIComponent(examType)}&month=${state.selectedMonth}&year=${state.selectedYear}`;

  return apiFetch(url)
    .then((data) => {
      return { resultSheetUrl: data.resultSheetUrl || null, partners: data.partners.map((p) => ({
        name: p.name,
        email: p.email,
        company: p.company,
        position: p.position,
        department: p.department,
        phone: p.phone,
        jiraId: p.jiraId,
        itemSelection: p.itemSelection,
        applicationDate: p.applicationDate,
        attendanceHint: p.attendanceHint,
        rowIndex: p.rowIndex,
        existingResult: p.existingResult || null, // 결과 시트(평가현황)에 이미 기록된 점수가 있으면 채워짐
        ...generateDummyGrading(),
      })) };
    });
}

// 평가 수준은 시험 종류가 결정한다 (NAC 중급 탭만 중급). 서버도 examType으로 다시 정하므로
// 여기 값은 화면 표시용이다.
function currentLevel() {
  return state.examType === 'NAC_MID' ? '중급' : '초급';
}

/* 시험 발송 - server/mailer.js 가 시험 종류(NAC/EDR)·수준(초급/중급)에 맞는 안내 메일을 한 명씩 발송한다.
 * 서버에서 공유 드라이브를 탐색해 해당 월 폼 URL을 자동으로 메일에 포함한다. */
function sendExamLinks(examType, targetPartners) {
  const url = `${SHEETS_API_BASE_URL}/api/send-exam-emails?key=${encodeURIComponent(SHEETS_ACCESS_KEY)}`;

  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      examType,
      level: currentLevel(),
      year: state.selectedYear,
      month: state.selectedMonth,
      recipients: targetPartners.map((p) => ({ name: p.name, email: p.email })),
    }),
  });
}

/* 수료증(정기평가 결과 안내 PDF) - server/certificate.js가 같은 회사 소속 응시자 전원을
 * 한 표에 묶어 PDF 1개로 만들어 돌려준다. 개인별 다운로드 버튼을 눌러도 같은 회사 소속이면
 * 항상 같은 파일이 내려간다(문서 자체가 회사 단위로 생성되기 때문). 점수/합격여부는 아직
 * 서버에 저장되지 않는 더미 채점 데이터라 요청 시 members 목록에 함께 실어 보낸다. */
function downloadCompanyCertificate({ company, examType, year, month, members }) {
  const url = `${SHEETS_API_BASE_URL}/api/certificate?key=${encodeURIComponent(SHEETS_ACCESS_KEY)}`;

  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company, examType, year, month, members }),
  }).then((res) => {
    if (res.status === 401) { handleSessionExpired(); throw new Error('세션이 만료되었습니다.'); }
    if (!res.ok) return res.json().then((data) => { throw new Error(data.error || '수료증 생성에 실패했습니다.'); });
    return res.blob();
  });
}

/* Slack 발송 - 서버가 수료증 PDF를 만들어 파트너사 채널에 안내 메시지를 올리고
 * 그 메시지 본문에 PDF를 첨부한다. 수료증과 마찬가지로 회사 단위로 한 번 나간다. */
function sendCertificateToSlack({ company, examType, year, month, members, test = false, attachments = [] }) {
  const url = `${SHEETS_API_BASE_URL}/api/slack-certificate?key=${encodeURIComponent(SHEETS_ACCESS_KEY)}`;
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ company, examType, year, month, members, test, attachments }),
  });
}

/* 승인 결과 - 결과 시트(평가현황)에 새 행으로 기록한다(server/examResults.js).
 * 이미 같은 달 기록이 있으면 서버가 새로 쓰지 않고 기존 값을 그대로 돌려준다(중복 기록 방지). */
function recordApprovalToSheets(partner) {
  const url = `${SHEETS_API_BASE_URL}/api/exam-result?key=${encodeURIComponent(SHEETS_ACCESS_KEY)}`;

  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      examType: state.examType,
      company: partner.company,
      name: partner.name,
      email: partner.email,
      department: partner.department,
      position: partner.position,
      phone: partner.phone,
      jiraId: partner.jiraId,
      itemSelection: partner.itemSelection,
      month: state.selectedMonth,
      year: state.selectedYear,
      objectiveScore: partner.objectiveScore,
      objectiveCorrectCount: partner.objectiveCorrectCount ?? null,
      subjectiveScore: partner.subjectiveScore,
    }),
  });
}

/* =========================================================================
 * 시험 폼 자동 채점 (server/formsGrading.js 연동)
 * ========================================================================= */

let isGradingInProgress = false;
let isAutoSyncInProgress = false;
let gradingAutoSyncDone = false; // 탭 진입 시 객관식 자동 동기화 완료 여부
let gradingAiDone = false;       // AI 주관식 채점 완료 여부

// 서버에 채점 요청 - formUrl 직접 지정 또는 null이면 공유 드라이브 자동 탐색
function fetchGradeFromForm(formUrl, skipSubjectiveGrading = false) {
  const url = `${SHEETS_API_BASE_URL}/api/grade-from-form?key=${encodeURIComponent(SHEETS_ACCESS_KEY)}`;
  const partners = getPartners().map((p) => ({ name: p.name, email: p.email }));

  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      year: state.selectedYear,
      month: state.selectedMonth,
      examType: state.examType,
      level: currentLevel(),
      formUrl: formUrl || null,
      partners,
      skipSubjectiveGrading,
    }),
  });
}

// 채점 결과를 파트너 state에 반영하고 전체 탭 다시 그리기
function applyGradingResults(gradingResult) {
  const partners = getPartners();
  let appliedCount = 0;

  gradingResult.results.forEach((r) => {
    if (!r.hasExamResponse) return;
    const partner = partners.find((p) =>
      (p.email && r.email && p.email.toLowerCase() === r.email.toLowerCase()) || p.name === r.name
    );
    if (!partner) return;

    partner.objectiveScore = r.objectiveScore;
    partner.objectiveCorrectCount = r.objectiveCorrectCount ?? null;
    partner.subjectiveAnswers = r.subjectiveAnswers;
    partner.examStatus = '응시완료';
    recalcScores(partner);
    appliedCount++;
  });

  renderAll();
  return appliedCount;
}

function setGradingStatusBar(message, type) {
  const bar = document.getElementById('gradingStatusBar');
  if (!bar) return;
  bar.textContent = message;
  bar.className = `grading-status-bar grading-status-bar--${type || 'info'}`;
}

// 탭 진입 시 자동 실행 + 수동 동기화 버튼 — 폼에서 객관식 점수 + 주관식 답변 텍스트 읽기 (AI 채점 없음)
async function handleAutoSyncGrading() {
  if (isAutoSyncInProgress || isGradingInProgress) return;
  const examinees = getPartners().filter((p) => p.examStatus === '응시완료');
  if (examinees.length === 0) {
    showToast('응시 완료된 인원이 없습니다. 응시 확인 탭을 먼저 확인하세요.');
    return;
  }

  isAutoSyncInProgress = true;
  const syncBtn = document.getElementById('manualSyncGradingBtn');
  if (syncBtn) { syncBtn.disabled = true; syncBtn.textContent = '동기화 중...'; }
  setGradingStatusBar('폼에서 점수 동기화 중...', 'info');
  renderGradingTab();

  try {
    const result = await fetchGradeFromForm(null, true); // skipSubjectiveGrading=true
    applyGradingResults(result);
    gradingAutoSyncDone = true;
    setGradingStatusBar(
      `객관식 점수 동기화 완료 — 전체 응답 ${result.totalResponses}건${result.noAnswerKey ? '  |  ⚠ 정답 파일 미설정, 객관식 0점' : ''}`,
      'info'
    );
  } catch (err) {
    setGradingStatusBar(`점수 동기화 실패: ${err.message}`, 'error');
  } finally {
    isAutoSyncInProgress = false;
    if (syncBtn) { syncBtn.disabled = false; syncBtn.textContent = '점수 동기화'; }
    renderGradingTab();
  }
}

// "AI 채점 실행" 버튼 클릭 — 주관식 AI 채점 실행
async function handleGradeFromForm() {
  if (isGradingInProgress || isAutoSyncInProgress) return;
  if (getPartners().length === 0) {
    showToast('먼저 Google Sheets 연동으로 파트너 목록을 불러오세요.');
    return;
  }

  const urlInput = document.getElementById('gradeFormUrlInput');
  const formUrl = urlInput ? urlInput.value.trim() : '';

  isGradingInProgress = true;
  const btn = document.getElementById('gradeFromFormBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'AI 채점 중...'; }

  setGradingStatusBar(
    formUrl ? '입력한 폼 URL로 AI 채점 중...' : `${state.selectedYear}년 ${state.selectedMonth}월 폼 AI 채점 중...`,
    'info'
  );
  renderGradingTab();

  try {
    const result = await fetchGradeFromForm(formUrl || null, false); // 주관식 AI 채점 실행
    const applied = applyGradingResults(result);
    gradingAutoSyncDone = true;
    gradingAiDone = true;
    const noKeyNote = result.noAnswerKey ? '  |  ⚠ 정답 파일 미설정 — 객관식 0점' : '';
    setGradingStatusBar(
      `AI 채점 완료 ✓  폼: ${result.formName}  |  ${result.totalResponses}건 중 ${applied}명 매칭${noKeyNote}`,
      result.noAnswerKey ? 'info' : 'success'
    );
    showToast(`AI 채점 완료: ${applied}명 점수가 업데이트됐습니다.`);
  } catch (err) {
    setGradingStatusBar(`AI 채점 실패: ${err.message}`, 'error');
    showToast(`AI 채점 실패: ${err.message}`);
  } finally {
    isGradingInProgress = false;
    if (btn) { btn.disabled = false; btn.textContent = 'AI 채점 실행'; }
    renderGradingTab();
  }
}

/* ----------------------- 유틸 ----------------------- */
function isPass(totalScore) {
  return totalScore >= 60;
}

/* 주관식 점수를 사람이 수정했을 때 subjectiveScore/totalScore를 다시 계산한다 */
function recalcScores(partner) {
  partner.subjectiveScore = partner.subjectiveAnswers.reduce((sum, qa) => sum + (qa.score || 0), 0);
  partner.totalScore = partner.objectiveScore + partner.subjectiveScore;
}

function findPartner(id) {
  return getPartners().find((p) => p.id === Number(id));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ----------------------- 모달 공통 컴포넌트 ----------------------- */
function showModal(message, onConfirm, { confirmText = '확인', confirmClass = 'btn-primary' } = {}) {
  document.getElementById('modalMessage').textContent = message;
  nextModalConfirmHandler = onConfirm;
  const btn = document.getElementById('modalConfirmBtn');
  btn.textContent = confirmText;
  btn.className = `btn ${confirmClass}`;
  document.getElementById('modalOverlay').classList.remove('hidden');
}

function hideModal() {
  document.getElementById('modalOverlay').classList.add('hidden');
  nextModalConfirmHandler = null;
  const btn = document.getElementById('modalConfirmBtn');
  btn.textContent = '확인';
  btn.className = 'btn btn-primary';
}

/* ----------------------- 토스트 공통 컴포넌트 ----------------------- */
function showToast(message) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  container.appendChild(toast);

  requestAnimationFrame(() => toast.classList.add('show'));

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 2600);
}

/* ----------------------- 탭 전환 ----------------------- */
function initTabNav() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.tabPanel === tabName);
  });
  if (tabName === 'formCreate') {
    formCreateCache = null;
    renderFormCreateTab();
    handleRefreshFormStatus();
  }
  if (tabName === 'grading' && !gradingAutoSyncDone) {
    handleAutoSyncGrading();
  }
}

/* ----------------------- 헤더: 조회 월 선택 ----------------------- */
function renderCurrentMonth() {
  document.getElementById('currentMonthBtn').textContent = `${state.selectedYear}년 ${state.selectedMonth}월`;
}

function renderMonthDropdown() {
  const dropdown = document.getElementById('monthDropdown');
  const options = Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `
    <button type="button" class="month-option ${m === state.selectedMonth ? 'active' : ''}" data-action="select-month" data-month="${m}">${m}월</button>
  `).join('');
  dropdown.innerHTML = options;
}

function toggleMonthDropdown() {
  document.getElementById('monthDropdown').classList.toggle('hidden');
}

function closeMonthDropdown() {
  document.getElementById('monthDropdown').classList.add('hidden');
}

/* 월 선택 시 선택한 월 기준으로 신청자 명단을 다시 불러온다 (이미 연동된 적이 있을 때만) */
function selectMonth(month) {
  const numMonth = Number(month);
  if (numMonth === state.selectedMonth) {
    closeMonthDropdown();
    return;
  }
  state.selectedMonth = numMonth;
  gradingAutoSyncDone = false;
  gradingAiDone = false;
  renderCurrentMonth();
  renderMonthDropdown();
  closeMonthDropdown();

  const hasSyncedBefore = EXAM_TYPES.some((t) => state.partnersByExam[t].length > 0);
  if (hasSyncedBefore) {
    handleSheetsSync();
  }
}

/* ----------------------- 빈 상태 렌더 ----------------------- */
function renderEmptyState(container, message) {
  container.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
}

/* =========================================================================
 * 1. 파트너 목록
 * ========================================================================= */
function renderPartnersTab() {
  const container = document.getElementById('partnersContent');
  const partners = getPartners();

  if (partners.length === 0) {
    renderEmptyState(container, "데이터가 없습니다. 상단의 'Google Sheets 연동' 버튼을 눌러 파트너 목록을 불러오세요.");
    return;
  }

  const rows = partners.map((p, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.email)}</td>
      <td>${escapeHtml(p.itemSelection || '-')}</td>
      <td>${escapeHtml(p.company)}</td>
      <td>${escapeHtml(p.position)}</td>
      <td>${escapeHtml(p.applicationDate || '-')}</td>
    </tr>
  `).join('');

  container.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>No.</th><th>이름</th><th>이메일</th><th>평가 항목 선택</th><th>사명</th><th>직급</th><th>신청일</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/* 파트너사 기준으로 가나다순 정렬한다 - 출석 체크/시험 발송/응시 확인 등 모든 탭이
 * getPartners()의 배열 순서를 그대로 표에 쓰므로, 여기서 한 번만 정렬하면 전체 탭에 적용된다. */
function sortByCompany(partners) {
  return [...partners].sort((a, b) => a.company.localeCompare(b.company, 'ko'));
}

function buildPartnerList(rawList) {
  return rawList.map((raw, index) => {
    // 결과 시트(평가현황)에 이번 달 기록이 이미 있으면 그 점수를 그대로 쓰고, 더 이상 손댈 수
    // 없는 확정 결과로 취급한다(응시완료 + 승인완료 처리 → AI 채점 탭 수정도 같이 잠김).
    const existing = raw.existingResult;
    const subjectiveScore = existing ? existing.subjectiveScore : raw.subjectiveAnswers.reduce((sum, qa) => sum + qa.score, 0);
    const objectiveScore = existing ? existing.objectiveScore : raw.objectiveScore;
    const totalScore = existing ? existing.totalScore : objectiveScore + subjectiveScore;

    return {
      id: index + 1,
      name: raw.name,
      email: raw.email,
      company: raw.company,
      position: raw.position,
      department: raw.department,
      phone: raw.phone,
      jiraId: raw.jiraId,
      itemSelection: raw.itemSelection,
      applicationDate: raw.applicationDate,
      rowIndex: raw.rowIndex, // 출석 토글 시 시트의 어느 행을 칠할지 식별하는 값
      attendance: raw.attendanceHint === '출석' ? '출석' : '결석', // 시트 행 색상 기반, '신청만'은 결석으로 취급
      examStatus: existing ? '응시완료' : '미응시',
      objectiveScore,
      subjectiveScore,
      subjectiveAnswers: raw.subjectiveAnswers,
      totalScore,
      gradingStatus: '채점완료',
      approvalStatus: existing ? '승인완료' : '미승인',
      hasRecordedResult: !!existing, // 평가현황 시트에 이미 기록된 결과인지 (뱃지 표시용)
    };
  });
}

function handleSheetsSync() {
  if (state.isSyncing) return;
  state.isSyncing = true;

  // 연동 버튼이 파트너 목록 탭과 현황 탭 두 군데에 있다 - 둘 다 같이 잠근다
  const btns = [document.getElementById('syncSheetsBtn'), document.getElementById('dashboardSyncBtn')].filter(Boolean);
  const setBusy = (busy) => btns.forEach((b) => {
    b.disabled = busy;
    if (busy) b.innerHTML = `<span class="btn-spinner"><span class="spinner"></span>연동 중...</span>`;
    else b.textContent = 'Google Sheets 연동';
  });
  setBusy(true);

  Promise.all(EXAM_TYPES.map((t) => fetchFromSheets(t))).then((results) => {
    // 파트너사 기준으로 묶어서 보이도록 회사명 가나다순 정렬 (모든 탭이 이 배열 순서를 그대로 따른다)
    EXAM_TYPES.forEach((t, i) => {
      state.partnersByExam[t] = sortByCompany(buildPartnerList(results[i].partners));
      state.resultSheetUrlByExam[t] = results[i].resultSheetUrl;
    });
    selectedExamSendIds.clear(); // 새로 불러온 명단 기준으로 id가 재배정되므로 기존 선택은 초기화
    expandedGradingIds.clear();
    gradingAutoSyncDone = false; // 새 명단 로드 시 채점 동기화 상태 초기화
    gradingAiDone = false;

    state.isSyncing = false;
    setBusy(false);

    renderAll();
    showToast('Google Sheets 연동이 완료되었습니다.');
  }).catch((err) => {
    state.isSyncing = false;
    setBusy(false);
    showToast(`연동에 실패했습니다: ${err.message}`);
  });
}

/* =========================================================================
 * 2. 출석 체크
 * ========================================================================= */
function renderAttendanceTab() {
  const container = document.getElementById('attendanceContent');
  const summaryEl = document.getElementById('attendanceSummary');

  const partners = getPartners();
  const total = partners.length;
  const attendCount = partners.filter((p) => p.attendance === '출석').length;
  summaryEl.textContent = `${attendCount} / ${total}`;

  if (total === 0) {
    renderEmptyState(container, "먼저 '파트너 목록' 탭에서 Google Sheets 연동을 진행해주세요.");
    return;
  }

  const rows = partners.map((p, index) => {
    const isOn = p.attendance === '출석';
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.itemSelection || '-')}</td>
        <td>${escapeHtml(p.company)}</td>
        <td>${escapeHtml(p.position)}</td>
        <td>
          <button class="toggle-btn ${isOn ? 'state-on' : 'state-off'}" data-action="toggle-attendance" data-id="${p.id}">
            ${isOn ? '출석' : '결석'}
          </button>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>No.</th><th>이름</th><th>평가 항목 선택</th><th>사명</th><th>직급</th><th>출석 상태</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/* 출석 토글 시 시트의 해당 행 배경색도 함께 변경 (서비스 계정이 편집자 권한일 때 동작) */
function updateAttendanceOnSheet(examType, partner) {
  const url = `${SHEETS_API_BASE_URL}/api/attendance?key=${encodeURIComponent(SHEETS_ACCESS_KEY)}`;
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ examType, rowIndex: partner.rowIndex, status: partner.attendance }),
  });
}

function toggleAttendance(id) {
  const partner = findPartner(id);
  if (!partner) return;

  const examType = state.examType;
  const previousAttendance = partner.attendance;
  partner.attendance = partner.attendance === '출석' ? '결석' : '출석';
  renderAttendanceTab();
  renderExamSendTab();
  renderExamCheckTab();

  updateAttendanceOnSheet(examType, partner).catch((err) => {
    partner.attendance = previousAttendance; // 시트 반영 실패 시 화면도 원상복구
    renderAttendanceTab();
    renderExamSendTab();
    renderExamCheckTab();
    showToast(`시트 색상 반영에 실패했습니다: ${err.message}`);
  });
}

/* =========================================================================
 * 3. 시험 발송
 * ========================================================================= */
function renderExamSendTab() {
  const container = document.getElementById('examSendContent');

  const partners = getPartners();
  const targets = partners.filter((p) => p.attendance === '출석'); // 발송 대상은 항상 출석 인원만

  if (partners.length === 0) {
    renderEmptyState(container, "먼저 '파트너 목록' 탭에서 Google Sheets 연동을 진행해주세요.");
    updateBulkSendButton(targets);
    return;
  }

  if (targets.length === 0) {
    renderEmptyState(container, "출석 처리된 인원이 없습니다. '출석 체크' 탭에서 출석을 먼저 처리해주세요.");
    updateBulkSendButton(targets);
    return;
  }

  const allSelected = targets.every((p) => selectedExamSendIds.has(p.id));

  const rows = targets.map((p, index) => {
    const isChecked = selectedExamSendIds.has(p.id);
    const isSending = sendingExamEmailIds.has(p.id);
    return `
      <tr>
        <td><input type="checkbox" data-action="toggle-select-send" data-id="${p.id}" ${isChecked ? 'checked' : ''}></td>
        <td>${index + 1}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.email)}</td>
        <td>${escapeHtml(p.itemSelection || '-')}</td>
        <td>${escapeHtml(p.company)}</td>
        <td>${escapeHtml(p.position)}</td>
        <td>
          <button class="btn btn-secondary btn-small" data-action="send-single-email" data-id="${p.id}" ${isSending ? 'disabled' : ''}>
            ${isSending ? '<span class="btn-spinner"><span class="spinner"></span>발송중</span>' : '이메일 발송'}
          </button>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="data-table">
      <thead>
        <tr>
          <th><input type="checkbox" data-action="toggle-select-all-send" ${allSelected ? 'checked' : ''}></th>
          <th>No.</th>
          <th>이름</th>
          <th>이메일</th>
          <th>평가 항목 선택</th>
          <th>사명</th>
          <th>직급</th>
          <th>메일 발송</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  updateBulkSendButton(targets);
}

function updateBulkSendButton(targets) {
  const btn = document.getElementById('bulkSendExamBtn');
  if (!btn) return;
  const selectedCount = targets.filter((p) => selectedExamSendIds.has(p.id)).length;
  btn.disabled = selectedCount === 0;
  btn.textContent = selectedCount > 0 ? `선택 발송 (${selectedCount}명)` : '선택 발송';
}

function toggleSelectSend(id, checked) {
  const numId = Number(id);
  if (checked) selectedExamSendIds.add(numId);
  else selectedExamSendIds.delete(numId);
  renderExamSendTab();
}

function toggleSelectAllSend(checked) {
  const targets = getPartners().filter((p) => p.attendance === '출석');
  targets.forEach((p) => {
    if (checked) selectedExamSendIds.add(p.id);
    else selectedExamSendIds.delete(p.id);
  });
  renderExamSendTab();
}

function handleSendSingleEmail(id) {
  const partner = findPartner(id);
  if (!partner || sendingExamEmailIds.has(partner.id)) return;

  const examType = state.examType;
  sendingExamEmailIds.add(partner.id);
  renderExamSendTab();

  sendExamLinks(examType, [partner]).then((result) => {
    sendingExamEmailIds.delete(partner.id);
    renderExamSendTab();
    if (result.failed && result.failed.length > 0) {
      showToast(`${partner.name}님 발송에 실패했습니다: ${result.failed[0].error}`);
    } else {
      const linkNote = result.formUrl ? '' : ' (폼 링크 없음 — 문제 폼 생성 탭 확인)';
      showToast(`${partner.name}님에게 발송했습니다.${linkNote}`);
    }
  }).catch((err) => {
    sendingExamEmailIds.delete(partner.id);
    renderExamSendTab();
    showToast(`${partner.name}님 발송에 실패했습니다: ${err.message}`);
  });
}

function handleBulkSendExam() {
  const examType = state.examType;
  const targets = getPartners().filter((p) => p.attendance === '출석' && selectedExamSendIds.has(p.id));
  if (targets.length === 0) return;

  showModal(`선택한 ${targets.length}명에게 시험 링크를 발송합니다`, () => {
    hideModal();
    targets.forEach((p) => sendingExamEmailIds.add(p.id));
    renderExamSendTab();

    sendExamLinks(examType, targets).then((result) => {
      targets.forEach((p) => sendingExamEmailIds.delete(p.id));
      renderExamSendTab();
      const linkNote = result.formUrl ? '' : ' — 폼 링크 없음(문제 폼 생성 탭 확인)';
      if (result.failed && result.failed.length > 0) {
        showToast(`발송 완료: ${result.sent}명 성공, ${result.failed.length}명 실패${linkNote}`);
      } else {
        showToast(`시험 링크 발송이 완료되었습니다. (총 ${result.sent}명)${linkNote}`);
      }
    }).catch((err) => {
      targets.forEach((p) => sendingExamEmailIds.delete(p.id));
      renderExamSendTab();
      showToast(`발송에 실패했습니다: ${err.message}`);
    });
  });
}

/* =========================================================================
 * 4. 응시 확인 (시험 발송 대상인 출석 인원만 표시)
 * ========================================================================= */

let isExamCheckLoading = false;

// 서버에 폼 응답 매칭 요청 - 파트너 이름·사명과 비교해 응시자 목록 반환
async function fetchExamCheckMatch(level) {
  const url = `${SHEETS_API_BASE_URL}/api/exam-check/match?key=${encodeURIComponent(SHEETS_ACCESS_KEY)}`;
  const partners = getPartners().map((p) => ({ name: p.name, company: p.company, email: p.email }));

  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      year: state.selectedYear,
      month: state.selectedMonth,
      level,
      examType: state.examType,
      partners,
    }),
  }); // { formName, totalResponses, matched: [{name, company, matchType}], unmatched }
}

// 폼 응답 매칭 결과를 파트너 state에 반영
function applyExamCheckMatches(matched) {
  const partners = getPartners();
  let updatedCount = 0;

  matched.forEach(({ name, company }) => {
    // 이름+사명 일치 우선, 없으면 이름만
    let partner = partners.find((p) => p.name === name && p.company === company);
    if (!partner) partner = partners.find((p) => p.name === name);
    if (partner && partner.examStatus !== '응시완료') {
      partner.examStatus = '응시완료';
      updatedCount++;
    }
  });

  return updatedCount;
}

async function handleRefreshExamCheck() {
  if (isExamCheckLoading) return;
  if (getPartners().length === 0) {
    showToast('먼저 Google Sheets 연동으로 파트너 목록을 불러오세요.');
    return;
  }

  isExamCheckLoading = true;
  const btn = document.getElementById('refreshExamCheckBtn');
  if (btn) { btn.disabled = true; btn.textContent = '조회 중...'; }

  // 시험 발송 탭 레벨과 동일한 레벨로 조회 (초급/중급)
  const level = currentLevel();

  try {
    const result = await fetchExamCheckMatch(level);
    const updatedCount = applyExamCheckMatches(result.matched);

    renderExamCheckTab();
    renderGradingTab();
    renderApprovalTab();
    renderPassListTab();

    const unmatchedNote = result.unmatched.length > 0
      ? ` | 명단 미등록 응답자 ${result.unmatched.length}명`
      : '';
    showToast(
      `응시 현황 조회 완료 — 전체 응답 ${result.totalResponses}건, 신규 응시 확인 ${updatedCount}명${unmatchedNote}`
    );
  } catch (err) {
    showToast(`응시 현황 조회 실패: ${err.message}`);
  } finally {
    isExamCheckLoading = false;
    if (btn) { btn.disabled = false; btn.textContent = '응시 현황 조회'; }
  }
}

function renderExamCheckTab() {
  const container = document.getElementById('examCheckContent');
  const summaryEl = document.getElementById('examCheckSummary');

  const partners = getPartners();
  const eligible = partners.filter((p) => p.attendance === '출석');
  const completeCount = eligible.filter((p) => p.examStatus === '응시완료').length;
  summaryEl.textContent = `${completeCount} / ${eligible.length}`;

  if (partners.length === 0) {
    renderEmptyState(container, "먼저 '파트너 목록' 탭에서 Google Sheets 연동을 진행해주세요.");
    return;
  }

  if (eligible.length === 0) {
    renderEmptyState(container, "출석 처리된 인원이 없습니다. '출석 체크' 탭에서 출석을 먼저 처리해주세요.");
    return;
  }

  const rows = eligible.map((p, index) => {
    const isOn = p.examStatus === '응시완료';
    return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.itemSelection || '-')}</td>
        <td>${escapeHtml(p.company)}</td>
        <td>${escapeHtml(p.position)}</td>
        <td>
          <button class="toggle-btn ${isOn ? 'state-on' : 'state-off'}" data-action="toggle-exam" data-id="${p.id}">
            ${isOn ? '응시완료' : '미응시'}
          </button>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>No.</th><th>이름</th><th>평가 항목 선택</th><th>사명</th><th>직급</th><th>응시 상태</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function toggleExamStatus(id) {
  const partner = findPartner(id);
  if (!partner) return;
  partner.examStatus = partner.examStatus === '응시완료' ? '미응시' : '응시완료';
  renderExamCheckTab();
  renderGradingTab();
  renderApprovalTab();
  renderPassListTab();
}

/* =========================================================================
 * 5. AI 채점 (응시완료 인원만 표시, 더미 점수)
 * -------------------------------------------------------------------------
 * 주관식 문항별 상세(정답/응시자 답변/AI 채점 근거)는 이 탭에서 펼쳐보고, 점수가
 * AI 채점과 다르다고 판단되면 사람이 직접 점수를 수정할 수 있다. 수정 시 그 이유를
 * 메모로 남길 수 있다. 승인 완료된 인원은 더 이상 점수를 수정할 수 없다(승인 후
 * 결과가 조용히 바뀌는 걸 막기 위함 - 승인 자체도 취소 불가한 것과 같은 맥락).
 * ========================================================================= */
function renderGradingTab() {
  const container = document.getElementById('gradingContent');

  const partners = getPartners();
  const graded = partners.filter((p) => p.examStatus === '응시완료');

  if (partners.length === 0) {
    renderEmptyState(container, "먼저 '파트너 목록' 탭에서 Google Sheets 연동을 진행해주세요.");
    return;
  }

  if (graded.length === 0) {
    renderEmptyState(container, "응시 완료된 인원이 없습니다. '응시 확인' 탭에서 응시 상태를 먼저 처리해주세요.");
    return;
  }

  // 안내 배너 결정
  let noticeBanner = '';
  if (isAutoSyncInProgress) {
    noticeBanner = `<div class="grading-notice grading-notice--info">폼에서 객관식 점수를 동기화하는 중입니다...</div>`;
  } else if (isGradingInProgress) {
    noticeBanner = `<div class="grading-notice grading-notice--info">AI가 주관식 답변을 채점하고 있습니다. 잠시 기다려주세요...</div>`;
  } else if (gradingAiDone) {
    noticeBanner = `<div class="grading-notice grading-notice--success">AI 채점이 완료되었습니다. 주관식 점수를 검토 후 필요하면 직접 수정하세요.</div>`;
  } else if (gradingAutoSyncDone) {
    noticeBanner = `<div class="grading-notice grading-notice--warning">객관식 점수 동기화 완료. 현재 주관식 점수는 <strong>0점</strong>입니다.<br>'AI 채점 실행' 버튼을 눌러야 주관식 채점이 진행됩니다.</div>`;
  } else {
    noticeBanner = `<div class="grading-notice grading-notice--warning">아직 동기화되지 않았습니다. 잠시 후 자동으로 점수를 불러옵니다.</div>`;
  }

  const rows = graded.map((p, index) => {
    const passed = isPass(p.totalScore);
    const isExpanded = expandedGradingIds.has(p.id);
    const locked = p.approvalStatus === '승인완료'; // 승인 후에는 점수 수정 불가

    const detailRow = isExpanded ? `
      <tr class="qa-detail-row">
        <td colspan="9">
          ${locked ? `<p class="qa-locked-notice">${p.hasRecordedResult ? '평가현황 시트에 이미 기록된 결과입니다.' : '승인 완료된 결과입니다.'} 점수/메모를 더 이상 수정할 수 없습니다.</p>` : ''}
          <div class="qa-detail-panel">
            ${p.subjectiveAnswers.map((qa, idx) => {
              const edited = qa.score !== qa.aiScore;
              return `
              <div class="qa-detail-item">
                <div class="qa-detail-item-head">
                  <span class="qa-detail-question">Q${idx + 1}. ${escapeHtml(qa.question)}</span>
                  <span class="qa-score-chip">AI 채점: ${qa.aiScore} / ${qa.maxScore}점</span>
                </div>
                <div class="qa-detail-block">
                  <span class="qa-detail-label">정답</span>
                  <p class="qa-detail-text">${escapeHtml(qa.modelAnswer)}</p>
                </div>
                <div class="qa-detail-block">
                  <span class="qa-detail-label">응시자 답변</span>
                  <p class="qa-detail-text">${escapeHtml(qa.answer)}</p>
                </div>
                <div class="qa-detail-block">
                  <span class="qa-detail-label">AI 채점 근거</span>
                  <p class="qa-detail-text qa-detail-rationale">${escapeHtml(qa.rationale)}</p>
                </div>
                <div class="qa-detail-block">
                  <span class="qa-detail-label">
                    최종 점수 ${edited ? '<span class="badge badge-info">수정됨</span>' : ''}
                  </span>
                  <div class="qa-score-edit-row">
                    <input
                      type="number" class="qa-score-input" min="0" max="${qa.maxScore}" value="${qa.score}"
                      data-action="edit-subjective-score" data-id="${p.id}" data-q-index="${idx}" ${locked ? 'disabled' : ''}
                    >
                    <span class="qa-score-edit-max">/ ${qa.maxScore}점</span>
                  </div>
                </div>
                <div class="qa-detail-block">
                  <span class="qa-detail-label">점수 수정 메모 (점수를 바꿨다면 이유를 남겨주세요)</span>
                  <textarea
                    class="qa-memo-input" rows="2" placeholder="예: 핵심 키워드는 포함했으나 설명이 부정확해 감점"
                    data-action="edit-subjective-memo" data-id="${p.id}" data-q-index="${idx}" ${locked ? 'disabled' : ''}
                  >${escapeHtml(qa.reviewMemo)}</textarea>
                </div>
              </div>
            `;
            }).join('')}
          </div>
        </td>
      </tr>
    ` : '';

    return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.itemSelection || '-')}</td>
        <td>${escapeHtml(p.company)}</td>
        <td>${p.objectiveScore}</td>
        <td>${p.subjectiveScore}</td>
        <td>${p.totalScore}</td>
        <td>
          <span class="badge badge-info">채점완료</span>
          <span class="badge ${passed ? 'badge-success' : 'badge-danger'}">${passed ? '합격' : '불합격'}</span>
          ${p.hasRecordedResult ? '<span class="badge badge-muted">평가현황 시트 기록값</span>' : ''}
        </td>
        <td>
          <button class="btn-text-link" data-action="toggle-grading-detail" data-id="${p.id}">${isExpanded ? '접기' : '주관식 상세보기'}</button>
        </td>
      </tr>
      ${detailRow}
    `;
  }).join('');

  container.innerHTML = `
    ${noticeBanner}
    <table class="data-table">
      <thead>
        <tr><th>No.</th><th>이름</th><th>평가 항목 선택</th><th>사명</th><th>객관식 점수</th><th>주관식 점수</th><th>총점</th><th>채점 상태</th><th>주관식 채점</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function toggleGradingDetail(id) {
  const numId = Number(id);
  if (expandedGradingIds.has(numId)) {
    expandedGradingIds.delete(numId);
  } else {
    expandedGradingIds.add(numId);
  }
  renderGradingTab();
}

/* 사람이 주관식 점수를 직접 수정 - 승인 완료된 건은 수정 불가 */
function handleEditSubjectiveScore(id, qIndex, rawValue) {
  const partner = findPartner(id);
  if (!partner || partner.approvalStatus === '승인완료') return;
  const qa = partner.subjectiveAnswers[Number(qIndex)];
  if (!qa) return;

  let newScore = Number(rawValue);
  if (Number.isNaN(newScore)) newScore = qa.aiScore;
  newScore = Math.max(0, Math.min(qa.maxScore, newScore));
  qa.score = newScore;

  recalcScores(partner);
  renderGradingTab();
  renderApprovalTab();
  renderPassListTab();
}

/* 점수 수정 메모 - 점수 자체에는 영향 없으므로 다른 탭을 다시 그릴 필요는 없다 */
function handleEditSubjectiveMemo(id, qIndex, value) {
  const partner = findPartner(id);
  if (!partner || partner.approvalStatus === '승인완료') return;
  const qa = partner.subjectiveAnswers[Number(qIndex)];
  if (!qa) return;
  qa.reviewMemo = value;
}

/* =========================================================================
 * 6. 문제 폼 생성
 * ========================================================================= */
let formCreateCache = null;


function apiKey() {
  return encodeURIComponent(SHEETS_ACCESS_KEY);
}

async function fetchExamFormStatus() {
  const url = `${SHEETS_API_BASE_URL}/api/exam-forms/status?key=${apiKey()}&year=${state.selectedYear}&month=${state.selectedMonth}&level=${encodeURIComponent(currentLevel())}&examType=${state.examType}`;
  return apiFetch(url);
}

async function fetchCreateExamForm() {
  const url = `${SHEETS_API_BASE_URL}/api/exam-forms/create?key=${apiKey()}`;
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ year: state.selectedYear, month: state.selectedMonth, level: currentLevel(), examType: state.examType }),
  });
}

async function fetchPublishExamForm(formId) {
  const url = `${SHEETS_API_BASE_URL}/api/exam-forms/publish?key=${apiKey()}`;
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ formId }),
  });
}

function renderFormCreateTab() {
  const container = document.getElementById('formCreateContent');
  if (!container) return;

  if (!formCreateCache) {
    container.innerHTML = `
      <div class="form-create-empty">
        <p>상태 새로고침 버튼을 클릭하거나 "문제 생성" 버튼을 눌러 현재 월 폼 상태를 확인하세요.</p>
        <button class="btn btn-primary" data-action="create-exam-form" style="margin-top:12px">문제 생성</button>
      </div>`;
    return;
  }

  const s = formCreateCache;
  const isMid = s.level === '중급';
  const typeLabel = isMid
    ? `${s.year}년 ${s.month}월 (중급)`
    : `${s.year}년 ${s.month}월 (${s.formType}형)`;
  const typeBadgeText = isMid ? '중급' : `${s.formType}형`;
  const templateEnvKey = isMid ? 'TEMPLATE_FORM_ID_NAC_MID' : `TEMPLATE_FORM_ID_NAC_${s.formType}`;

  const formRow = s.form ? `
    <div class="form-create-card">
      <div class="form-create-card-header">
        <span class="form-create-type-badge">${typeBadgeText}</span>
        <span class="form-create-name">${escapeHtml(s.form.name)}</span>
        <span class="badge ${s.form.published ? 'badge-success' : 'badge-warning'}">
          ${s.form.published ? '게시됨' : '미게시'}
        </span>
      </div>
      <div class="form-create-card-actions">
        <a href="${s.form.editUrl}" target="_blank" class="btn btn-secondary btn-sm">편집 열기</a>
        <a href="${s.form.respondentUrl}" target="_blank" class="btn btn-secondary btn-sm">응시자 링크</a>
        ${!s.form.published ? `<button class="btn btn-primary btn-sm" data-action="publish-exam-form" data-form-id="${s.form.id}">게시</button>` : ''}
        <button class="btn btn-danger btn-sm" data-action="delete-exam-form" data-form-id="${s.form.id}">삭제</button>
      </div>
    </div>` : `
    <div class="form-create-empty">
      <p>${typeLabel} 폼이 아직 생성되지 않았습니다.</p>
      ${!s.templateConfigured ? `<p class="text-warn">⚠ .env의 ${templateEnvKey} 가 설정되지 않았습니다.</p>` : ''}
      <button class="btn btn-primary" data-action="create-exam-form" style="margin-top:12px"
        ${!s.templateConfigured ? 'disabled title="템플릿 폼 ID 미설정"' : ''}>문제 생성</button>
    </div>`;

  container.innerHTML = `
    <div class="form-create-info">
      <span class="form-create-folder">📁 ${escapeHtml(s.targetFolder?.name || '')}</span>
      <span class="form-create-period">${typeLabel}</span>
    </div>
    ${formRow}`;
}

async function handleRefreshFormStatus() {
  const btn = document.getElementById('refreshFormStatusBtn');
  if (btn) { btn.disabled = true; btn.textContent = '조회 중...'; }
  try {
    formCreateCache = await fetchExamFormStatus();
    renderFormCreateTab();
  } catch (err) {
    showToast(`상태 조회 실패: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '상태 새로고침'; }
  }
}

async function handleCreateExamForm() {
  const btns = document.querySelectorAll('[data-action="create-exam-form"]');
  btns.forEach((b) => { b.disabled = true; b.textContent = '생성 중...'; });
  try {
    const result = await fetchCreateExamForm();
    showToast(result.alreadyExisted ? '이미 생성된 폼이 있습니다.' : `폼 생성 완료: ${result.name}`);
    formCreateCache = await fetchExamFormStatus();
    renderFormCreateTab();
  } catch (err) {
    showToast(`폼 생성 실패: ${err.message}`);
    btns.forEach((b) => { b.disabled = false; b.textContent = '문제 생성'; });
  }
}

async function handlePublishExamForm(formId) {
  const btn = document.querySelector(`[data-action="publish-exam-form"][data-form-id="${formId}"]`);
  if (btn) { btn.disabled = true; btn.textContent = '게시 중...'; }
  try {
    await fetchPublishExamForm(formId);
    showToast('게시 완료! 응시자 링크로 접근 가능합니다.');
    formCreateCache = await fetchExamFormStatus();
    renderFormCreateTab();
  } catch (err) {
    showToast(`게시 실패: ${err.message}`);
    if (btn) { btn.disabled = false; btn.textContent = '게시'; }
  }
}

async function fetchDeleteExamForm(formId) {
  const url = `${SHEETS_API_BASE_URL}/api/exam-forms/delete?key=${apiKey()}`;
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ formId }),
  });
}

function handleDeleteExamForm(formId) {
  showModal(
    '이 폼을 삭제하면 해당 폼으로 응답받은 결과가 전부 삭제됩니다.\n정말 삭제하시겠습니까?',
    async () => {
      hideModal();
      try {
        await fetchDeleteExamForm(formId);
        showToast('폼이 삭제되었습니다.');
        formCreateCache = null;
        handleRefreshFormStatus();
      } catch (err) {
        showToast(`삭제 실패: ${err.message}`);
      }
    },
    { confirmText: '삭제', confirmClass: 'btn-danger' }
  );
}

/* =========================================================================
 * 7. 승인 관리
 * ========================================================================= */
function renderApprovalTab() {
  const container = document.getElementById('approvalContent');

  const sheetLinkEl = document.getElementById('approvalSheetLink');
  if (sheetLinkEl) {
    const url = state.resultSheetUrlByExam[state.examType];
    sheetLinkEl.innerHTML = url
      ? `<a class="btn btn-sheet-link btn-small" href="${url}" target="_blank" rel="noopener">평가현황 시트 열기 ↗</a>`
      : '';
  }

  const partners = getPartners();
  const candidates = partners.filter((p) => p.examStatus === '응시완료');

  if (partners.length === 0) {
    renderEmptyState(container, "먼저 '파트너 목록' 탭에서 Google Sheets 연동을 진행해주세요.");
    return;
  }

  if (candidates.length === 0) {
    renderEmptyState(container, "채점 완료된 인원이 없습니다. '응시 확인' 탭에서 응시 상태를 먼저 처리해주세요.");
    return;
  }

  const rows = candidates.map((p, index) => {
    const passed = isPass(p.totalScore);
    const approved = p.approvalStatus === '승인완료';

    return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.itemSelection || '-')}</td>
        <td>${escapeHtml(p.company)}</td>
        <td>${p.totalScore}</td>
        <td><span class="badge ${passed ? 'badge-success' : 'badge-danger'}">${passed ? '합격' : '불합격'}</span></td>
        <td>
          <span class="badge ${approved ? 'badge-success' : 'badge-muted'}">${approved ? '승인완료' : '미승인'}</span>
          ${p.hasRecordedResult ? '<span class="badge badge-muted">평가현황 시트 기록값</span>' : ''}
        </td>
        <td>
          <div class="approval-action-cell">
            ${approved
              ? `<button class="btn btn-secondary btn-small" disabled>승인완료</button>${p.sheetUrl ? `<a class="btn btn-sheet-link btn-small" href="${p.sheetUrl}" target="_blank" rel="noopener">시트 확인 ↗</a>` : ''}`
              : `<button class="btn btn-primary btn-small" data-action="approve" data-id="${p.id}">승인</button>`}
          </div>
        </td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>No.</th><th>이름</th><th>평가 항목 선택</th><th>사명</th><th>총점</th><th>합격여부</th><th>승인 상태</th><th>승인</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function handleApprove(id) {
  const partner = findPartner(id);
  if (!partner || partner.approvalStatus === '승인완료') return;

  showModal(`${partner.name}님의 평가 결과를 승인하시겠습니까?`, () => {
    recordApprovalToSheets(partner)
      .then((data) => {
        partner.approvalStatus = '승인완료'; // 시트 기록 성공 후에만 승인 상태로 바꾼다
        partner.hasRecordedResult = true; // 방금 평가현황 시트에 기록됐다 - 상단 탭 뱃지에 바로 반영된다
        if (data.spreadsheetId && data.sheetGid != null && data.row) {
          partner.sheetUrl = `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}/edit#gid=${data.sheetGid}&range=A${data.row}`;
        }
        hideModal();
        renderGradingTab(); // 승인 후에는 AI 채점 탭의 점수 수정도 잠긴다
        renderApprovalTab();
        renderPassListTab();
        showToast(`${partner.name}님 승인이 완료되었고 평가현황 시트에 기록되었습니다.`);
      })
      .catch((err) => {
        hideModal();
        showToast(`승인 기록에 실패했습니다: ${err.message}`);
      });
  });
}

/* =========================================================================
 * 7. 합격/불합격 확인 (응시완료 + 승인완료된 사람만 표시 - 승인 전에는 노출되지 않음)
 * -------------------------------------------------------------------------
 * 수료증(정기평가 결과 안내 PDF)은 회사 단위로 한 장에 묶어 생성된다. 그래서
 * 다운로드 버튼은 행마다 있지만, 같은 회사 소속이면 항상 같은 파일이 내려간다.
 * ========================================================================= */
function renderPassListTab() {
  const container = document.getElementById('passListContent');

  const partners = getPartners();
  const examinees = partners.filter((p) => p.examStatus === '응시완료' && p.approvalStatus === '승인완료');

  if (partners.length === 0) {
    renderEmptyState(container, "먼저 '파트너 목록' 탭에서 Google Sheets 연동을 진행해주세요.");
    return;
  }

  if (examinees.length === 0) {
    renderEmptyState(container, "승인 완료된 인원이 없습니다. '승인 관리' 탭에서 승인을 먼저 처리해주세요.");
    return;
  }

  // Slack 발송은 회사 단위라, 같은 회사에서 맨 위 한 명에게만 버튼을 노출한다.
  // 행마다 버튼을 두면 같은 메시지를 사람 수만큼 보내게 된다.
  const slackButtonOwner = new Map(); // 회사명 → 그 회사에서 버튼을 표시할 파트너 id
  examinees.forEach((p) => {
    if (!slackButtonOwner.has(p.company)) slackButtonOwner.set(p.company, p.id);
  });

  const rows = examinees.map((p, index) => {
    const passed = isPass(p.totalScore);
    const isDownloading = downloadingCertificateIds.has(p.id);
    const isSlackOwner = slackButtonOwner.get(p.company) === p.id;
    const isSending = sendingSlackCompanies.has(p.company);
    const isTesting = sendingSlackCompanies.has(`${p.company}::test`);
    const companyCount = examinees.filter((x) => x.company === p.company).length;

    // 실제 발송 + 테스트 발송. 테스트는 파트너사 채널이 아니라 고정된 테스트 채널로만 나간다.
    // (검증이 끝나면 테스트 버튼과 slack.js의 isTest 분기를 함께 걷어내면 된다)
    const busy = isSending || isTesting;
    const attached = slackAttachmentsByCompany.get(p.company) || [];
    const attachedList = attached.length
      ? `<ul class="slack-attach-list">${attached.map((f, i) => `
          <li><span class="slack-attach-name" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</span>
            <button type="button" class="slack-attach-remove" data-action="remove-slack-attachment"
              data-id="${p.id}" data-index="${i}" ${busy ? 'disabled' : ''} title="첨부 제외">&times;</button>
          </li>`).join('')}</ul>`
      : '';

    const slackButton = isSlackOwner
      ? `<div class="slack-cell">
           <div class="cell-actions">
             <button class="btn btn-secondary btn-small" data-action="send-slack-certificate" data-id="${p.id}" ${busy ? 'disabled' : ''}
               title="${escapeHtml(p.company)} 채널에 결과 안내와 수료증을 발송합니다 (대상 ${companyCount}명)">
               ${isSending ? '<span class="btn-spinner"><span class="spinner"></span>발송중</span>' : 'Slack 발송'}
             </button>
             <button class="btn btn-outline btn-small" data-action="test-slack-certificate" data-id="${p.id}" ${busy ? 'disabled' : ''}
               title="파트너사에는 가지 않습니다. 테스트 채널로만 발송해 문구와 첨부 형태를 확인합니다.">
               ${isTesting ? '<span class="btn-spinner"><span class="spinner"></span>발송중</span>' : '테스트'}
             </button>
             <button class="btn btn-outline btn-small" data-action="pick-slack-attachment" data-id="${p.id}" ${busy ? 'disabled' : ''}
               title="수료증 뒤에 같이 붙일 파일을 고릅니다 (최대 ${MAX_SLACK_ATTACHMENTS}개, 파일당 ${MAX_SLACK_ATTACHMENT_BYTES / 1024 / 1024}MB)">
               첨부${attached.length ? ` ${attached.length}` : ''}
             </button>
           </div>
           ${attachedList}
         </div>`
      : '<span class="cell-muted">-</span>';

    return `
      <tr>
        <td>${index + 1}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.itemSelection || '-')}</td>
        <td>${escapeHtml(p.company)}</td>
        <td>${p.totalScore}</td>
        <td><span class="badge ${passed ? 'badge-success' : 'badge-danger'}">${passed ? '합격' : '불합격'}</span></td>
        <td>
          <button class="btn btn-secondary btn-small" data-action="download-certificate" data-id="${p.id}" ${isDownloading ? 'disabled' : ''}>
            ${isDownloading ? '<span class="btn-spinner"><span class="spinner"></span>생성중</span>' : '수료증'}
          </button>
        </td>
        <td>${slackButton}</td>
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>No.</th><th>이름</th><th>평가 항목 선택</th><th>사명</th><th>총점</th><th>합격여부</th><th>수료증</th><th>Slack</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/* 수료증 다운로드 - 같은 회사 소속 응시완료자 전원을 한 표에 묶어 PDF로 생성한다 */
/* 수료증 뒤에 같이 붙일 파일 선택.
 * 파일은 base64로 읽어 메모리에만 들고 있다가 발송할 때 서버로 넘긴다
 * (별도 업로드 API 없이 발송 요청 한 번으로 처리된다). */
function handlePickSlackAttachment(id) {
  const partner = findPartner(id);
  if (!partner) return;

  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '.pdf,application/pdf';

  input.addEventListener('change', () => {
    const picked = Array.from(input.files || []);
    if (picked.length === 0) return;

    const current = slackAttachmentsByCompany.get(partner.company) || [];
    const room = MAX_SLACK_ATTACHMENTS - current.length;
    if (room <= 0) {
      showToast(`첨부는 최대 ${MAX_SLACK_ATTACHMENTS}개까지 가능합니다.`);
      return;
    }

    const tooBig = picked.filter((f) => f.size > MAX_SLACK_ATTACHMENT_BYTES);
    if (tooBig.length > 0) {
      showToast(`${tooBig[0].name}이(가) 너무 큽니다. 파일당 ${MAX_SLACK_ATTACHMENT_BYTES / 1024 / 1024}MB까지 가능합니다.`);
      return;
    }

    const accepted = picked.slice(0, room);
    if (accepted.length < picked.length) {
      showToast(`최대 ${MAX_SLACK_ATTACHMENTS}개까지만 담아 ${accepted.length}개만 추가했습니다.`);
    }

    Promise.all(accepted.map(readFileAsAttachment))
      .then((files) => {
        slackAttachmentsByCompany.set(partner.company, [...current, ...files]);
        renderPassListTab();
      })
      .catch((err) => showToast(`파일을 읽지 못했습니다: ${err.message}`));
  });

  input.click();
}

// FileReader의 dataURL에서 base64 본문만 떼어낸다
function readFileAsAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.slice(result.indexOf(',') + 1);
      resolve({ filename: file.name, contentType: file.type || 'application/pdf', data: base64 });
    };
    reader.onerror = () => reject(reader.error || new Error('읽기 실패'));
    reader.readAsDataURL(file);
  });
}

function handleRemoveSlackAttachment(id, index) {
  const partner = findPartner(id);
  if (!partner) return;
  const current = slackAttachmentsByCompany.get(partner.company) || [];
  const next = current.filter((_, i) => i !== Number(index));
  if (next.length === 0) slackAttachmentsByCompany.delete(partner.company);
  else slackAttachmentsByCompany.set(partner.company, next);
  renderPassListTab();
}

/* Slack 발송 - 파트너사 채널에 결과 안내를 올리면서 수료증을 본문에 첨부한다.
 * 외부(파트너사)로 나가는 알림이라 되돌릴 수 없어서, 보내기 전에 대상과 인원을 확인받는다.
 *
 * isTest 를 주면 파트너사가 아니라 테스트 채널로만 나간다. 문구와 첨부 형태를 확인하는
 * 용도이며, 검증이 끝나면 테스트 버튼과 서버의 isTest 분기를 같이 걷어내면 된다. */
function handleSendSlackCertificate(id, { isTest = false } = {}) {
  const partner = findPartner(id);
  if (!partner) return;

  const busyKey = isTest ? `${partner.company}::test` : partner.company;
  // 실제 발송과 테스트가 동시에 나가지 않도록 둘 중 하나라도 진행 중이면 막는다
  if (sendingSlackCompanies.has(partner.company) || sendingSlackCompanies.has(`${partner.company}::test`)) return;

  const examType = state.examType;
  const companyMembers = getPartners().filter((p) => p.company === partner.company
    && p.examStatus === '응시완료' && p.approvalStatus === '승인완료');
  if (companyMembers.length === 0) return;

  const passCount = companyMembers.filter((p) => isPass(p.totalScore)).length;
  const period = `${state.selectedYear}.${String(state.selectedMonth).padStart(2, '0')}월`;
  const attachments = slackAttachmentsByCompany.get(partner.company) || [];
  const attachNote = attachments.length
    ? ` 수료증과 함께 ${attachments.length}개 파일이 더 붙습니다 (${attachments.map((f) => f.filename).join(', ')}).`
    : '';
  const detail = `대상 ${companyMembers.length}명 (합격 ${passCount}명) · 수료증 PDF가 메시지에 첨부됩니다.${attachNote}`;

  const message = isTest
    ? `[테스트] ${partner.company}의 ${period} 결과를 테스트 채널로 발송합니다.\n`
      + `파트너사에는 가지 않습니다. ${detail}`
    : `${partner.company} 채널로 ${period} 평가 결과를 발송하시겠습니까?\n${detail}`;

  showModal(message, () => {
    hideModal();
    sendingSlackCompanies.add(busyKey);
    renderPassListTab();

    sendCertificateToSlack({
      company: partner.company,
      examType,
      year: state.selectedYear,
      month: state.selectedMonth,
      members: companyMembers.map((p) => ({
        name: p.name,
        score: p.totalScore,
        result: isPass(p.totalScore) ? '합격' : '불합격',
      })),
      test: isTest,
      attachments,
    })
      .then((data) => {
        showToast(isTest
          ? `테스트 채널로 발송했습니다. (${partner.company} · 대상 ${companyMembers.length}명)`
          : `${partner.company} 채널로 결과 안내와 수료증을 발송했습니다.`);
        // 실제 발송이 끝나면 첨부 선택을 비운다 - 남겨두면 다음 발송에 같은 파일이 또 붙는다.
        // 테스트는 형태만 보는 것이라 선택을 유지해 바로 실제 발송으로 이어갈 수 있게 한다.
        if (!isTest) slackAttachmentsByCompany.delete(partner.company);
        if (data && data.channelId) console.log('Slack 발송 결과:', data);
      })
      .catch((err) => {
        showToast(`${isTest ? '테스트 ' : ''}Slack 발송에 실패했습니다: ${err.message}`);
      })
      .finally(() => {
        sendingSlackCompanies.delete(busyKey);
        renderPassListTab();
      });
  }, isTest ? { confirmText: '테스트 발송' } : {});
}

function handleDownloadCertificate(id) {
  const partner = findPartner(id);
  if (!partner || downloadingCertificateIds.has(partner.id)) return;

  const examType = state.examType;
  const companyMembers = getPartners().filter((p) => p.company === partner.company && p.examStatus === '응시완료' && p.approvalStatus === '승인완료');

  downloadingCertificateIds.add(partner.id);
  renderPassListTab();

  downloadCompanyCertificate({
    company: partner.company,
    examType,
    year: state.selectedYear,
    month: state.selectedMonth,
    members: companyMembers.map((p) => ({
      name: p.name,
      score: p.totalScore,
      result: isPass(p.totalScore) ? '합격' : '불합격',
    })),
  })
    .then((blob) => {
      const downloadUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `${partner.company}_${examType}_${state.selectedYear}${String(state.selectedMonth).padStart(2, '0')}_평가결과.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(downloadUrl);
    })
    .catch((err) => {
      showToast(`수료증 다운로드에 실패했습니다: ${err.message}`);
    })
    .finally(() => {
      downloadingCertificateIds.delete(partner.id);
      renderPassListTab();
    });
}

/* ----------------------- 시험 종류(NAC/EDR) 전환 ----------------------- */
function switchExamType(examType) {
  if (state.examType === examType) return;
  state.examType = examType;
  expandedGradingIds.clear(); // 다른 시험으로 전환 시 AI 채점의 상세보기 펼침 상태 초기화
  selectedExamSendIds.clear(); // 시험 발송 탭의 체크 선택도 초기화 (id가 NAC/EDR 간 겹칠 수 있어서)
  downloadingCertificateIds.clear(); // 수료증 다운로드 진행 표시도 초기화 (id가 NAC/EDR 간 겹칠 수 있어서)
  gradingAutoSyncDone = false;
  gradingAiDone = false;
  formCreateCache = null; // 폼 상태는 시험 종류마다 다르다 - 안 비우면 이전 시험의 폼이 그대로 보인다
  renderExamTypeSwitch();
  renderAll();
}

function renderExamTypeSwitch() {
  // 레벨(초급/중급) 버튼도 같은 .exam-type-btn 클래스를 쓰기 때문에, 시험 종류 버튼만 골라서 갱신한다.
  // (전체를 대상으로 하면 dataset.examType이 없는 레벨 버튼의 active가 매번 벗겨진다)
  document.querySelectorAll('[data-action="switch-exam-type"]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.examType === state.examType);
  });
}


/* ----------------------- 전체 다시 그리기 ----------------------- */
function renderAll() {
  renderDashboardTab();
  renderPartnersTab();
  renderAttendanceTab();
  renderExamSendTab();
  renderExamCheckTab();
  renderGradingTab();
  renderApprovalTab();
  renderPassListTab();
}

/* =========================================================================
 * 0. 현황 - 선택한 달의 네 시험을 한 표로 모아 본다
 * -------------------------------------------------------------------------
 * 시험 종류가 넷으로 늘어나면서 탭을 일일이 돌지 않으면 그 달에 뭐가 밀려있는지
 * 알 수 없어졌다. 여기서는 시험별로 신청 → 출석 → 응시 → 승인 → 합격까지
 * 한 줄에 펼쳐 보여주고, 아직 처리할 게 남은 칸만 강조한다.
 * 숫자를 누르면 그 시험의 해당 탭으로 바로 넘어간다.
 *
 * 모든 값은 이미 메모리에 있는 명단(state.partnersByExam)에서 계산한다 -
 * 추가 조회가 없으므로 탭을 열 때마다 즉시 그려진다.
 * ========================================================================= */
const EXAM_TYPE_LABELS = {
  NAC: 'NAC',
  NAC_MID: 'NAC 중급',
  EDR: 'EDR',
  GPI: 'GPI',
};

/* 한 시험의 그 달 진행 상황을 센다.
 *
 * "미기록"을 (신청 - 결과 기록)으로 잡는 게 핵심이다. 응시 여부(examStatus)는
 * 응시 확인 탭을 돌려야 값이 생겨서, 연동 직후에는 아무도 응시하지 않은 것으로
 * 보인다. 그 상태로 "승인 대기"를 세면 방치된 신청자가 있어도 0으로 나와
 * 다 끝난 것처럼 보인다 - 정확히 놓치기 쉬운 지점이다.
 * 반면 결과 기록(hasRecordedResult)은 평가현황 시트를 조회해 채워지므로
 * 연동 직후부터 바로 믿을 수 있다. */
function summarizeExam(examType) {
  const partners = state.partnersByExam[examType] || [];
  const recorded = partners.filter((p) => p.hasRecordedResult);
  const present = partners.filter((p) => p.attendance === '출석').length;
  return {
    examType,
    applied: partners.length,
    present,
    absent: partners.length - present,
    passed: recorded.filter((p) => isPass(p.totalScore)).length,
    failed: recorded.filter((p) => !isPass(p.totalScore)).length,
    recorded: recorded.length,
    missing: partners.length - recorded.length,
  };
}

function renderDashboardTab() {
  const container = document.getElementById('dashboardContent');
  if (!container) return;

  const summaries = EXAM_TYPES.map(summarizeExam);
  const totalApplied = summaries.reduce((sum, s) => sum + s.applied, 0);

  if (totalApplied === 0) {
    renderEmptyState(container, `${state.selectedYear}년 ${state.selectedMonth}월 신청자가 없습니다. 'Google Sheets 연동'을 눌러 명단을 불러오세요.`);
    return;
  }

  // 값이 0이면 흐리게, 아직 처리가 남은 칸은 빨갛게. 클릭하면 그 시험의 해당 탭으로 이동한다.
  // warn은 색만 바꾼다 - 여기 숫자는 "끝난 인원"이라 느낌표를 붙이면 오히려 헷갈린다.
  const cell = (value, { tab, examType, warn = false, muted = false, title = '' }) => {
    if (value === 0 && !warn) {
      return `<td class="dash-cell dash-zero">0</td>`;
    }
    const cls = `dash-cell${warn ? ' dash-warn' : ''}${muted ? ' dash-muted' : ''}`;
    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<td class="${cls}"><button type="button" class="dash-link" data-action="dash-goto" data-exam-type="${examType}" data-goto-tab="${tab}"${titleAttr}>${value}</button></td>`;
  };

  const rows = summaries.map((s) => {
    if (s.applied === 0) {
      return `
        <tr class="dash-row-empty">
          <th scope="row">${escapeHtml(EXAM_TYPE_LABELS[s.examType])}</th>
          <td class="dash-cell dash-zero" colspan="6">이번 달 신청자 없음</td>
        </tr>`;
    }
    return `
      <tr>
        <th scope="row">${escapeHtml(EXAM_TYPE_LABELS[s.examType])}</th>
        ${cell(s.applied, { tab: 'partners', examType: s.examType })}
        ${cell(s.present, { tab: 'attendance', examType: s.examType })}
        ${cell(s.absent, { tab: 'attendance', examType: s.examType, muted: true })}
        ${cell(s.passed, { tab: 'passList', examType: s.examType })}
        ${cell(s.failed, { tab: 'passList', examType: s.examType, muted: true })}
        ${cell(s.recorded, {
          tab: 'approval',
          examType: s.examType,
          warn: s.missing > 0, // 신청자 전원이 기록되기 전까지는 빨갛게 남는다
          title: s.missing > 0 ? `신청 ${s.applied}명 중 ${s.missing}명 미기록` : `신청 ${s.applied}명 전원 기록 완료`,
        })}
      </tr>`;
  }).join('');

  const totalMissing = summaries.reduce((sum, s) => sum + s.missing, 0);
  const notice = totalMissing > 0
    ? `<p class="dash-notice dash-notice-warn">결과가 아직 시트에 없는 신청자가 <strong>${totalMissing}명</strong> 있습니다. 미응시자도 여기 포함되니 확인이 필요합니다.</p>`
    : `<p class="dash-notice">신청자 전원의 결과가 평가현황 시트에 기록되어 있습니다.</p>`;

  container.innerHTML = `
    <div class="dash-body">
      <div class="dash-head">
        <span class="dash-period">${state.selectedYear}년 ${state.selectedMonth}월</span>
        ${notice}
      </div>
      <table class="data-table dash-table">
        <thead>
          <tr>
            <th scope="col">시험</th>
            <th scope="col">신청 인원</th>
            <th scope="col">출석</th>
            <th scope="col">미출석</th>
            <th scope="col">합격</th>
            <th scope="col">불합격</th>
            <th scope="col">기록</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

/* 현황 표의 숫자를 누르면 그 시험으로 전환하면서 해당 탭을 연다 */
function handleDashboardGoto(examType, tabName) {
  if (examType && examType !== state.examType) {
    switchExamType(examType);
  }
  switchTab(tabName);
}

/* ----------------------- 이벤트 위임 바인딩 ----------------------- */
function initEventDelegation() {
  document.addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const id = target.dataset.id;

    if (action === 'toggle-attendance') toggleAttendance(id);
    if (action === 'toggle-exam') toggleExamStatus(id);
    if (action === 'approve') handleApprove(id);
    if (action === 'toggle-grading-detail') toggleGradingDetail(id);
    if (action === 'switch-exam-type') switchExamType(target.dataset.examType);
    if (action === 'sync-sheets') handleSheetsSync();
    if (action === 'dash-goto') handleDashboardGoto(target.dataset.examType, target.dataset.gotoTab);
    if (action === 'send-single-email') handleSendSingleEmail(id);
    if (action === 'download-certificate') handleDownloadCertificate(id);
    if (action === 'send-slack-certificate') handleSendSlackCertificate(id);
    if (action === 'test-slack-certificate') handleSendSlackCertificate(id, { isTest: true });
    if (action === 'pick-slack-attachment') handlePickSlackAttachment(id);
    if (action === 'remove-slack-attachment') handleRemoveSlackAttachment(id, target.dataset.index);
    if (action === 'toggle-month-dropdown') {
      e.stopPropagation();
      toggleMonthDropdown();
    }
    if (action === 'select-month') selectMonth(target.dataset.month);
    // 채점 관련
    if (action === 'manual-sync-grading') handleAutoSyncGrading();
    if (action === 'grade-from-form') handleGradeFromForm();
    if (action === 'refresh-exam-check') handleRefreshExamCheck();
    if (action === 'refresh-form-status') handleRefreshFormStatus();
    if (action === 'create-exam-form') handleCreateExamForm();
    if (action === 'publish-exam-form') handlePublishExamForm(target.dataset.formId);
    if (action === 'delete-exam-form') handleDeleteExamForm(target.dataset.formId);
    if (action === 'logout') handleLogout();
    if (action === 'session-refresh') handleSessionRefresh();
  });

  // 드롭다운 바깥을 클릭하면 닫기
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#monthSelect')) closeMonthDropdown();
  });

  document.addEventListener('change', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;

    if (action === 'toggle-select-send') toggleSelectSend(target.dataset.id, target.checked);
    if (action === 'toggle-select-all-send') toggleSelectAllSend(target.checked);
    if (action === 'edit-subjective-score') handleEditSubjectiveScore(target.dataset.id, target.dataset.qIndex, target.value);
    if (action === 'edit-subjective-memo') handleEditSubjectiveMemo(target.dataset.id, target.dataset.qIndex, target.value);
  });

  document.getElementById('syncSheetsBtn').addEventListener('click', handleSheetsSync);
  document.getElementById('bulkSendExamBtn').addEventListener('click', handleBulkSendExam);

  document.getElementById('modalCancelBtn').addEventListener('click', hideModal);
  document.getElementById('modalConfirmBtn').addEventListener('click', () => {
    if (typeof nextModalConfirmHandler === 'function') {
      nextModalConfirmHandler();
    } else {
      hideModal();
    }
  });
}

/* ----------------------- 초기화 ----------------------- */
async function init() {
  await initLogin();
  renderCurrentMonth();
  renderMonthDropdown();
  renderExamTypeSwitch();
  initTabNav();
  initEventDelegation();
  renderAll();
}

document.addEventListener('DOMContentLoaded', init);
