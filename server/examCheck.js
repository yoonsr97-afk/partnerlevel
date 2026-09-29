/* =========================================================================
 * 응시 확인 모듈
 * -------------------------------------------------------------------------
 * 시험 폼의 응답을 읽어 이름·사명(파트너명)을 추출하고,
 * 파트너 신청 명단과 비교해 실제 응시 여부를 반환한다.
 *
 * 매칭 전략 (우선순위 순):
 *   1. 이름 + 사명 동시 일치
 *   2. 이름만 일치 (사명이 폼에 입력되지 않은 경우 대비)
 * ========================================================================= */

require('dotenv').config();
const { google } = require('googleapis');
const { getAuthClient } = require('./auth');

async function getFormsClient() {
  return google.forms({ version: 'v1', auth: getAuthClient([
    'https://www.googleapis.com/auth/forms.body.readonly',
    'https://www.googleapis.com/auth/forms.responses.readonly',
  ]) });
}

// 폼 응답에서 특정 문항의 텍스트 답변 추출 (RADIO/CHECKBOX 선택지도 textAnswers로 반환됨)
function extractTextAnswer(response, questionId) {
  if (!questionId) return null;
  const ad = response.answers?.[questionId];
  if (!ad) return null;
  const answers = ad.textAnswers?.answers;
  return answers?.length > 0 ? answers[0].value.trim() : null;
}

// 사명을 묻는 문항 제목이 폼마다 다르다 - NAC 폼은 "파트너명", EDR 폼은 "회사"를 쓴다.
// 못 알아보면 사명이 null이 되어 "이름만 일치" 매칭으로 떨어지고, 동명이인이 있으면 엉뚱한
// 사람을 응시 처리할 수 있어서 둘 다 인식한다.
const COMPANY_TITLES = new Set(['파트너명', '회사', '회사명', '소속']);

// 사명 드롭다운의 마지막 선택지는 "목록에 없음"을 뜻한다 - 이걸 고르면 바로 아래 직접입력 칸에 적는다.
// 그대로 두면 사명이 "하단작성"이 되어 명단과 매칭되지 않는다.
const COMPANY_PLACEHOLDER_VALUES = new Set(['하단작성', '기타', '직접입력']);

// 폼 구조에서 이름·사명 문항 ID를 탐색한다
async function getRespondentFieldIds(forms, formId) {
  const res = await forms.forms.get({ formId });
  const items = res.data.items || [];

  let nameQId = null;
  let companyQId = null;
  let companyAltQId = null; // "파트너명 (위에 없을 경우 직접 입력)" 형태의 보조 문항

  for (const item of items) {
    const q = item.questionItem?.question;
    if (!q) continue;
    const title = (item.title || '').trim();

    if (title === '이름') {
      nameQId = q.questionId;
    } else if (COMPANY_TITLES.has(title) || (title.startsWith('파트너명') && title.includes('직접'))) {
      // NAC/GPI 폼은 사명 문항이 "파트너명" 두 개로 같은 제목을 쓴다(드롭다운 + 직접입력).
      // 먼저 나오는 쪽이 드롭다운, 그 다음이 직접입력 칸이다.
      if (!companyQId) companyQId = q.questionId;
      else if (!companyAltQId) companyAltQId = q.questionId;
    }
  }

  return { nameQId, companyQId, companyAltQId };
}

// 드롭다운 값이 비었거나 "하단작성" 같은 안내값이면 직접입력 칸의 값을 쓴다
function resolveCompany(response, companyQId, companyAltQId) {
  const picked = extractTextAnswer(response, companyQId);
  if (picked && !COMPANY_PLACEHOLDER_VALUES.has(picked)) return picked;
  return extractTextAnswer(response, companyAltQId) || picked || null;
}

// 폼 응답 전체 읽기 (페이지네이션 처리)
async function fetchAllResponses(forms, formId) {
  const responses = [];
  let pageToken;

  do {
    const params = { formId, pageSize: 5000 };
    if (pageToken) params.pageToken = pageToken;
    const res = await forms.forms.responses.list(params);
    (res.data.responses || []).forEach((r) => responses.push(r));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return responses;
}

/* =========================================================================
 * 폼 응답에서 응시자 목록(이름 + 사명) 추출
 *
 * @param {string} formId  - Google Forms 파일 ID
 * @returns {{ totalResponses: number, respondents: Array<{name, company, email}> }}
 * ========================================================================= */
async function getExamResponses(formId) {
  const forms = await getFormsClient();

  const [responses, fieldIds] = await Promise.all([
    fetchAllResponses(forms, formId),
    getRespondentFieldIds(forms, formId),
  ]);

  const { nameQId, companyQId, companyAltQId } = fieldIds;

  const respondents = responses
    .map((r) => ({
      name: extractTextAnswer(r, nameQId),
      company: resolveCompany(r, companyQId, companyAltQId),
      email: r.respondentEmail || null,
    }))
    // 이름도 이메일도 없으면 누구인지 알 수 없는 응답이다.
    // (GPI 폼처럼 이름 문항 없이 인증 이메일만 받는 폼이 있어서 이름만으로 거르지 않는다)
    .filter((r) => r.name || r.email);

  return { totalResponses: responses.length, respondents, hasNameQuestion: !!nameQId };
}

/* =========================================================================
 * 파트너 명단과 폼 응답을 비교해 응시 여부를 반환
 *
 * @param {string} formId
 * @param {Array<{name, company, email}>} partners  - 신청자 명단
 * @returns {{ totalResponses, matched: Array<{name, company, matchType}>, unmatched: string[] }}
 * ========================================================================= */
async function matchExamResponses(formId, partners) {
  const { totalResponses, respondents, hasNameQuestion } = await getExamResponses(formId);

  const matched = [];   // 파트너 명단에서 응시 확인된 사람
  const unmatched = []; // 폼엔 있지만 명단에 없는 응답자

  for (const r of respondents) {
    // 1순위: 이름 + 사명 동시 일치
    let partner = r.name ? partners.find(
      (p) => p.name === r.name && r.company && p.company === r.company
    ) : null;
    let matchType = '이름+사명';

    // 2순위: 이름만 일치
    if (!partner && r.name) {
      partner = partners.find((p) => p.name === r.name);
      matchType = '이름';
    }

    // 3순위: 응답자 인증 이메일 일치
    // 이름 문항이 없는 폼(GPI)에서는 이게 유일한 단서다. 단, 응시자가 신청서와 다른
    // 개인 메일로 응시하면 여기서도 못 잡는다 - 그 경우 unmatched로 남아 눈에 띈다.
    if (!partner && r.email) {
      const email = r.email.toLowerCase();
      partner = partners.find((p) => (p.email || '').toLowerCase() === email);
      matchType = '이메일';
    }

    if (partner) {
      // 이미 추가된 경우 중복 방지 (같은 사람이 여러 번 제출)
      if (!matched.find((m) => m.name === partner.name && m.company === partner.company)) {
        matched.push({ name: partner.name, company: partner.company, matchType });
      }
    } else {
      // 이름이 없는 폼이면 이메일로 표시해야 누구인지 알아볼 수 있다
      unmatched.push(r.name
        ? r.name + (r.company ? ` (${r.company})` : '')
        : (r.email || '(식별 불가)'));
    }
  }

  return { totalResponses, matched, unmatched, hasNameQuestion };
}

module.exports = { getExamResponses, matchExamResponses };
