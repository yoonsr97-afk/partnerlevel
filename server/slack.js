/* =========================================================================
 * Slack 수료증 알림 발송
 * -------------------------------------------------------------------------
 * 파트너사 채널에 평가 결과 안내 메시지를 올리고, 그 메시지의 스레드에
 * 수료증 PDF를 댓글로 붙인다. 채널 타임라인은 한 줄만 차지하고 파일은
 * 스레드 안에 들어가서, 채널이 파일로 지저분해지지 않는다.
 *
 * 발송 절차 (Slack Web API)
 *   1. chat.postMessage            - 안내 메시지 게시 → 스레드 기준 ts 획득
 *   2. files.getUploadURLExternal  - 업로드 URL 발급
 *   3. (발급받은 URL로 파일 전송)
 *   4. files.completeUploadExternal - thread_ts를 지정해 스레드에 첨부
 *
 * 필요한 것
 *   - .env 의 SLACK_BOT_TOKEN (xoxb-로 시작하는 봇 토큰)
 *   - 봇 권한(OAuth Scope): chat:write, files:write
 *   - 발송 대상 채널에 봇이 초대되어 있을 것
 * ========================================================================= */
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const SLACK_API = 'https://slack.com/api';
const CHANNEL_CONFIG_PATH = path.join(__dirname, 'slackChannels.json');

/* 테스트 발송 전용 채널.
 * 실제 파트너사 채널로 나가기 전에 문구와 첨부 형태를 확인하는 용도라,
 * 파트너명 매핑을 타지 않고 항상 이 채널로만 간다.
 * 검증이 끝나면 이 상수와 슬랙 발송의 isTest 분기, 화면의 "테스트" 버튼을 함께 걷어내면 된다. */
const TEST_CHANNEL_ID = (process.env.SLACK_TEST_CHANNEL_ID || 'C0B4TF97M8T').trim();

/* -------------------------------------------------------------------------
 * 파트너명 → 채널 ID
 * 시트/폼마다 사명 표기가 조금씩 다르다("(주)티아이에스" vs "티아이에스",
 * "태인시스템" vs "테인시스템"). 정규화해서 비교하고, 그래도 안 잡히는
 * 표기는 aliases 로 보완한다.
 * ------------------------------------------------------------------------- */
