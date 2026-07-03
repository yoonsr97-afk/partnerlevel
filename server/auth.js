require('dotenv').config();
const path = require('path');
const { JWT } = require('google-auth-library');
const { google } = require('googleapis');

/**
 * Google Auth 클라이언트 반환
 * - 서버 환경: SERVICE_ACCOUNT_JSON 환경변수로 JWT 인증 (최신 토큰 URL 사용)
 * - 로컬 환경: service-account.json 파일로 GoogleAuth 인증
 */
function getAuthConfig(scopes) {
  if (process.env.SERVICE_ACCOUNT_JSON) {
    const creds = JSON.parse(process.env.SERVICE_ACCOUNT_JSON);
    // JWT 클라이언트 직접 사용 - 최신 토큰 엔드포인트(oauth2.googleapis.com) 사용
    return new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes,
    });
  }

  const keyFile = process.env.SERVICE_ACCOUNT_KEY_PATH
    ? path.resolve(__dirname, process.env.SERVICE_ACCOUNT_KEY_PATH)
    : path.join(__dirname, 'service-account.json');

  return new google.auth.GoogleAuth({ keyFile, scopes });
}

module.exports = { getAuthClient: getAuthConfig };
