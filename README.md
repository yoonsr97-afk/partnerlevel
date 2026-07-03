# 파트너 평가 자동화 시스템

관리자가 파트너 대상 평가(시험)를 시행할 때, 출석체크 → 문제 폼 생성 → 시험 발송 → 응시 확인 → AI 채점 → 승인 → 합격자 확인까지의 흐름을 하나의 화면에서 처리하는 SPA 웹앱입니다.

**NAC / EDR 두 시험을 완전히 분리해서 관리합니다.** 헤더의 NAC/EDR 전환 버튼으로 보고 있는 시험을 바꿀 수 있고, 전 과정의 데이터가 서로 섞이지 않고 독립적으로 유지됩니다.

---

## 프로젝트 구조

```
index.html          화면 구조 (헤더, 탭 네비게이션, 8개 탭 패널, 모달/토스트)
style.css           전체 스타일 (Primary #024ad8)
app.js              전역 state, 탭별 렌더링 로직, 이벤트 처리, 백엔드 연동
server/
  server.js         Express 백엔드 (API 라우터, 세션 관리)
  auth.js           Google 서비스 계정 인증 헬퍼 (로컬/서버 환경 자동 분기)
  mailer.js         Gmail SMTP 메일 발송 (port 465 SSL)
  certificate.js    수료증 docx 생성 + LibreOffice headless PDF 변환
  examResults.js    평가현황 시트 읽기/쓰기
  formsGrading.js   구글 폼 응답 읽기 + 객관식 자동 채점
  examCheck.js      응시 확인 (폼 응답 매칭)
  formCreation.js   시험 폼 생성/게시/삭제
  aiGrading.js      Anthropic Claude AI 주관식 채점
  Dockerfile        Railway 배포용 (LibreOffice 포함)
  .env              환경변수 (git 제외)
  service-account.json  구글 서비스 계정 키 (git 제외)
  templates/        메일 이미지, 수료증 docx, 정답 키 JSON
```

---

## 탭별 기능 (8개)

### 1. 파트너 목록
- Google Sheets 연동 버튼으로 NAC/EDR 신청자 명단 조회 (현재 월 기준)
- 헤더의 NAC/EDR 버튼으로 시험 전환, 월 선택 드롭다운으로 조회 월 변경

### 2. 출석 체크
- `[출석]/[결석]` 토글로 출석 상태 변경 → 실제 시트 행 배경색도 함께 변경 (노랑=출석/빨강=결석)
- 실패 시 화면 자동 롤백

### 3. 문제 폼 생성
- 공유 드라이브에서 템플릿 폼을 복사해 해당 월 시험 폼 자동 생성
- 초급(A/B/C형 월별 자동 순환) / 중급 선택 가능
- 생성 → 게시 → 삭제 관리

### 4. 시험 발송
- 출석 처리된 인원에게 시험 링크 포함 이메일 발송 (개별/선택 발송)
- Gmail SMTP (port 465 SSL) 사용, 배너/푸터 이미지 인라인 첨부

### 5. 응시 확인
- 구글 폼 응답을 직접 읽어 파트너 명단과 매칭해 응시 여부 확인
- 이름 + 파트너사명 기준 매칭

### 6. AI 채점
- **객관식**: `server/templates/answer-keys/NAC_A.json` 정답 파일과 응답 비교해 자동 채점
- **주관식**: Anthropic Claude (`claude-haiku-4-5-20251001`)가 모범답안과 키워드 비교 채점 (0.5점 단위)
- 주관식 상세보기에서 문항별 AI 근거 확인 및 사람이 점수 직접 수정 가능
- 승인 완료 후에는 점수 수정 잠김

### 7. 승인 관리
- 채점 결과 검토 후 승인 처리 (승인 취소 불가)
- 승인 시 평가현황 시트에 결과 자동 기록
- 승인된 행에 시트 직접 링크 제공

### 8. 합격/불합격 확인
- 승인 완료된 인원만 표시, 총점 60점 기준 합격/불합격
- 수료증(결과 안내 PDF) 다운로드 — 회사 단위로 1개 생성 (같은 회사 응시자 전원 포함)

---

## 주요 연동 현황

| 기능 | 상태 | 비고 |
|------|------|------|
| 신청자 명단 조회 (NAC/EDR) | 완료 | Google Sheets API |
| 출석 체크 시트 반영 | 완료 | 행 배경색 변경 |
| 시험 폼 생성/게시/삭제 | 완료 | Google Forms + Drive API |
| 이메일 발송 | 완료 | Gmail SMTP 465 (Railway에서는 SMTP 차단으로 Ubuntu 서버 권장) |
| 응시 확인 | 완료 | Google Forms 응답 직접 읽기 |
| AI 채점 (객관식) | 완료 | 정답 키 JSON 필요 |
| AI 채점 (주관식) | 완료 | Anthropic Claude API |
| 승인 결과 시트 기록 (NAC) | 완료 | 평가현황 시트 |
| 승인 결과 시트 기록 (EDR) | 미연동 | `.env`에 EDR 시트 ID 추가 시 자동 활성화 |
| 수료증 PDF 생성 | 완료 | LibreOffice headless (`soffice`) |
| 중급 시험 폼 템플릿 | 미설정 | `.env`의 `TEMPLATE_FORM_ID_NAC_MID` 입력 필요 |

