require('dotenv').config();
const path = require('path');

/**
 * Google Auth 설정 반환
 * - Railway 등 서버 환경: SERVICE_ACCOUNT_JSON 환경변수(JSON 문자열)로 인증
 * - 로컬 환경: service-account.json 파일로 인증
 */
function getAuthConfig(scopes) {
  if (process.env.SERVICE_ACCOUNT_JSON) {
    return {
      credentials: JSON.parse(process.env.SERVICE_ACCOUNT_JSON),
      scopes,
    };
  }
  const keyFile = process.env.SERVICE_ACCOUNT_KEY_PATH
    ? path.resolve(__dirname, process.env.SERVICE_ACCOUNT_KEY_PATH)
    : path.join(__dirname, 'service-account.json');
  return { keyFile, scopes };
}

module.exports = { getAuthConfig };
