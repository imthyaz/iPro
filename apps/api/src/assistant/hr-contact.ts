/**
 * Where "I don't know" sends people (decision #90): by default a Teams chat with the HR people of
 * the asker's company, opened with their question typed in, so HR answers in Teams. HR can set a
 * fixed link instead (the hr_contact setting: an HR channel, a mailbox or a page).
 */
export const TEAMS_HR = 'teams:hr';

const TOPIC = 'Ask iPro: policy question';

/** A Teams deep link that opens a chat with these people, the question ready to send. */
export function teamsChatLink(emails: string[], question: string): string {
  const users = emails.map((e) => encodeURIComponent(e.trim())).join(',');
  const message = encodeURIComponent(
    `Ask iPro couldn't answer this from our policies: ${question}`.slice(0, 500),
  );
  return `https://teams.microsoft.com/l/chat/0/0?users=${users}&topicName=${encodeURIComponent(TOPIC)}&message=${message}`;
}
