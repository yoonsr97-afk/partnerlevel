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

    if (title === '이름') nameQId = q.questionId;
    else if (title === '파트너명') companyQId = q.questionId;
    else if (title.startsWith('파트너명') && title.includes('직접')) companyAltQId = q.questionId;
  }

  return { nameQId, companyQId, companyAltQId };
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
      company: extractTextAnswer(r, companyQId) || extractTextAnswer(r, companyAltQId) || null,
      email: r.respondentEmail || null,
    }))
    .filter((r) => r.name); // 이름 없는 응답은 제외

  return { totalResponses: responses.length, respondents };
}

/* =========================================================================
 * 파트너 명단과 폼 응답을 비교해 응시 여부를 반환
 *
 * @param {string} formId
 * @param {Array<{name, company, email}>} partners  - 신청자 명단
 * @returns {{ totalResponses, matched: Array<{name, company, matchType}>, unmatched: string[] }}
 * ========================================================================= */
async function matchExamResponses(formId, partners) {
  const { totalResponses, respondents } = await getExamResponses(formId);

  const matched = [];   // 파트너 명단에서 응시 확인된 사람
  const unmatched = []; // 폼엔 있지만 명단에 없는 응답자

  for (const r of respondents) {
    // 1순위: 이름 + 사명 동시 일치
    let partner = partners.find(
      (p) => p.name === r.name && r.company && p.company === r.company
    );
    let matchType = '이름+사명';

    // 2순위: 이름만 일치
    if (!partner) {
      partner = partners.find((p) => p.name === r.name);
      matchType = '이름';
    }

    if (partner) {
      // 이미 추가된 경우 중복 방지 (같은 사람이 여러 번 제출)
      if (!matched.find((m) => m.name === partner.name && m.company === partner.company)) {
        matched.push({ name: partner.name, company: partner.company, matchType });
      }
    } else {
      unmatched.push(r.name + (r.company ? ` (${r.company})` : ''));
    }
  }

  return { totalResponses, matched, unmatched };
}

module.exports = { getExamResponses, matchExamResponses };
