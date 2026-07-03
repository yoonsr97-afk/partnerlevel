/**
 * 정답 파일 일괄 생성 스크립트
 * - 객관식: Google Forms API로 문항 구조 읽기 (정답은 빈 값 → 수동 입력 필요)
 * - 주관식: templates/*.docx Q&A 파일에서 모범답안 자동 추출
 *
 * 실행: node setup-answer-keys.js
 */

require('dotenv').config();
const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

const TEMPLATES_DIR = path.join(__dirname, 'templates');
const ANSWER_KEYS_DIR = path.join(__dirname, 'templates', 'answer-keys');
if (!fs.existsSync(ANSWER_KEYS_DIR)) fs.mkdirSync(ANSWER_KEYS_DIR, { recursive: true });

// ─── 폼 설정 ────────────────────────────────────────────────────────────────
const FORM_CONFIG = [
  {
    examType: 'NAC',
    formType: 'A',
    formUrl: 'https://docs.google.com/forms/d/1kJyDX9UHB6mhql42szVX3a1shNzFqSkoXuQqUzSwHQ8/edit',
    docxFile: 'NAC 초급문제 서술형 답안지 A형 (Q&A).docx',
  },
  {
    examType: 'NAC',
    formType: 'B',
    formUrl: 'https://docs.google.com/forms/d/1ujDptwz26e0vPdEwkfpUINJaqKuk05J3xh-BjRHaM24/edit',
    docxFile: 'NAC 초급문제 서술형 답안지 B형 (Q&A).docx',
  },
  {
    examType: 'NAC',
    formType: 'C',
    formUrl: 'https://docs.google.com/forms/d/1vfrtWBHAQ7QPlwGENK4ToG86x7xnHBukz7Bz4lwjbjE/edit',
    docxFile: 'NAC 초급문제 서술형 답안지 C형 (Q&A).docx',
  },
];

const SKIP_TITLES = new Set(['파트너명', '파트너명 (위에 없을 경우 직접 입력)']);
const NAME_TITLE = '이름';

// ─── 유틸 ────────────────────────────────────────────────────────────────────
function decodeXmlEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function extractFormId(formUrl) {
  const m = (formUrl || '').match(/\/forms\/d\/([a-zA-Z0-9_-]+)/);
  if (!m) throw new Error('유효하지 않은 Forms URL: ' + formUrl);
  return m[1];
}

// ─── Google Forms API ────────────────────────────────────────────────────────
function getKeyFilePath() {
  return process.env.SERVICE_ACCOUNT_KEY_PATH
    ? path.resolve(__dirname, process.env.SERVICE_ACCOUNT_KEY_PATH)
    : path.join(__dirname, 'service-account.json');
}

async function getFormsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: getKeyFilePath(),
    scopes: [
      'https://www.googleapis.com/auth/forms.body.readonly',
      'https://www.googleapis.com/auth/forms.responses.readonly',
    ],
  });
  return google.forms({ version: 'v1', auth: await auth.getClient() });
}

