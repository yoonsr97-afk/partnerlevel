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
const { getExamFormSpec } = require('./formCreation');

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

/* =========================================================================
 * 공유 드라이브에서 해당 월 시험 폼 탐색
 * 파일명 규칙은 시험 종류마다 달라서 formCreation의 EXAM_FORM_SPECS를 그대로 쓴다.
 *   NAC 초급: "초급 평가문제 A형_260701_2026년 7월"
 *   NAC 중급: "중급 평가문제_260701_2026년 7월"
 *   EDR 초급: "EDR 초급 평가문제_A안_20260624_6월"
 * ========================================================================= */
async function findExamFormInDrive(year, month, level = '초급', examType) {
  const spec = getExamFormSpec(examType);
  const formType = spec.formTypeChar(month, level);

  const drive = await getDriveClient();
  const q = [
    `name contains '${spec.driveNameKeyword(month, level)}'`,
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

  // Drive의 name contains 는 부분일치가 느슨해서, 이름 규칙으로 한 번 더 걸러낸다
  const files = (res.data.files || []).filter((f) => spec.matchesMonth(f.name || '', year, month, level));
  if (files.length === 0) {
    throw new Error(
      `공유 드라이브에서 ${year}년 ${month}월 ${examType} ${level} 시험 폼을 찾을 수 없습니다.\n` +
      `검색 조건: 이름에 '${spec.driveNameKeyword(month, level)}' 포함 + ${year}년 ${month}월 규칙 일치`
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

  // 파트너명/회사/이메일 등 응시자 식별 필드는 채점 대상이 아니다.
  // (EDR 폼에는 "회사", "이메일" 텍스트 문항이 따로 있어서, 빼주지 않으면 주관식으로 잡힌다)
  const SKIP_TITLES = new Set([
    '파트너명', '파트너명 (위에 없을 경우 직접 입력)',
    '회사', '회사명', '소속', '이메일', '이메일 주소',
  ]);
  const NAME_TITLE = '이름';

  let nameQuestionId = null;
  const objectiveQuestions = [];
  const subjectiveQuestions = [];

  // 폼에 퀴즈 채점(정답·배점)이 설정되어 있으면 그걸 정답 파일에 그대로 가져온다.
  // 설정된 문항이 하나도 없는 폼(구 NAC 폼)에서는 지금처럼 빈 값으로 두고 사람이 채운다.
  const items = form.items || [];
  const formHasGrading = items.some((it) => it.questionItem?.question?.choiceQuestion && it.questionItem?.question?.grading);

  items.forEach((item) => {
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
      // 채점을 쓰는 폼인데 이 문항엔 정답이 없다면 점수와 무관한 설문 문항이다
      // (예: "EDR 집체교육 이수 여부") - 객관식 목록에서 빼둔다.
      if (formHasGrading && !q.grading) return;

      const isCheckbox = q.choiceQuestion.type === 'CHECKBOX';
      const gradedAnswers = (q.grading?.correctAnswers?.answers || []).map((a) => a.value);
      objectiveQuestions.push({
        questionId,
        title,
        type: q.choiceQuestion.type, // 'RADIO' | 'CHECKBOX'
        options: q.choiceQuestion.options.map((o) => o.value),
        // 폼에 퀴즈 정답이 있으면 그 값을, 없으면 빈 값(사람이 직접 입력)
        correctAnswer: isCheckbox ? null : (gradedAnswers[0] || ''),
        correctAnswers: isCheckbox ? gradedAnswers : null,
        // 배점이 문항마다 다른 시험(EDR: 2점/3점 혼재)을 위해 폼의 배점을 그대로 가져온다
        ...(q.grading?.pointValue != null ? { points: q.grading.pointValue } : {}),
      });
    } else if (q.textQuestion) {
      subjectiveQuestions.push({
        questionId,
        title,
        maxScore: q.grading?.pointValue != null ? q.grading.pointValue : 4,
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
// 문항 제목 비교용 정규화 - 앞의 번호("1.")와 유형 표시("(서술형)"), 공백/문장부호 차이를 무시한다.
// 폼에서 읽은 제목과 문서(답안지)에서 옮겨적은 제목이 조금씩 다른 걸 흡수하기 위한 것이다.
function normalizeQuestionTitle(title) {
  return String(title || '')
    .replace(/^\s*\d+\s*[.)]\s*/, '')
    .replace(/\((서술형|단답형|객관식|주관식)\)/g, '')
    .replace(/[\s.,?!"'“”‘’]/g, '')
    .toLowerCase();
}

function indexByTitle(questions) {
  const map = new Map();
  (questions || []).forEach((q) => {
    const key = normalizeQuestionTitle(q.title);
    if (key && !map.has(key)) map.set(key, q);
  });
  return map;
}

async function generateAnswerKeyTemplate(formUrl, examType, formType) {
  const formId = extractFormId(formUrl);
  const structure = await loadFormStructure(formId);

  // 이미 입력해둔 정답을 재생성으로 날려버리지 않는다 - 제목이 일치하는 문항의 정답/배점/모범답안을
  // 그대로 물려받는다. 폼을 만들기 전에 답안지만 먼저 정리해둔 경우에도 이 병합으로 살아난다.
  const existing = loadAnswerKey(examType, formType);
  const prevObjective = indexByTitle(existing && existing.objectiveQuestions);
  const prevSubjective = indexByTitle(existing && existing.subjectiveQuestions);
  let carriedOver = 0;

  const objectiveQuestions = structure.objectiveQuestions.map((q) => {
    const prev = prevObjective.get(normalizeQuestionTitle(q.title));
    if (!prev) return q;
    carriedOver++;
    return {
      ...q,
      correctAnswer: prev.correctAnswer != null ? prev.correctAnswer : q.correctAnswer,
      correctAnswers: prev.correctAnswers != null ? prev.correctAnswers : q.correctAnswers,
      ...(prev.points != null ? { points: prev.points } : {}),
    };
  });

  const subjectiveQuestions = structure.subjectiveQuestions.map((q) => {
    const prev = prevSubjective.get(normalizeQuestionTitle(q.title));
    if (!prev) return q;
    carriedOver++;
    return {
      ...q,
      maxScore: prev.maxScore != null ? prev.maxScore : q.maxScore,
      modelAnswer: prev.modelAnswer || q.modelAnswer,
      rubric: prev.rubric || q.rubric,
    };
  });

  // 사람이 직접 적어둔 부가 메타데이터(_scoring 등)는 재생성으로 날리지 않는다.
  // _note는 아래에서 최신 안내문으로 다시 쓰므로 제외한다.
  const carriedMeta = {};
  for (const [key, value] of Object.entries(existing || {})) {
    if (key.startsWith('_') && key !== '_note') carriedMeta[key] = value;
  }

  const template = {
    examType,
    formType,
    formId,
    ...carriedMeta,
    // 객관식 1문항당 기본 점수 (문항별로 다르면 각 문항에 points를 넣어 덮어쓴다)
    pointsPerObjective: (existing && existing.pointsPerObjective != null) ? existing.pointsPerObjective : 1.5,
    nameQuestionId: structure.nameQuestionId,
    _note: [
      '객관식 RADIO: correctAnswer 에 정답 선택지 텍스트를 그대로 입력',
      '객관식 CHECKBOX: correctAnswers 배열에 정답 선택지 텍스트들을 입력',
      '객관식 배점이 문항마다 다르면 해당 문항에 "points": 2 처럼 직접 지정 (없으면 pointsPerObjective 적용)',
      '주관식: modelAnswer 와 rubric(채점기준) 입력, maxScore 수정 가능',
    ],
    objectiveQuestions,
    subjectiveQuestions,
  };

  const filePath = path.join(ANSWER_KEYS_DIR, `${examType}_${formType}.json`);
  fs.writeFileSync(filePath, JSON.stringify(template, null, 2), 'utf8');

  return { ...template, carriedOver };
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
//
// 배점은 문항마다 다를 수 있다. NAC은 전 문항 1.5점 균일(pointsPerObjective)이지만
// EDR은 2점 6문항 + 3점 16문항이 섞여 있어서, 문항의 points를 우선 쓰고 없으면
// pointsPerObjective로 떨어진다.
function gradeObjectiveResponse(response, answerKey) {
  const defaultPoints = answerKey.pointsPerObjective || 1.5;
  let correctCount = 0;
  let objectiveScore = 0;

  (answerKey.objectiveQuestions || []).forEach((q) => {
    const ad = response.answers && response.answers[q.questionId];
    if (!ad) return;

    const texts = (ad.textAnswers && ad.textAnswers.answers) || [];
    const submitted = texts.map((a) => a.value.trim());
    let isCorrect = false;

    if (q.type === 'RADIO') {
      isCorrect = submitted.length === 1 && !!q.correctAnswer && submitted[0] === q.correctAnswer.trim();
    } else if (q.type === 'CHECKBOX') {
      const correctSet = new Set((q.correctAnswers || []).map((s) => s.trim()));
      const submittedSet = new Set(submitted);
      isCorrect = correctSet.size > 0
        && submittedSet.size === correctSet.size
        && [...submittedSet].every((v) => correctSet.has(v));
    }

    if (isCorrect) {
      correctCount++;
      objectiveScore += (q.points != null ? q.points : defaultPoints);
    }
  });

  return {
    correctCount,
    objectiveScore: Math.round(objectiveScore * 10) / 10,
  };
}

// 주관식 답변 추출 + AI 채점 (Claude - 키워드 일치 기반, 0.5점 단위)
async function gradeSubjectiveAnswers(response, answerKey, examType) {
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
        examType,
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
    formType = getExamFormSpec(examType).formTypeChar(month, level);
    formName = '(수동 입력)';
  } else {
    const found = await findExamFormInDrive(year, month, level, examType);
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
      : await gradeSubjectiveAnswers(response, effectiveKey, examType);

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