function normalizeCompany(name) {
  return String(name || '')
    .replace(/\(주\)|㈜|주식회사/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

let _channelMap = null;
function getChannelMap() {
  if (_channelMap) return _channelMap;

  const raw = JSON.parse(fs.readFileSync(CHANNEL_CONFIG_PATH, 'utf8'));
  const map = new Map();
  for (const entry of raw.channels || []) {
    if (!entry.company || !entry.channelId) continue;
    const names = [entry.company, ...(entry.aliases || [])];
    for (const n of names) {
      map.set(normalizeCompany(n), { channelId: entry.channelId, company: entry.company });
    }
  }
  _channelMap = map;
  return map;
}

function findChannel(company) {
  return getChannelMap().get(normalizeCompany(company)) || null;
}

// 등록된 파트너사 목록 (관리자 확인용)
function listMappedCompanies() {
  const raw = JSON.parse(fs.readFileSync(CHANNEL_CONFIG_PATH, 'utf8'));
  return (raw.channels || []).map((c) => c.company);
}

/* -------------------------------------------------------------------------
 * Slack API 호출 공통
 * Slack은 실패해도 HTTP 200을 주고 본문의 ok:false로 알려준다 - 그래서
 * 상태코드가 아니라 본문을 봐야 하고, error 코드를 그대로 흘리면
 * "not_in_channel" 같은 값이라 무슨 뜻인지 알기 어려워 풀어서 던진다.
 * ------------------------------------------------------------------------- */
const SLACK_ERROR_HINTS = {
  not_in_channel: '봇이 해당 채널에 없습니다. 채널에서 "/invite @앱이름"으로 초대해 주세요.',
  channel_not_found: '채널 ID를 찾을 수 없습니다. slackChannels.json의 channelId를 확인해 주세요.',
  invalid_auth: 'SLACK_BOT_TOKEN이 잘못되었습니다.',
  not_authed: 'SLACK_BOT_TOKEN이 설정되지 않았습니다.',
  token_revoked: 'SLACK_BOT_TOKEN이 폐기되었습니다. 새로 발급해 주세요.',
  missing_scope: '봇 권한이 부족합니다. chat:write, files:write 스코프를 추가하고 앱을 다시 설치해 주세요.',
  is_archived: '보관된(archived) 채널입니다.',
  restricted_action: '워크스페이스 정책으로 차단되었습니다.',
};

function getToken() {
  const token = (process.env.SLACK_BOT_TOKEN || '').trim();
  if (!token) {
    const err = new Error('SLACK_BOT_TOKEN이 설정되지 않았습니다. .env(및 Railway 환경변수)에 봇 토큰을 넣어주세요.');
    err.code = 'SLACK_NOT_CONFIGURED';
    throw err;
  }
  return token;
}

async function callSlack(method, body) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) {
    const hint = SLACK_ERROR_HINTS[data.error];
    const err = new Error(hint ? `${hint} (Slack: ${data.error})` : `Slack ${method} 실패: ${data.error}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

// getUploadURLExternal 만 폼 인코딩(GET 스타일)을 요구한다
async function callSlackForm(method, params) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: new URLSearchParams(params).toString(),
  });
  const data = await res.json();
  if (!data.ok) {
    const hint = SLACK_ERROR_HINTS[data.error];
    const err = new Error(hint ? `${hint} (Slack: ${data.error})` : `Slack ${method} 실패: ${data.error}`);
    err.code = data.error;
    throw err;
  }
  return data;
}

/* -------------------------------------------------------------------------
 * 파일을 스레드 댓글로 올린다
 * ------------------------------------------------------------------------- */
async function uploadFileToThread({ channelId, threadTs, filename, buffer, title, contentType }) {
  // ① 업로드 URL 발급
  const { upload_url: uploadUrl, file_id: fileId } = await callSlackForm('files.getUploadURLExternal', {
    filename,
    length: buffer.length,
  });

  // ② 발급받은 URL로 실제 바이트 전송 (이 요청에는 토큰을 싣지 않는다)
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: contentType || 'application/pdf' }), filename);
  const uploadRes = await fetch(uploadUrl, { method: 'POST', body: form });
  if (!uploadRes.ok) {
    throw new Error(`파일 업로드에 실패했습니다 (HTTP ${uploadRes.status}) - ${filename}`);
  }

  // ③ 업로드 확정 - thread_ts를 주면 채널이 아니라 스레드 안에 붙는다
  return callSlack('files.completeUploadExternal', {
    files: [{ id: fileId, title: title || filename }],
    channel_id: channelId,
    thread_ts: threadTs,
  });
}

/* -------------------------------------------------------------------------
 * 수료증 알림 발송 (메시지 + 스레드 첨부)
 *
 * @param {string} company   파트너사명 (채널 결정에 사용)
 * @param {string} examLabel "NAC 초급" 같은 평가 표기
 * @param {number} year, month
 * @param {Buffer} pdfBuffer 수료증 PDF
 * @param {string} filename  첨부 파일명
 * @param {boolean} isTest   true면 파트너사 채널 대신 테스트 채널로 보낸다
 * @param {Array}  extraFiles 관리자가 직접 고른 추가 첨부 [{ filename, buffer, contentType }]
 * ------------------------------------------------------------------------- */
async function sendCertificateNotice({
  company, examLabel, year, month, pdfBuffer, filename, isTest = false, extraFiles = [],
}) {
  // 테스트 발송은 파트너명 매핑을 타지 않는다 - 채널이 등록되지 않은 파트너사로도 형태를 확인할 수 있어야 한다
  const target = isTest
    ? { channelId: TEST_CHANNEL_ID, company: `${company} (테스트)` }
    : findChannel(company);

  if (!target) {
    const err = new Error(
      `"${company}"의 Slack 채널이 등록되어 있지 않습니다. server/slackChannels.json에 채널 ID를 추가해 주세요.`
    );
    err.code = 'SLACK_CHANNEL_NOT_MAPPED';
    throw err;
  }

  const notice = `${year}.${String(month).padStart(2, '0')}월 ${examLabel} 정기평가 결과 안내 드립니다.`;
  // 테스트 채널에 실제 안내로 오인될 메시지가 남지 않도록 표시를 붙인다
  const text = isTest ? `[테스트 발송 · ${company}] ${notice}` : notice;

  // ① 안내 메시지
  const posted = await callSlack('chat.postMessage', {
    channel: target.channelId,
    text,
  });

  // ② 첨부는 모두 스레드 댓글로 - 채널 타임라인이 파일로 밀리지 않게 한다.
  //    수료증이 먼저 올라가고, 관리자가 고른 추가 파일이 고른 순서대로 뒤따른다.
  //    Slack은 동시 업로드 시 순서를 보장하지 않아 순차로 처리한다.
  const files = [
    { filename, buffer: pdfBuffer, contentType: 'application/pdf' },
    ...extraFiles,
  ];

  const uploaded = [];
  for (const f of files) {
    try {
      await uploadFileToThread({
        channelId: target.channelId,
        threadTs: posted.ts,
        filename: f.filename,
        buffer: f.buffer,
        title: f.filename,
        contentType: f.contentType,
      });
      uploaded.push(f.filename);
    } catch (err) {
      // 메시지는 이미 올라갔고 일부는 붙었을 수 있다 - 어디까지 됐는지 그대로 알려준다
      const done = uploaded.length ? ` (첨부 완료: ${uploaded.join(', ')})` : '';
      const wrapped = new Error(`안내 메시지는 게시했지만 "${f.filename}" 첨부에 실패했습니다: ${err.message}${done}`);
      wrapped.code = 'SLACK_UPLOAD_FAILED';
      wrapped.messageTs = posted.ts;
      wrapped.uploaded = uploaded;
      throw wrapped;
    }
  }

  return {
    channelId: target.channelId,
    company: target.company,
    ts: posted.ts,
    text,
    isTest,
    uploadedFiles: uploaded,
  };
}

module.exports = {
  sendCertificateNotice,
  findChannel,
  listMappedCompanies,
  normalizeCompany,
  TEST_CHANNEL_ID,
};
