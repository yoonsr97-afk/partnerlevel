const path = require('path');
const nodemailer = require('nodemailer');

const MAIL_USER = process.env.MAIL_USER;
const MAIL_APP_PASSWORD = process.env.MAIL_APP_PASSWORD;
const SENDER_NAME = '지니언스 솔루션기술센터';

const BANNER_IMAGE_PATH = path.join(__dirname, 'templates', '배너.png');
const BOTTOM_IMAGE_PATH = path.join(__dirname, 'templates', '아래.png');

function getTransporter() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: { user: MAIL_USER, pass: MAIL_APP_PASSWORD },
    connectionTimeout: 10000,  // 연결 타임아웃 10초
    greetingTimeout: 10000,
    socketTimeout: 30000,
  });
}

// 시험 발송 메일 제목/본문을 시험 종류(NAC/EDR)·평가 수준(초급/중급)에 맞춰 생성한다.
// formUrl 이 있으면 "평가시작" 버튼을 실제 링크로, 없으면 준비 중 문구로 표시한다.
function buildExamEmail(examType, level, formUrl) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');

  const subject = `${year}년 ${month}월 Genian ${examType} ${level} 파트너 정기평가`;

  const startButton = formUrl
    ? `<a href="${formUrl}" target="_blank" style="display:inline-block; padding:12px 32px; background-color:#024ad8; color:#ffffff; font-weight:700; border-radius:4px; text-decoration:none;">평가시작</a>`
    : `<span style="display:inline-block; padding:12px 32px; background-color:#999; color:#ffffff; font-weight:700; border-radius:4px;">(평가 링크 준비 중)</span>`;

  const html = `
    <div style="font-family: 'Malgun Gothic', Arial, sans-serif; color:#1a1a1a; font-size:15px; line-height:1.7; max-width:600px; margin:0 auto;">
      <img src="cid:banner" alt="배너" style="width:100%; display:block; margin-bottom:24px;">

      <p>안녕하세요.<br>${SENDER_NAME} 입니다.</p>

      <p>${year}년 ${month}월 Genian ${examType} ${level} 파트너 정기 평가 평가지 송부드립니다.</p>

      <p>평가 진행 간 <strong>부정행위 적발시 평가 불합격 및 해당 파트너사에 통보</strong>가 되니 참고하여 주시기 바랍니다.</p>

      <p>평가 시간은 <strong>15:00 ~ 17:00</strong> 까지 입니다.<br>
      평가 제출은 1회만 가능하니 필히 검토 후 제출 바랍니다.</p>

      <p>제출 하신 분은 퇴장하셔도 무관합니다.</p>

      <div style="text-align:center; margin: 32px 0;">
        ${startButton}
      </div>

      <img src="cid:bottom" alt="안내" style="width:100%; display:block; margin-top:24px;">
    </div>
  `;

  const attachments = [
    { filename: '배너.png', path: BANNER_IMAGE_PATH, cid: 'banner' },
    { filename: '아래.png', path: BOTTOM_IMAGE_PATH, cid: 'bottom' },
  ];

  return { subject, html, attachments };
}

// recipients: [{ name, email }, ...] - 한 명씩 개별 발송(다른 수신자 이메일이 노출되지 않도록)
async function sendExamEmails(examType, recipients, { level = '초급', formUrl = '' } = {}) {
  const transporter = getTransporter();
  const { subject, html, attachments } = buildExamEmail(examType, level, formUrl);

  let sent = 0;
  const failed = [];

  for (const recipient of recipients) {
    try {
      await transporter.sendMail({
        from: `"${SENDER_NAME}" <${MAIL_USER}>`,
        to: recipient.email,
        subject,
        html,
        attachments,
      });
      sent += 1;
    } catch (err) {
      failed.push({ email: recipient.email, error: err.message });
    }
  }

  return { sent, failed };
}

module.exports = { sendExamEmails };
