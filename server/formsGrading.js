/* =========================================================================
 * 시험 폼(Google Forms) 자동 채점 모듈
 * -------------------------------------------------------------------------
 * 1. Google Drive 공유 드라이브에서 해당 월/유형 시험 폼을 이름으로 탐색
 *    - 파일명 패턴: "초급 평가문제 {a|b|c}형_{YYMMDD}_{YYYY}년 {M}월"
 * 2. Forms API로 응답자 답변 전체를 읽어옴
 * 3. templates/answer-keys/NAC_{A|B|C}.json 정답 파일과 비교해 객관식 자동 채점
 * 4. 주관식 답변은 modelAnswer와 함께 반환 → 사람/AI가 추후 채점
 *
 * 사전 조건 (1회 설정):
 *   - GCP 콘솔: Google Drive API 활성화
 *   - GCP 콘솔: Google Forms API 활성화 (이미 완료)
 *   - 공유 드라이브에 service account 이메일을 멤버로 추가 (콘텐츠 관리자 이상)
 *   - templates/answer-keys/NAC_A.json 등 정답 파일 작성 (POST /api/generate-answer-template로 템플릿 생성)
 * ========================================================================= */

const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const { gradeSubjectiveAnswer } = require('./aiGrading');
const { getAuthClient } = require('./auth');

const ANSWER_KEYS_DIR = path.join(__dirname, 'templates', 'answer-keys');
if (!fs.existsSync(ANSWER_KEYS_DIR)) {
  fs.mkdirSync(ANSWER_KEYS_DIR, { recursive: true });
}

async function getFormsClient() {
  return google.forms({ version: 'v1', auth: getAuthClient([
    'https://www.googleapis.com/auth/forms.body.readonly',
    'https://www.googleapis.com/auth/forms.responses.readonly',
  ]) });
}

async function getDriveClient() {
  return google.drive({ version: 'v3', auth: getAuthClient([
    'https://www.googleapis.com/auth/drive.metadata.readonly',
  ]) });
}

function extractFormId(formUrl) {
  const match = (formUrl || '').match(/\/forms\/d\/([a-zA-Z0-9_-]+)/);
  if (!match) throw new Error('유효한 Google Forms URL이 아닙니다.');
  return match[1];
}

// 월 번호 → 시험 유형 문자 (파일명 검색용)
function getFormTypeChar(month) {
  const r = month % 3;
  if (r === 1) return 'A';
  if (r === 2) return 'B';
  return 'C';
}

/* =========================================================================
 * 공유 드라이브에서 해당 월 시험 폼 탐색
 * 초급: "초급 평가문제 A형_260701_2026년 7월"
 * 중급: "중급 평가문제_260701_2026년 7월"
 * ========================================================================= */
async function findExamFormInDrive(year, month, level = '초급') {
  const yearMonthStr = `${year}년 ${month}월`;
  let nameContains, formType;

  if (level === '중급') {
    nameContains = `name contains '중급 평가문제'`;
    formType = 'MID';
  } else {
    const typeChar = getFormTypeChar(month);
    nameContains = `name contains '초급 평가문제 ${typeChar}형'`;
    formType = typeChar;
  }

  const drive = await getDriveClient();
  const q = [
    nameContains,
    `name contains '${yearMonthStr}'`,
    `mimeType = 'application/vnd.google-apps.form'`,
    `trashed = false`,
  ].join(' and ');

  const res = await drive.files.list({
    q,
    fields: 'files(id, name)',
    includeItemsFromAllDrives: true,
    supportsAllDrives: true,
    corpora: 'allDrives',
  });

  const files = res.data.files || [];
  if (files.length === 0) {
    throw new Error(
      `공유 드라이브에서 ${year}년 ${month}월 ${level} 시험 폼을 찾을 수 없습니다.\n` +
      `검색 조건: 이름에 '${level === '중급' ? '중급 평가문제' : `초급 평가문제 ${getFormTypeChar(month)}형`}' AND '${yearMonthStr}' 포함`
    );
  }

  return { formId: files[0].id, formName: files[0].name, formType };
}

/* =========================================================================
 * 폼 구조 읽기 - 문항 목록과 questionId 추출
 * 응답의 answers 맵 키는 item.itemId가 아니라 question.questionId 를 사용한다
 * ========================================================================= */
