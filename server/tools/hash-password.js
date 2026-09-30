/* =========================================================================
 * ADMIN_PASSWORD_HASH 생성기
 * -------------------------------------------------------------------------
 * 사용법:
 *   cd server
 *   node tools/hash-password.js
 *
 * 비밀번호를 입력하면 bcrypt 해시를 출력한다. 그 값을 .env와 Railway의
 * ADMIN_PASSWORD_HASH 에 넣으면 된다.
 *
 * 비밀번호를 명령행 인자로 받지 않는다. 인자로 주면 셸 히스토리와 프로세스
 * 목록에 그대로 남는다.
 * ========================================================================= */
const readline = require('readline');
const bcrypt = require('bcryptjs');

const ROUNDS = 12;   // 2026년 기준 무난한 강도. 올릴수록 로그인이 느려진다.
const MIN_LENGTH = 10;

function fail(message) {
  console.error(message);
  process.exit(1);
}

/* 사람이 직접 입력하는 경우.
 * 질문 두 개가 하나의 인터페이스를 공유한다 - 질문마다 새로 만들면 첫 인터페이스가
 * 입력 버퍼를 다 가져가서 두 번째 질문이 응답을 받지 못한다. */
function askInteractive() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let muted = false;
  rl._writeToOutput = (str) => { if (!muted) rl.output.write(str); };

  const ask = (question) => new Promise((resolve) => {
    rl.question(question, (answer) => {
      muted = false;
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true; // 프롬프트가 찍힌 뒤에 가려야 질문 자체는 보인다
  });

  return (async () => {
    const password = await ask('새 비밀번호: ');
    const again = await ask('한 번 더 입력: ');
    rl.close();
    return [password, again];
  })();
}

/* 파이프로 넘어오는 경우(`printf 'pw\npw\n' | node tools/hash-password.js`).
 * 스트림이 첫 줄을 읽는 순간 닫혀버려서 질문을 두 번 던질 수 없다.
 * 통째로 받아서 줄로 나눈다. 한 줄만 주면 확인 입력은 생략한다. */
function readPiped() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => {
      const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
      resolve(lines.length >= 2 ? [lines[0], lines[1]] : [lines[0] || '', lines[0] || '']);
    });
  });
}

(async () => {
  const [password, again] = process.stdin.isTTY ? await askInteractive() : await readPiped();

  if (!password) fail('비밀번호가 비어 있습니다.');
  if (password.length < MIN_LENGTH) {
    fail(`비밀번호가 ${password.length}자입니다. ${MIN_LENGTH}자 이상으로 해주세요.`);
  }
  if (password !== again) fail('두 입력이 다릅니다.');

  const hash = await bcrypt.hash(password, ROUNDS);
  console.log('아래 값을 .env 와 Railway 환경변수에 넣어주세요.\n');
  console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
})();