async function loadFormStructure(formId) {
  const forms = await getFormsClient();
  const res = await forms.forms.get({ formId });
  const form = res.data;

  let nameQuestionId = null;
  const objectiveQuestions = [];
  const subjectiveQuestions = [];

  (form.items || []).forEach((item) => {
    const qi = item.questionItem;
    if (!qi) return;
    const q = qi.question;
    if (!q) return;

    const questionId = q.questionId;
    const title = decodeXmlEntities((item.title || '').trim());

    if (SKIP_TITLES.has(title)) return;
    if (title === NAME_TITLE && q.textQuestion) { nameQuestionId = questionId; return; }

    if (q.choiceQuestion) {
      const isCheckbox = q.choiceQuestion.type === 'CHECKBOX';
      // 퀴즈로 설정된 경우 grading에서 정답 읽기, 아니면 빈 값
      let correctAnswer = '';
      let correctAnswers = null;
      const grading = q.grading;
      if (grading && grading.correctAnswers) {
        const answers = grading.correctAnswers.answers || [];
        if (isCheckbox) {
          correctAnswers = answers.map((a) => a.value);
        } else {
          correctAnswer = answers.length > 0 ? answers[0].value : '';
        }
      }
      objectiveQuestions.push({
        questionId,
        title,
        type: q.choiceQuestion.type,
        options: q.choiceQuestion.options.map((o) => decodeXmlEntities(o.value)),
        correctAnswer: isCheckbox ? null : correctAnswer,
        correctAnswers: isCheckbox ? (correctAnswers || []) : null,
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

  return { formId, title: form.info.title, nameQuestionId, objectiveQuestions, subjectiveQuestions };
}

// ─── docx 파싱 ───────────────────────────────────────────────────────────────
async function readDocxParagraphs(filePath) {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);
  const xml = await zip.file('word/document.xml').async('text');

  const paragraphs = [];
  for (const part of xml.split(/<w:p[ >\/]/)) {
    const texts = [];
    const re = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let m;
    while ((m = re.exec(part)) !== null) {
      if (m[1]) texts.push(m[1]);
    }
    const line = decodeXmlEntities(texts.join('').trim());
    if (line) paragraphs.push(line);
  }
  return paragraphs;
}

/**
 * Q)/A) 또는 접두어 없는 혼합 형식 파싱
 * A형 처음 두 Q&A는 접두어가 없음 (다른 형식)
 */
function parseDocxQA(paragraphs) {
  const pairs = [];
  let currentQ = null;
  let currentA = [];
  let inAnswer = false;

  for (let i = 0; i < paragraphs.length; i++) {
    const line = paragraphs[i];

    const isQPrefix = /^Q\)\s*/i.test(line);
    const isAPrefix = /^A\)\s*/i.test(line);

    if (isQPrefix) {
      if (currentQ !== null) pairs.push({ q: currentQ, a: currentA.join(' ').trim() });
      currentQ = line.replace(/^Q\)\s*/i, '').trim();
      currentA = [];
      inAnswer = false;
    } else if (isAPrefix) {
      currentA = [line.replace(/^A\)\s*/i, '').trim()];
      inAnswer = true;
    } else if (currentQ === null && i > 0 && line.includes('?')) {
      // A형: 접두어 없는 질문 (물음표 포함)
      pairs.push && currentQ !== null && pairs.push({ q: currentQ, a: currentA.join(' ').trim() });
      currentQ = line.trim();
      currentA = [];
      inAnswer = false;
    } else if (currentQ !== null && !inAnswer) {
      // 접두어 없는 답변 (A형 초반)
      currentA = [line.trim()];
      inAnswer = true;
    } else if (currentQ !== null && inAnswer) {
      currentA.push(line.trim());
    }
    // 첫 번째 줄 (제목) 또는 기타 → 무시
  }

  if (currentQ !== null) pairs.push({ q: currentQ, a: currentA.join(' ').trim() });
  return pairs;
}

// 단어 겹침 기반 유사도 (0~1)
function similarity(a, b) {
  const wordsA = new Set(a.toLowerCase().replace(/[?!.,]/g, '').split(/\s+/).filter((w) => w.length > 1));
  const wordsB = new Set(b.toLowerCase().replace(/[?!.,]/g, '').split(/\s+/).filter((w) => w.length > 1));
  if (!wordsA.size || !wordsB.size) return 0;
  const overlap = [...wordsA].filter((w) => wordsB.has(w)).length;
  return overlap / Math.max(wordsA.size, wordsB.size);
}

function matchSubjectiveWithDocx(subjectiveQuestions, qaPairs) {
  return subjectiveQuestions.map((sq) => {
    let bestIdx = -1;
    let bestScore = 0;
    qaPairs.forEach((qa, i) => {
      const s = similarity(sq.title, qa.q);
      if (s > bestScore) { bestScore = s; bestIdx = i; }
    });

    const matched = bestScore >= 0.3 && bestIdx >= 0 ? qaPairs[bestIdx] : null;
    return {
      ...sq,
      modelAnswer: matched ? matched.a : '',
      rubric: '',
      _matchScore: matched ? Math.round(bestScore * 100) + '%' : '미매칭',
      _docxQuestion: matched ? matched.q : '',
    };
  });
}