async function loadFormStructure(formId) {
  const forms = await getFormsClient();
  const res = await forms.forms.get({ formId });
  const form = res.data;

  // 파트너명, 이름 등 식별 필드는 채점 대상에서 제외
  const SKIP_TITLES = new Set(['파트너명', '파트너명 (위에 없을 경우 직접 입력)']);
  const NAME_TITLE = '이름';

  let nameQuestionId = null;
  const objectiveQuestions = [];
  const subjectiveQuestions = [];

  (form.items || []).forEach((item) => {
    const qi = item.questionItem;
    if (!qi) return;
    const q = qi.question;
    if (!q) return;

    const questionId = q.questionId;
    const title = (item.title || '').trim();

    if (SKIP_TITLES.has(title)) return;

    if (title === NAME_TITLE && q.textQuestion) {
      nameQuestionId = questionId;
      return;
    }

    if (q.choiceQuestion) {
      const isCheckbox = q.choiceQuestion.type === 'CHECKBOX';
      objectiveQuestions.push({
        questionId,
        title,
        type: q.choiceQuestion.type, // 'RADIO' | 'CHECKBOX'
        options: q.choiceQuestion.options.map((o) => o.value),
        // 정답은 관리자가 JSON 파일에 직접 입력 - 템플릿엔 빈 값
        correctAnswer: isCheckbox ? null : '',
        correctAnswers: isCheckbox ? [] : null,
      });
    } else if (q.textQuestion) {
      subjectiveQuestions.push({
        questionId,
        title,
        maxScore: 4,
        modelAnswer: '',
        rubric: '',
      });
    }
  });

  return {
    formId,
    title: form.info.title,
    nameQuestionId,
    objectiveQuestions,
    subjectiveQuestions,
  };
}

/* =========================================================================
 * 정답 파일 템플릿 생성 - 관리자가 correctAnswer 만 채우면 된다
 * templates/answer-keys/NAC_A.json 으로 저장
 * ========================================================================= */
async function generateAnswerKeyTemplate(formUrl, examType, formType) {
  const formId = extractFormId(formUrl);
  const structure = await loadFormStructure(formId);

  const template = {
    examType,
    formType,
    formId,
    pointsPerObjective: 1.5, // 객관식 1문항당 점수
    nameQuestionId: structure.nameQuestionId,
    _note: [
      '객관식 RADIO: correctAnswer 에 정답 선택지 텍스트를 그대로 입력',
      '객관식 CHECKBOX: correctAnswers 배열에 정답 선택지 텍스트들을 입력',
      '주관식: modelAnswer 와 rubric(채점기준) 입력, maxScore 수정 가능',
    ],
    objectiveQuestions: structure.objectiveQuestions,
    subjectiveQuestions: structure.subjectiveQuestions,
  };

  const filePath = path.join(ANSWER_KEYS_DIR, `${examType}_${formType}.json`);
  fs.writeFileSync(filePath, JSON.stringify(template, null, 2), 'utf8');

  return template;
}

