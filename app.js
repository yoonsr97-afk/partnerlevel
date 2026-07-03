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

// 비밀번호를 SHA-256으로 해시 (Web Crypto API - 평문 전송 방지)
async function hashPassword(password) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

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
    const passwordHash = await hashPassword(password);
    const res = await fetch(`${SHEETS_API_BASE_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, passwordHash }),
    });
    const data = await res.json();

    if (!res.ok) throw new Error(data.error || '로그인에 실패했습니다.');

    sessionStorage.setItem('sessionToken', data.token);
    SHEETS_ACCESS_KEY = data.token;
    document.getElementById('loginOverlay').classList.add('hidden');
    startSessionTimer(data.expiresAt);
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = '로그인';
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
}

/* ----------------------- 전역 state ----------------------- */
const state = {
  examType: 'NAC', // 'NAC' | 'EDR' - 현재 화면에 표시 중인 시험 종류
  partnersByExam: { NAC: [], EDR: [] }, // Google Sheets 연동 이후 채워지는 단일 데이터 소스 (신청자 명단은 실데이터, 채점 점수는 아직 더미)
  resultSheetUrlByExam: { NAC: null, EDR: null }, // 평가현황 시트 URL (examType별)
  isSyncing: false,
  selectedMonth: new Date().getMonth() + 1, // 1~12 - 헤더의 월 선택 드롭다운에서 고른 조회 대상 월
  selectedYear: new Date().getFullYear(), // 같은 월이라도 연도가 다르면 다른 신청 건이므로 항상 같이 사용
};

let nextModalConfirmHandler = null;
const expandedGradingIds = new Set(); // AI 채점 탭에서 주관식 채점 상세를 펼친 파트너 id
const selectedExamSendIds = new Set(); // 시험 발송 탭에서 체크박스로 선택된 파트너 id
const sendingExamEmailIds = new Set(); // 현재 메일 발송 진행 중인 파트너 id (버튼 로딩 표시용)
const downloadingCertificateIds = new Set(); // 현재 수료증(결과 안내 PDF) 다운로드 진행 중인 파트너 id

function getPartners() {
  return state.partnersByExam[state.examType];
}

/* 백엔드 URL - 로컬/서버 환경 자동 감지
 * 서버 배포 후 아래 PROD_API_URL을 Railway 도메인으로 교체하면 됩니다. */
const PROD_API_URL = 'https://your-railway-domain.up.railway.app';
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

let examSendLevel = '초급'; // '초급' | '중급' - 시험 발송 탭에서 선택

/* 시험 발송 - server/mailer.js 가 시험 종류(NAC/EDR)·수준(초급/중급)에 맞는 안내 메일을 한 명씩 발송한다.
 * 서버에서 공유 드라이브를 탐색해 해당 월 폼 URL을 자동으로 메일에 포함한다. */
function sendExamLinks(examType, targetPartners) {
  const url = `${SHEETS_API_BASE_URL}/api/send-exam-emails?key=${encodeURIComponent(SHEETS_ACCESS_KEY)}`;

  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      examType,
      level: examSendLevel,
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
      level: examSendLevel,
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

  const hasSyncedBefore = state.partnersByExam.NAC.length > 0 || state.partnersByExam.EDR.length > 0;
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

  const btn = document.getElementById('syncSheetsBtn');
  btn.disabled = true;
  btn.innerHTML = `<span class="btn-spinner"><span class="spinner"></span>연동 중...</span>`;

  Promise.all([fetchFromSheets('NAC'), fetchFromSheets('EDR')]).then(([nacData, edrData]) => {
    // 파트너사 기준으로 묶어서 보이도록 회사명 가나다순 정렬 (모든 탭이 이 배열 순서를 그대로 따른다)
    state.partnersByExam.NAC = sortByCompany(buildPartnerList(nacData.partners));
    state.partnersByExam.EDR = sortByCompany(buildPartnerList(edrData.partners));
    state.resultSheetUrlByExam.NAC = nacData.resultSheetUrl;
    state.resultSheetUrlByExam.EDR = edrData.resultSheetUrl;
    selectedExamSendIds.clear(); // 새로 불러온 명단 기준으로 id가 재배정되므로 기존 선택은 초기화
    expandedGradingIds.clear();
    gradingAutoSyncDone = false; // 새 명단 로드 시 채점 동기화 상태 초기화
    gradingAiDone = false;

    state.isSyncing = false;
    btn.disabled = false;
    btn.textContent = 'Google Sheets 연동';

    renderAll();
    showToast('Google Sheets 연동이 완료되었습니다.');
  }).catch((err) => {
    state.isSyncing = false;
    btn.disabled = false;
    btn.textContent = 'Google Sheets 연동';
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
  const level = examSendLevel;

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
let formCreateLevel = '초급'; // '초급' | '중급'

function apiKey() {
  return encodeURIComponent(SHEETS_ACCESS_KEY);
}

async function fetchExamFormStatus() {
  const url = `${SHEETS_API_BASE_URL}/api/exam-forms/status?key=${apiKey()}&year=${state.selectedYear}&month=${state.selectedMonth}&level=${encodeURIComponent(formCreateLevel)}`;
  return apiFetch(url);
}

async function fetchCreateExamForm() {
  const url = `${SHEETS_API_BASE_URL}/api/exam-forms/create?key=${apiKey()}`;
  return apiFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ year: state.selectedYear, month: state.selectedMonth, level: formCreateLevel }),
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

  const rows = examinees.map((p, index) => {
    const passed = isPass(p.totalScore);
    const isDownloading = downloadingCertificateIds.has(p.id);
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
      </tr>
    `;
  }).join('');

  container.innerHTML = `
    <table class="data-table">
      <thead>
        <tr><th>No.</th><th>이름</th><th>평가 항목 선택</th><th>사명</th><th>총점</th><th>합격여부</th><th>수료증</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/* 수료증 다운로드 - 같은 회사 소속 응시완료자 전원을 한 표에 묶어 PDF로 생성한다 */
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
  renderExamTypeSwitch();
  renderAll();
}

function renderExamTypeSwitch() {
  document.querySelectorAll('.exam-type-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.examType === state.examType);
  });
}

/* ----------------------- 전체 다시 그리기 ----------------------- */
function renderAll() {
  renderPartnersTab();
  renderAttendanceTab();
  renderExamSendTab();
  renderExamCheckTab();
  renderGradingTab();
  renderApprovalTab();
  renderPassListTab();
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
    if (action === 'send-single-email') handleSendSingleEmail(id);
    if (action === 'download-certificate') handleDownloadCertificate(id);
    if (action === 'toggle-month-dropdown') {
      e.stopPropagation();
      toggleMonthDropdown();
    }
    if (action === 'select-month') selectMonth(target.dataset.month);
    // 시험 발송 - 초급/중급 선택
    if (action === 'set-exam-send-level') {
      examSendLevel = target.dataset.level;
      document.querySelectorAll('[data-action="set-exam-send-level"]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.level === examSendLevel);
      });
    }
    // 채점 관련
    if (action === 'manual-sync-grading') handleAutoSyncGrading();
    if (action === 'grade-from-form') handleGradeFromForm();
    // 문제 폼 생성 관련
    if (action === 'set-form-level') {
      formCreateLevel = target.dataset.level;
      document.querySelectorAll('[data-action="set-form-level"]').forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.level === formCreateLevel);
      });
      formCreateCache = null;
      handleRefreshFormStatus();
    }
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