---

## 로그인 / 세션

- 서버 접속 시 로그인 화면 표시 (계정 정보 `.env`에서 관리)
- 비밀번호는 클라이언트에서 SHA-256 해시 후 전송 (평문 전송 없음)
- 세션 유효 시간: **30분** (갱신 버튼 또는 세션 연장 팝업으로 연장 가능)
- 세션 만료 3분 전 경고 팝업 표시, 상단 남은 시간 뱃지 표시

---

## 환경변수 (`.env`)

```env
PORT=4000

# 신청자 명단 시트
SPREADSHEET_ID_NAC=...
SHEET_NAME_NAC=설문지 응답 시트1
SPREADSHEET_ID_EDR=...
SHEET_NAME_EDR=설문지 응답 시트1

# 서비스 계정 (로컬: 파일 경로, 서버: SERVICE_ACCOUNT_JSON 환경변수 사용)
SERVICE_ACCOUNT_KEY_PATH=./service-account.json

# API 접근 키 (레거시 호환, 세션 토큰으로 대체됨)
SERVER_ACCESS_KEY=...

# 관리자 계정 (비밀번호는 SHA-256 해시)
ADMIN_USERNAME=admin
ADMIN_PASSWORD_HASH=...

# Gmail 발송 계정
MAIL_USER=...@gmail.com
MAIL_APP_PASSWORD=...

# 평가현황 시트
RESULTS_SPREADSHEET_ID_NAC=...

# Anthropic Claude AI 채점
ANTHROPIC_API_KEY=...

# 시험 폼 템플릿 ID
TEMPLATE_FORM_ID_NAC_A=...
TEMPLATE_FORM_ID_NAC_B=...
TEMPLATE_FORM_ID_NAC_C=...
TEMPLATE_FORM_ID_NAC_MID=

# 공유 드라이브 문제 자료 폴더
EXAM_FORMS_ROOT_FOLDER=80.문제자료(2020~)
EXAM_FORMS_ROOT_FOLDER_ID=...

# CORS 허용 도메인 (쉼표 구분, 미설정 시 전체 허용)
ALLOWED_ORIGINS=
```

---

## 실행 방법

### 로컬 (Windows/Mac)

```bash
cd server
npm install
npm start
```

`index.html`을 브라우저로 열면 됩니다 (백엔드가 먼저 실행 중이어야 함).

> **PDF 변환**: LibreOffice가 설치되어 있어야 합니다.  
> Windows: [libreoffice.org](https://www.libreoffice.org) 설치 후 `soffice` PATH 등록

### Ubuntu 서버

```bash
# 의존성 설치
sudo apt install -y nodejs npm libreoffice fonts-nanum fonts-nanum-extra

# 레포 클론
git clone https://github.com/yoonsr97-afk/partnerlevel.git
cd partnerlevel/server
npm install

# 환경파일 복사 (.env, service-account.json)
# scp로 로컬에서 전송

# PM2로 상시 실행
sudo npm install -g pm2
pm2 start server.js
pm2 save && pm2 startup
```

### Railway (클라우드)

- GitHub 레포 연결, Root Directory: `server`
- `Dockerfile` 자동 감지 → LibreOffice 포함 빌드
- Variables 탭에서 `.env` 내용 입력 (단, `SERVICE_ACCOUNT_JSON`에 `service-account.json` 전체 내용 붙여넣기)
- 프론트엔드: GitHub Pages (`main` 브랜치, root 디렉토리)

> **Railway SMTP 제한**: Railway에서는 SMTP 포트(587/465)가 차단되어 이메일 발송이 안 됩니다. 이메일 발송이 필요하면 Ubuntu 서버 사용을 권장합니다.

---

## 배포 현황 (태그)

| 태그 | 설명 |
|------|------|
| `v1-railway` | Railway 백엔드 + GitHub Pages 프론트 구성 기준 스냅샷 |

---

## 데이터 흐름

```
Google Sheets 연동
       ↓
파트너 목록 → 출석 체크 → 문제 폼 생성 → 시험 발송 → 응시 확인 → AI 채점 → 승인 관리 → 합격/불합격 확인
```

모든 탭은 `state.partnersByExam[state.examType]` 배열을 공유합니다.