// 저장된 정답 파일 로드
function loadAnswerKey(examType, formType) {
  const filePath = path.join(ANSWER_KEYS_DIR, `${examType}_${formType}.json`);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/* =========================================================================
 * 폼 응답 전체 읽기 (페이지네이션 처리)
 * ========================================================================= */
async function fetchFormResponses(formId) {
  const forms = await getFormsClient();
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

// 주관식 답변만 추출 (AI 채점 없이 score=0으로 반환 — 탭 진입 시 자동 동기화용)
function extractSubjectiveAnswersOnly(response, effectiveKey) {
  return (effectiveKey.subjectiveQuestions || []).map((q) => {
    const ad = response.answers?.[q.questionId];
    const texts = (ad?.textAnswers?.answers) || [];
    const answer = texts.map((a) => a.value).join('\n') || '(미응시)';
    return {
      question: q.title,
      maxScore: q.maxScore || 4,
      answer,
      modelAnswer: q.modelAnswer || '(정답 미등록)',
      rationale: '(AI 채점 실행 전)',
      aiScore: 0,
      score: 0,
      reviewMemo: '',
    };
  });
}

// 응답에서 이름 추출 (파트너명 매칭용)
function extractNameFromResponse(response, nameQuestionId) {
  if (!nameQuestionId) return null;
  const ad = response.answers && response.answers[nameQuestionId];
  if (!ad) return null;
  const texts = ad.textAnswers && ad.textAnswers.answers;
  return texts && texts.length > 0 ? texts[0].value.trim() : null;
}

/* =========================================================================
 * 객관식 채점 - 응답 하나를 정답 파일과 비교
 * ========================================================================= */
// 객관식 채점: 정답 개수와 점수를 모두 반환한다.
// correctCount를 직접 들고 다녀서 시트 기록 시 역산(점수÷배율) 불필요.
function gradeObjectiveResponse(response, answerKey) {
  const pointsEach = answerKey.pointsPerObjective || 1.5;
  let correctCount = 0;

  (answerKey.objectiveQuestions || []).forEach((q) => {
    const ad = response.answers && response.answers[q.questionId];
    if (!ad) return;

    const texts = (ad.textAnswers && ad.textAnswers.answers) || [];
    const submitted = texts.map((a) => a.value.trim());

    if (q.type === 'RADIO') {
      if (submitted.length === 1 && q.correctAnswer && submitted[0] === q.correctAnswer.trim()) {
        correctCount++;
      }
    } else if (q.type === 'CHECKBOX') {
      const correctSet = new Set((q.correctAnswers || []).map((s) => s.trim()));
      const submittedSet = new Set(submitted);
      if (
        correctSet.size > 0 &&
        submittedSet.size === correctSet.size &&
        [...submittedSet].every((v) => correctSet.has(v))
      ) {
        correctCount++;
      }
    }
  });

  return {
    correctCount,
    objectiveScore: Math.round(correctCount * pointsEach * 10) / 10,
  };
}

// 주관식 답변 추출 + AI 채점 (Claude - 키워드 일치 기반, 0.5점 단위)
async function gradeSubjectiveAnswers(response, answerKey) {
  const questions = answerKey.subjectiveQuestions || [];
  const results = [];

  for (const q of questions) {
    const ad = response.answers && response.answers[q.questionId];
    const texts = (ad && ad.textAnswers && ad.textAnswers.answers) || [];
    const answer = texts.map((a) => a.value).join('\n') || '(미응시)';
    const maxScore = q.maxScore || 4;

    let aiScore = 0;
    let rationale = '(AI 채점 미실행)';

    try {
      const graded = await gradeSubjectiveAnswer({
        question: q.title,
        modelAnswer: q.modelAnswer || '',
        studentAnswer: answer,
        maxScore,
      });
      aiScore = graded.score;
      rationale = graded.rationale;
    } catch (err) {
      rationale = `채점 오류: ${err.message}`;
    }

    results.push({
      question: q.title,
      maxScore,
      answer,
      modelAnswer: q.modelAnswer || '(정답 미등록)',
      rationale,
      aiScore,
      score: aiScore,
      reviewMemo: '',
    });
  }

  return results;
}

/* =========================================================================
 * 전체 채점 흐름
 * 1. 폼 탐색 (Drive 자동 or URL 직접)
 * 2. 정답 파일 로드
 * 3. 응답 전체 읽기
 * 4. 파트너별 매칭 (이메일 우선, 없으면 이름으로)
 * 5. 객관식 채점 + 주관식 AI 채점
 * ========================================================================= */
async function gradePartnersFromForm({ year, month, examType, level = '초급', formUrl, partners, skipSubjectiveGrading = false }) {
  let formId, formType, formName;

  if (formUrl) {
    formId = extractFormId(formUrl);
    formType = level === '중급' ? 'MID' : getFormTypeChar(month);
    formName = '(수동 입력)';
  } else {
    const found = await findExamFormInDrive(year, month, level);
    formId = found.formId;
    formType = found.formType;
    formName = found.formName;
  }

  const answerKey = loadAnswerKey(examType, formType);

  // 정답 파일이 없으면 폼 구조에서 문항을 파악해 답변만 추출한다.
  // 객관식 정답을 알 수 없으므로 객관식 점수는 0으로 처리하고, 주관식은 AI 채점한다.
  let effectiveKey;
  if (answerKey) {
    effectiveKey = answerKey;
  } else {
    const structure = await loadFormStructure(formId);
    effectiveKey = {
      nameQuestionId: structure.nameQuestionId,
      pointsPerObjective: 0,
      objectiveQuestions: structure.objectiveQuestions.map((q) => ({
        ...q, correctAnswer: '', correctAnswers: [],
      })),
      subjectiveQuestions: structure.subjectiveQuestions,
      _noAnswerKey: true,
    };
  }

  const responses = await fetchFormResponses(formId);

  // 이메일 / 이름 → 응답 매핑
  const byEmail = {};
  const byName = {};
  responses.forEach((r) => {
    if (r.respondentEmail) byEmail[r.respondentEmail.toLowerCase()] = r;
    const name = extractNameFromResponse(r, effectiveKey.nameQuestionId);
    if (name) byName[name] = r;
  });

  // 응시자별 채점 (주관식 AI 채점은 순차 실행 - 병렬 시 API 레이트리밋 방지)
  const results = [];
  for (const p of partners) {
    const emailKey = (p.email || '').toLowerCase();
    const response = byEmail[emailKey] || byName[p.name] || null;

    if (!response) {
      results.push({ email: p.email, name: p.name, hasExamResponse: false });
      continue;
    }

    const subjectiveAnswers = skipSubjectiveGrading
      ? extractSubjectiveAnswersOnly(response, effectiveKey)
      : await gradeSubjectiveAnswers(response, effectiveKey);

    const objResult = answerKey
      ? gradeObjectiveResponse(response, effectiveKey)
      : { correctCount: 0, objectiveScore: 0 };

    results.push({
      email: p.email,
      name: p.name,
      hasExamResponse: true,
      objectiveCorrectCount: objResult.correctCount,
      objectiveScore: objResult.objectiveScore,
      subjectiveAnswers,
      noAnswerKey: !answerKey,
    });
  }

  const gradedCount = results.filter((r) => r.hasExamResponse).length;
  return {
    formId, formType, formName,
    totalResponses: responses.length,
    gradedCount,
    results,
    noAnswerKey: !answerKey,
  };
}

module.exports = {
  generateAnswerKeyTemplate,
  loadAnswerKey,
  gradePartnersFromForm,
  extractFormId,
};
