/* =========================================================================
 * 시험 폼 생성 모듈
 * -------------------------------------------------------------------------
 * 1. 공유 드라이브 "80.문제자료(2020~)" → "NAC 초급/중급(YYYY)" 폴더 탐색
 * 2. 템플릿 폼(.env: TEMPLATE_FORM_ID_NAC_A/B/C/MID)을 복사 → 이름 변경 → 폴더 이동
 * 3. 게시: Forms API setPublishSettings 사용 (Drive 공유 설정 불변 → 편집자 링크 제한됨 유지)
 * ========================================================================= */

require('dotenv').config();
const { google } = require('googleapis');
const { getAuthClient } = require('./auth');

// 폼 편집 URL(또는 단순 ID)에서 Google Forms 파일 ID만 추출
function extractFormId(value) {
  const m = (value || '').match(/\/forms\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : (value || '').trim();
}

// 월 → 유형 코드
// 초급: 월 % 3 → A/B/C 순환  |  중급: 유형 없음 → 'MID' 고정
function getFormTypeChar(month, level) {
  if (level === '중급') return 'MID';
  const r = month % 3;
  if (r === 1) return 'A';
  if (r === 2) return 'B';
  return 'C';
}

// 폼 이름 생성
// 초급 예: "초급 평가문제 a형_260701_2026년 7월"
// 중급 예: "중급 평가문제_260701_2026년 7월"
function buildFormName(year, month, typeChar, level) {
  const yy = String(year).slice(-2);
  const mm = String(month).padStart(2, '0');
  if (level === '중급') {
    return `중급 평가문제_${yy}${mm}01_${year}년 ${month}월`;
  }
  return `초급 평가문제 ${typeChar}형_${yy}${mm}01_${year}년 ${month}월`;
}

async function getDriveClient() {
  return google.drive({ version: 'v3', auth: getAuthClient(['https://www.googleapis.com/auth/drive']) });
}

async function getFormsClient() {
  return google.forms({ version: 'v1', auth: getAuthClient(['https://www.googleapis.com/auth/forms.body']) });
}

const DRIVE_OPT = {
  includeItemsFromAllDrives: true,
  supportsAllDrives: true,
  corpora: 'allDrives',
};

// 공유 드라이브에서 "80.문제자료(2020~)" 루트 폴더 탐색
// EXAM_FORMS_ROOT_FOLDER_ID 가 설정되어 있으면 이름 검색 없이 바로 사용한다
async function findRootFolder(drive) {
  const rootFolderId = (process.env.EXAM_FORMS_ROOT_FOLDER_ID || '').trim();
  if (rootFolderId) {
    return { id: rootFolderId, name: process.env.EXAM_FORMS_ROOT_FOLDER || '80.문제자료(2020~)' };
  }

  const rootName = process.env.EXAM_FORMS_ROOT_FOLDER || '80.문제자료(2020~)';
  const res = await drive.files.list({
    q: `name = '${rootName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    ...DRIVE_OPT,
  });
  const f = (res.data.files || [])[0];
  if (!f) throw new Error(`루트 폴더를 찾을 수 없습니다: ${rootName} (EXAM_FORMS_ROOT_FOLDER_ID 를 .env 에 직접 지정하면 이름 검색을 건너뜁니다)`);
  return f;
}

// 루트 하위에서 "NAC 초급/중급" + 연도가 들어간 폴더 탐색
async function findNacFolder(drive, rootFolderId, year, level) {
  const levelKw = level === '중급' ? 'NAC 중급' : 'NAC 초급';
  const res = await drive.files.list({
    q: `'${rootFolderId}' in parents and name contains '${levelKw}' and name contains '${year}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    ...DRIVE_OPT,
  });
  const f = (res.data.files || [])[0];
  if (!f) throw new Error(`${levelKw} ${year} 폴더를 찾을 수 없습니다. (공유 드라이브 확인 필요)`);
  return f;
}

// 특정 폴더에서 해당 월 폼 존재 여부 확인
async function findExistingMonthForm(drive, folderId, year, month, level) {
  const yearMonthStr = `${year}년 ${month}월`;
  const nameFilter = level === '중급'
    ? `name contains '중급 평가문제'`
    : `name contains '초급 평가문제 ${getFormTypeChar(month, level)}형'`;
  const res = await drive.files.list({
    q: `'${folderId}' in parents and ${nameFilter} and name contains '${yearMonthStr}' and mimeType = 'application/vnd.google-apps.form' and trashed = false`,
    fields: 'files(id, name, webViewLink)',
    ...DRIVE_OPT,
  });
  return (res.data.files || [])[0] || null;
}

/* =========================================================================
 * 상태 조회: 해당 월 폼 존재 여부 + 게시 여부
 * ========================================================================= */
async function getExamFormStatus(year, month, level = '초급') {
  const drive = await getDriveClient();
  const formType = getFormTypeChar(month, level); // A/B/C 또는 MID
  const templateKey = `TEMPLATE_FORM_ID_NAC_${formType}`;
  const templateId = process.env[templateKey] || '';

  const root = await findRootFolder(drive);
  const nacFolder = await findNacFolder(drive, root.id, year, level);

  const existing = await findExistingMonthForm(drive, nacFolder.id, year, month, level);

  let published = false;
  let respondentUrl = '';
  let editUrl = '';

  if (existing) {
    editUrl = `https://docs.google.com/forms/d/${existing.id}/edit`;
    respondentUrl = `https://docs.google.com/forms/d/${existing.id}/viewform`;

    // Forms API로 publishSettings.publishState.isPublished 확인
    try {
      const forms = await getFormsClient();
      const formData = await forms.forms.get({ formId: existing.id });
      const publishState = formData.data.publishSettings?.publishState;
      published = publishState?.isPublished === true;
      if (formData.data.responderUri) respondentUrl = formData.data.responderUri;
    } catch {
      published = false;
    }
  }

  return {
    year, month, level,
    formType,
    templateConfigured: !!templateId,
    targetFolder: { id: nacFolder.id, name: nacFolder.name },
    form: existing
      ? { id: existing.id, name: existing.name, editUrl, respondentUrl, published }
      : null,
  };
}

/* =========================================================================
 * 폼 생성: 템플릿 복사 → 이름 변경 → 폴더 이동
 * ========================================================================= */
async function createExamForm(year, month, level = '초급') {
  const drive = await getDriveClient();
  const formType = getFormTypeChar(month, level); // A/B/C 또는 MID
  const templateKey = `TEMPLATE_FORM_ID_NAC_${formType}`;
  // URL 전체를 넣었을 경우에도 ID만 추출
  const templateId = extractFormId(process.env[templateKey]);

  if (!templateId) {
    throw new Error(
      `.env의 ${templateKey} 가 설정되지 않았습니다. 템플릿 폼 ID를 입력하세요.`
    );
  }

  const root = await findRootFolder(drive);
  const nacFolder = await findNacFolder(drive, root.id, year, level);

  // 이미 존재하면 기존 폼 반환
  const existing = await findExistingMonthForm(drive, nacFolder.id, year, month, level);
  if (existing) {
    return {
      id: existing.id,
      name: existing.name,
      editUrl: `https://docs.google.com/forms/d/${existing.id}/edit`,
      respondentUrl: `https://docs.google.com/forms/d/${existing.id}/viewform`,
      alreadyExisted: true,
    };
  }

  const newName = buildFormName(year, month, formType, level);

  // ① 템플릿 복사 (parents 미지정 → 서비스 계정 My Drive에 생성)
  const copied = await drive.files.copy({
    fileId: templateId,
    supportsAllDrives: true,
    fields: 'id, parents',
    requestBody: { name: newName },
  });

  const formId = copied.data.id;
  const prevParents = (copied.data.parents || []).join(',');

  // ② 공유 드라이브 목표 폴더로 이동
  await drive.files.update({
    fileId: formId,
    supportsAllDrives: true,
    addParents: nacFolder.id,
    removeParents: prevParents,
    fields: 'id, parents',
    requestBody: {},
  });

  return {
    id: formId,
    name: newName,
    editUrl: `https://docs.google.com/forms/d/${formId}/edit`,
    respondentUrl: `https://docs.google.com/forms/d/${formId}/viewform`,
    alreadyExisted: false,
  };
}

/* =========================================================================
 * 게시: Forms API setPublishSettings 사용 (직접 HTTP 요청)
 * - googleapis 라이브러리에 아직 메서드가 없어 fetch 로 직접 호출
 * - Drive 공유 설정을 변경하지 않아 편집자 링크는 "제한됨" 유지
 * - isPublished: true → 응답자 링크 접근 가능 / isAcceptingResponses: true → 응답 수락
 * ========================================================================= */
async function publishExamForm(formId) {
  const authClient = getAuthClient(['https://www.googleapis.com/auth/forms.body']);
  const { token } = await authClient.getAccessToken();

  const res = await fetch(
    `https://forms.googleapis.com/v1/forms/${formId}:setPublishSettings`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        publishSettings: {
          publishState: { isPublished: true, isAcceptingResponses: true },
        },
      }),
    }
  );

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData?.error?.message || `게시 실패 (HTTP ${res.status})`);
  }

  const data = await res.json().catch(() => ({}));
  const respondentUrl = data.responderUri
    || `https://docs.google.com/forms/d/${formId}/viewform`;

  return {
    respondentUrl,
    editUrl: `https://docs.google.com/forms/d/${formId}/edit`,
    published: true,
  };
}

/* =========================================================================
 * 삭제: 폼을 휴지통으로 이동
 * drive.files.delete(영구삭제)는 공유 드라이브에서 Organizer 권한이 필요하므로,
 * trashed:true(휴지통 이동)를 사용한다 — Contributor 권한으로도 가능.
 * ========================================================================= */
async function deleteExamForm(formId) {
  const drive = await getDriveClient();
  await drive.files.update({
    fileId: formId,
    supportsAllDrives: true,
    requestBody: { trashed: true },
  });
  return { deleted: true };
}

module.exports = { getExamFormStatus, createExamForm, publishExamForm, deleteExamForm };
