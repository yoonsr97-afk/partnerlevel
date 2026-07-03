/**
 * 주관식 AI 채점 모듈 (Anthropic Claude)
 * ─────────────────────────────────────────────────────────────────────────────
 * 채점 원칙:
 *  1. 모범답안의 핵심 항목 키워드를 추출해 응시자 답변과 비교
 *  2. 만점 = 필수 항목을 모두 포함한 경우 (예: 5개 중 5개)
 *  3. 부분 점수 = 일치 항목 비율 × maxScore (0.5점 단위 반올림)
 *  4. AI 추론·확장 해석 없이 정답 파일 키워드 일치 여부만 판단
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function getClient() {
  if (!_client) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되지 않았습니다.');
    _client = new Anthropic({ apiKey: key });
  }
  return _client;
}

const SYSTEM_PROMPT = `당신은 NAC 초급 시험 채점 담당자입니다.
반드시 제공된 [모범답안]만을 근거로 채점하며, 모범답안에 없는 내용을 추론하거나 가점을 부여하지 않습니다.
응답은 반드시 JSON만 반환하고, 설명 텍스트를 포함하지 않습니다.`;

function buildUserPrompt(question, modelAnswer, studentAnswer, maxScore) {
  return `[문항]: ${question}

[모범답안]: ${modelAnswer}

[응시자 답변]: ${studentAnswer}

[배점]: ${maxScore}점

채점 지시:
1. 모범답안에서 필수 핵심 항목들을 추출하세요 (콤마 / 번호 / 줄바꿈으로 구분된 단어·구문 단위).
   - "A, B, C" → ["A","B","C"] / "1) A 2) B" → ["A","B"] / "A(설명), B(설명)" → ["A","B"]
2. 응시자 답변에 각 핵심 항목이 포함되어 있는지 판정하세요.
   - 대소문자 무시, 띄어쓰기 차이 허용 (예: "GnAgent" = "gnagent", "MySQL" = "mysql")
   - 핵심 단어가 포함되면 인정 (부가 설명 유무는 무관)
   - 모범답안에 없는 추가 내용은 가점 없음
3. 점수 계산: round((일치 수 / 전체 핵심 항목 수) × ${maxScore} × 2) / 2  (0.5점 단위)
   - 일치 항목이 0개면 0점

아래 JSON 형식만 반환하세요 (설명 텍스트 없이):
{
  "requiredItems": ["항목1", "항목2", ...],
  "matchedItems": ["일치항목1", ...],
  "unmatchedItems": ["미일치항목1", ...],
  "score": <number>,
  "rationale": "<채점 근거 한 문장 (한국어)>"
}`;
}

/**
 * 주관식 답변 1개 채점
 * @param {object} params
 * @param {string} params.question      - 문항 제목
 * @param {string} params.modelAnswer   - 모범답안 (정답 파일)
 * @param {string} params.studentAnswer - 응시자 답변
 * @param {number} params.maxScore      - 배점 (기본 4점)
 * @returns {Promise<{requiredItems, matchedItems, unmatchedItems, score, rationale}>}
 */
async function gradeSubjectiveAnswer({ question, modelAnswer, studentAnswer, maxScore = 4 }) {
  // 모범답안 미등록
  if (!modelAnswer || modelAnswer.trim() === '' || modelAnswer === '(정답 미등록)') {
    return { requiredItems: [], matchedItems: [], unmatchedItems: [], score: 0, rationale: '모범답안 미등록 — 채점 불가' };
  }
  // 미응시
  if (!studentAnswer || studentAnswer.trim() === '' || studentAnswer === '(미응시)') {
    return { requiredItems: [], matchedItems: [], unmatchedItems: [], score: 0, rationale: '미응시' };
  }

  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(question, modelAnswer, studentAnswer, maxScore) }],
  });

  const raw = response.content[0].text.trim();

  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`AI 응답 JSON 파싱 실패: ${raw.slice(0, 100)}`);

  const result = JSON.parse(match[0]);
  result.score = Math.round(Math.min(Math.max(result.score ?? 0, 0), maxScore) * 2) / 2;
  return result;
}

module.exports = { gradeSubjectiveAnswer };