// ─── 메인 ────────────────────────────────────────────────────────────────────
async function generateAnswerKey({ examType, formType, formUrl, docxFile }) {
  console.log(`\n[${examType} ${formType}형]`);

  // 1. Forms API
  const formId = extractFormId(formUrl);
  console.log(`  Forms 읽는 중... (${formId})`);
  const structure = await loadFormStructure(formId);
  console.log(`  객관식 ${structure.objectiveQuestions.length}문항 | 주관식 ${structure.subjectiveQuestions.length}문항`);

  // 2. docx Q&A
  const docxPath = path.join(TEMPLATES_DIR, docxFile);
  let subjectiveQuestions = structure.subjectiveQuestions;

  if (fs.existsSync(docxPath)) {
    console.log(`  답안지 읽는 중... ${docxFile}`);
    const paras = await readDocxParagraphs(docxPath);
    const qaPairs = parseDocxQA(paras);
    console.log(`  추출된 Q&A: ${qaPairs.length}쌍`);

    if (structure.subjectiveQuestions.length > 0) {
      subjectiveQuestions = matchSubjectiveWithDocx(structure.subjectiveQuestions, qaPairs);
      const matched = subjectiveQuestions.filter((q) => q.modelAnswer).length;
      console.log(`  주관식 매칭: ${matched}/${subjectiveQuestions.length}`);
      subjectiveQuestions.forEach((sq) => {
        const icon = sq.modelAnswer ? '✓' : '✗';
        console.log(`    ${icon} [${sq._matchScore}] ${sq.title.slice(0, 40)}...`);
      });
    } else {
      console.log('  ⚠ 폼에 주관식 문항이 없습니다. (텍스트 응답 없음)');
      // 폼에 주관식이 없으면 docx 내용만 별도 저장
      const docxOnly = qaPairs.map((qa, i) => ({
        questionId: `docx_${i}`,
        title: qa.q,
        maxScore: 4,
        modelAnswer: qa.a,
        rubric: '',
        _source: 'docx_only',
      }));
      subjectiveQuestions = docxOnly;
    }
  } else {
    console.log(`  ⚠ docx 파일 없음: ${docxFile}`);
  }

  // 3. 저장
  const template = {
    examType,
    formType,
    formId,
    pointsPerObjective: 1.5,
    nameQuestionId: structure.nameQuestionId,
    _note: [
      '객관식 RADIO: correctAnswer에 정답 선택지 텍스트를 그대로 입력 (폼에 퀴즈정답이 없으면 빈 문자열)',
      '객관식 CHECKBOX: correctAnswers 배열에 정답 선택지들 입력',
      '주관식: modelAnswer는 docx에서 자동 추출됨, rubric 직접 입력 가능, maxScore 수정 가능',
    ],
    objectiveQuestions: structure.objectiveQuestions,
    subjectiveQuestions,
  };

  const filePath = path.join(ANSWER_KEYS_DIR, `${examType}_${formType}.json`);
  fs.writeFileSync(filePath, JSON.stringify(template, null, 2), 'utf8');
  console.log(`  저장: ${filePath}`);
  return template;
}

async function main() {
  console.log('=== 정답 파일 생성 시작 ===');
  let successCount = 0;

  for (const config of FORM_CONFIG) {
    try {
      await generateAnswerKey(config);
      successCount++;
    } catch (err) {
      console.error(`  오류 (${config.examType} ${config.formType}형): ${err.message}`);
    }
  }

  console.log(`\n=== 완료: ${successCount}/${FORM_CONFIG.length}개 생성 ===`);
  console.log(`저장 위치: ${ANSWER_KEYS_DIR}`);
  console.log('');
  console.log('다음 단계:');
  console.log('  1. 생성된 JSON 파일에서 correctAnswer 항목에 정답을 입력하세요.');
  console.log('  2. 주관식 rubric(채점기준)을 필요시 추가하세요.');
}

main().catch((err) => {
  console.error('치명적 오류:', err.message);
  process.exit(1);
});
