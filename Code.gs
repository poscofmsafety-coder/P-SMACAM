/**
 * POSCO Future M 스마트 안전지킴이
 * Gmail의 D-안전회의 메일을 Cloudflare Worker TBM API로 전달합니다.
 *
 * Script Properties에 다음 값을 등록하세요.
 * WORKER_URL       https://<worker-name>.<subdomain>.workers.dev
 * TBM_TOKEN        Cloudflare Secret TBM_INBOUND_TOKEN과 같은 값
 * MANAGER_EMAIL    요약/의견 수신 담당자 이메일
 * SOURCE_LABEL     기본값 D-SAFETY
 * PROCESSED_LABEL  기본값 SSG-TBM-PROCESSED
 * WORK_DATE_OFFSET_DAYS 기본값 1
 */

function syncTbmEmails() {
  const props = PropertiesService.getScriptProperties();
  const workerUrl = requiredProperty_(props, 'WORKER_URL').replace(/\/$/, '');
  const token = requiredProperty_(props, 'TBM_TOKEN');
  const managerEmail = props.getProperty('MANAGER_EMAIL') || '';
  const sourceLabelName = props.getProperty('SOURCE_LABEL') || 'D-SAFETY';
  const processedLabelName = props.getProperty('PROCESSED_LABEL') || 'SSG-TBM-PROCESSED';
  const offsetDays = Number(props.getProperty('WORK_DATE_OFFSET_DAYS') || '1');

  const sourceLabel = GmailApp.getUserLabelByName(sourceLabelName);
  if (!sourceLabel) throw new Error(`Gmail 라벨 '${sourceLabelName}'을 먼저 만들어주세요.`);
  const processedLabel = GmailApp.getUserLabelByName(processedLabelName) || GmailApp.createLabel(processedLabelName);

  const query = `label:${quoteLabel_(sourceLabelName)} -label:${quoteLabel_(processedLabelName)} newer_than:14d`;
  const threads = GmailApp.search(query, 0, 30);

  threads.forEach((thread) => {
    const messages = thread.getMessages();
    const message = messages[messages.length - 1];
    const workDate = new Date(message.getDate().getTime() + offsetDays * 24 * 60 * 60 * 1000);
    const payload = {
      subject: message.getSubject() || 'D-안전회의',
      workDate: Utilities.formatDate(workDate, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      sourceEmail: message.getFrom() || '',
      managerEmail,
      emailBody: message.getPlainBody() || stripHtml_(message.getBody()),
      sendEmail: true,
    };

    const response = UrlFetchApp.fetch(`${workerUrl}/api/tbm/inbound-email`, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-tbm-token': token },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    const status = response.getResponseCode();
    if (status >= 200 && status < 300) {
      thread.addLabel(processedLabel);
      console.log(`TBM 전송 성공: ${payload.subject}`);
    } else {
      console.error(`TBM 전송 실패 ${status}: ${response.getContentText()}`);
    }
  });
}

function installTbmTrigger() {
  ScriptApp.getProjectTriggers()
    .filter((trigger) => trigger.getHandlerFunction() === 'syncTbmEmails')
    .forEach((trigger) => ScriptApp.deleteTrigger(trigger));

  ScriptApp.newTrigger('syncTbmEmails')
    .timeBased()
    .everyMinutes(10)
    .create();
}

function requiredProperty_(props, key) {
  const value = props.getProperty(key);
  if (!value) throw new Error(`Script Property '${key}'가 없습니다.`);
  return value;
}

function quoteLabel_(value) {
  return value.includes(' ') ? `"${value.replace(/"/g, '\\"')}"` : value;
}

function stripHtml_(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
