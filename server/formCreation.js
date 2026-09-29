/* =========================================================================
 * 시험 폼 생성 모듈
 * -------------------------------------------------------------------------
 * 1. 공유 드라이브 "80.문제자료(2020~)" → 시험별 연도 폴더 탐색
 *    (NAC: "NAC 초급/중급(YYYY)"  |  EDR: "EDR초급(YYYY)")
 * 2. 템플릿 폼(.env: TEMPLATE_FORM_ID_NAC_A/B/C/MID, TEMPLATE_FORM_ID_EDR_A)을
 *    복사 → 이름 변경 → 폴더 이동
 * 3. 게시: Forms API setPublishSettings 사용 (Drive 공유 설정 불변 → 편집자 링크 제한됨 유지)
 *
 * 폴더명·파일명 규칙이 NAC과 EDR에서 서로 달라서, 시험별 차이를 EXAM_FORM_SPECS
 * 한 곳에 모아두고 나머지 흐름(탐색 → 복사 → 이동 → 게시)은 공유한다.
 * ========================================================================= */

require('dotenv').config();
const { google } = require('googleapis');
const { getAuthClient } = require('./auth');

// 폼 편집 URL(또는 단순 ID)에서 Google Forms 파일 ID만 추출
function extractFormId(value) {
  const m = (value || '').match(/\/forms\/d\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : (value || '').trim();
}

/* -------------------------------------------------------------------------
 * 시험 종류별 폴더/파일명 규칙
 * ------------------------------------------------------------------------- */
const EXAM_FORM_SPECS = {
  NAC: {
    // 초급은 월 % 3 → A/B/C 순환
    formTypeChar: (month) => {
      const r = month % 3;
      if (r === 1) return 'A';
      if (r === 2) return 'B';
      return 'C';
    },
    // 폴더명: "NAC 초급(2026)"
    folderKeywords: (year) => ['NAC 초급', String(year)],
    // 파일명: "초급 평가문제 A형_260701_2026년 7월"
    buildFormName: (year, month, typeChar) => {
      const yy = String(year).slice(-2);
      const mm = String(month).padStart(2, '0');
      return `초급 평가문제 ${typeChar}형_${yy}${mm}01_${year}년 ${month}월`;
    },
    // Drive 1차 필터 (서버측)
    driveNameKeyword: (month) => `초급 평가문제 ${EXAM_FORM_SPECS.NAC.formTypeChar(month)}형`,
    // 2차 정밀 매칭 (클라이언트측) - 날짜 부분은 무시하고 유형/연월만 본다
    matchesMonth: (name, year, month) => name.includes(`${year}년 ${month}월`)
      && name.includes(`초급 평가문제 ${EXAM_FORM_SPECS.NAC.formTypeChar(month)}형`),
    templateEnvKey: (formType) => `TEMPLATE_FORM_ID_NAC_${formType}`,
  },
  NAC_MID: {
    // 중급은 유형 순환이 없다 (A형 하나)
    formTypeChar: () => 'A',
    // 폴더명: "NAC 중급(2026)"
    folderKeywords: (year) => ['NAC 중급', String(year)],
    // 파일명: "2026년 NAC중급 정기평가(A)_1월" - 초급과 달리 연도 뒤에 "년"이 붙는다
    buildFormName: (year, month) => `${year}년 NAC중급 정기평가(A)_${month}월`,
    driveNameKeyword: () => 'NAC중급 정기평가',
    // "_01월"처럼 0이 붙은 과거 표기도 같이 받아준다
    matchesMonth: (name, year, month) =>
      new RegExp(`^${year}년?\\s*NAC중급\\s*정기평가\\s*\\([A-Z]\\)_0?${month}월$`).test(name.trim()),
    templateEnvKey: () => 'TEMPLATE_FORM_ID_NAC_MID',
  },
  EDR: {
    // EDR은 A형 한 종류만 운영한다 (월별 A/B/C 순환 없음)
    formTypeChar: () => 'A',
    // 폴더명: "EDR초급(2026)" - NAC과 달리 "EDR"과 "초급" 사이에 공백이 없어 따로 찾는다
    folderKeywords: (year) => ['EDR', '초급', String(year)],
    // 파일명: "EDR 초급 평가문제_A안_20260624_6월"
    // 날짜(8자리)는 실제 시험일이라 앱이 알 수 없어, 생성 시에는 해당 월 1일로 만든다.
    // 탐색은 날짜를 보지 않으므로 수동으로 만든 폼(실제 시험일자)도 그대로 찾아낸다.
    buildFormName: (year, month) => {
      const mm = String(month).padStart(2, '0');
      return `EDR 초급 평가문제_A안_${year}${mm}01_${month}월`;
    },
    driveNameKeyword: () => 'EDR 초급 평가문제',
    // "_6월"로 끝나야 한다 - 그냥 "6월" 포함으로 보면 날짜 자리의 숫자와 뒤섞일 수 있다
    matchesMonth: (name, year, month) => name.includes('EDR 초급 평가문제') && new RegExp(`_${month}월\\s*$`).test(name.trim()),
    templateEnvKey: () => 'TEMPLATE_FORM_ID_EDR_A',
  },
  GPI: {
    // GPI도 A형 한 종류만 운영한다
    formTypeChar: () => 'A',
    // 폴더명: "GPI 초급(2026)"
    folderKeywords: (year) => ['GPI', '초급', String(year)],
    // 파일명: "2026 GPI 정기평가(A)_2월"
    buildFormName: (year, month) => `${year} GPI 정기평가(A)_${month}월`,
    driveNameKeyword: () => 'GPI 정기평가',
    // 연도 뒤 "년"이 붙은 과거 표기("2024년 GPI 정기평가(A)_10월")도 같이 받아준다.
    // 월은 "_2월"로 끝나는 형태만 인정한다 - 그냥 포함으로 보면 "12월"이 "2월"에 걸린다.
    matchesMonth: (name, year, month) => new RegExp(`^${year}년?\\s*GPI\\s*정기평가\\s*\\([A-Z]\\)_${month}월$`).test(name.trim()),
    templateEnvKey: () => 'TEMPLATE_FORM_ID_GPI_A',
  },
};

// examType을 빼먹으면 조용히 NAC으로 넘어가 엉뚱한 시험의 폼을 집어오기 때문에
// (EDR 안내 메일에 NAC 시험지 링크가 실려 나간 적이 있다) 기본값 없이 바로 실패시킨다.
function getExamFormSpec(examType) {
  if (!examType) throw new Error('examType이 지정되지 않았습니다. (NAC 또는 EDR)');
  const spec = EXAM_FORM_SPECS[String(examType).toUpperCase()];
  if (!spec) throw new Error(`지원하지 않는 examType: ${examType}`);
  return spec;
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

// 루트 하위에서 시험별 연도 폴더 탐색 (NAC: "NAC 초급(2026)" / EDR: "EDR초급(2026)")
async function findExamFolder(drive, rootFolderId, year, level, examType) {
  const spec = getExamFormSpec(examType);
  const keywords = spec.folderKeywords(year, level);
  const containsClauses = keywords.map((kw) => `name contains '${kw}'`).join(' and ');
  const res = await drive.files.list({
    q: `'${rootFolderId}' in parents and ${containsClauses} and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
    fields: 'files(id, name)',
    ...DRIVE_OPT,
  });
  const f = (res.data.files || [])[0];
  if (!f) {
    throw new Error(
      `${keywords.join(' ')} 폴더를 찾을 수 없습니다. `
      + `공유 드라이브의 문제자료 루트 아래에 해당 폴더가 있는지 확인해 주세요.`
    );
  }
  return f;
}

// 특정 폴더에서 해당 월 폼 존재 여부 확인
// Drive의 name contains 는 부분일치가 느슨해서, 1차로 넓게 받아온 뒤 이름 규칙으로 다시 걸러낸다.
async function findExistingMonthForm(drive, folderId, year, month, level, examType) {
  const spec = getExamFormSpec(examType);
  const res = await drive.files.list({
    q: `'${folderId}' in parents and name contains '${spec.driveNameKeyword(month, level)}' and mimeType = 'application/vnd.google-apps.form' and trashed = false`,
    fields: 'files(id, name, webViewLink)',
    ...DRIVE_OPT,
  });
  const files = res.data.files || [];
  return files.find((f) => spec.matchesMonth(f.name || '', year, month, level)) || null;
}

/* =========================================================================
 * 상태 조회: 해당 월 폼 존재 여부 + 게시 여부
 * ========================================================================= */
async function getExamFormStatus(year, month, level = '초급', examType) {
  const drive = await getDriveClient();
  const spec = getExamFormSpec(examType);
  const formType = spec.formTypeChar(month, level); // NAC: A/B/C/MID, EDR: A 고정
  const templateKey = spec.templateEnvKey(formType);
  const templateId = process.env[templateKey] || '';

  const root = await findRootFolder(drive);
  const examFolder = await findExamFolder(drive, root.id, year, level, examType);

  const existing = await findExistingMonthForm(drive, examFolder.id, year, month, level, examType);

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
    targetFolder: { id: examFolder.id, name: examFolder.name },
    form: existing
      ? { id: existing.id, name: existing.name, editUrl, respondentUrl, published }
      : null,
  };
}

/* =========================================================================
 * 폼 생성: 템플릿 복사 → 이름 변경 → 폴더 이동
 * ========================================================================= */
async function createExamForm(year, month, level = '초급', examType = 'NAC') {
  const drive = await getDriveClient();
  const spec = getExamFormSpec(examType);
  const formType = spec.formTypeChar(month, level); // NAC: A/B/C/MID, EDR: A 고정
  const templateKey = spec.templateEnvKey(formType);
  // URL 전체를 넣었을 경우에도 ID만 추출
  const templateId = extractFormId(process.env[templateKey]);

  if (!templateId) {
    throw new Error(
      `.env의 ${templateKey} 가 설정되지 않았습니다. 템플릿 폼 ID를 입력하세요.`
    );
  }

  const root = await findRootFolder(drive);
  const examFolder = await findExamFolder(drive, root.id, year, level, examType);

  // 이미 존재하면 기존 폼 반환
  const existing = await findExistingMonthForm(drive, examFolder.id, year, month, level, examType);
  if (existing) {
    return {
      id: existing.id,
      name: existing.name,
      editUrl: `https://docs.google.com/forms/d/${existing.id}/edit`,
      respondentUrl: `https://docs.google.com/forms/d/${existing.id}/viewform`,
      alreadyExisted: true,
    };
  }

  const newName = spec.buildFormName(year, month, formType, level);

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
    addParents: examFolder.id,
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

module.exports = {
  getExamFormStatus,
  createExamForm,
  publishExamForm,
  deleteExamForm,
  // 채점 모듈(formsGrading)도 같은 파일명 규칙으로 폼을 찾아야 해서 함께 노출한다
  EXAM_FORM_SPECS,
  getExamFormSpec,
};
