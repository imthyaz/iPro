import { describe, expect, it } from 'vitest';
import { teamsChatLink } from './hr-contact.js';

describe('the Teams chat with HR (decision #90)', () => {
  it('opens a chat with each HR person, the question ready to send', () => {
    const link = teamsChatLink(['hr1@example.test', 'hr2@example.test'], 'Can I bring my dog?');
    const url = new URL(link);
    expect(`${url.origin}${url.pathname}`).toBe('https://teams.microsoft.com/l/chat/0/0');
    expect(url.searchParams.get('users')).toBe('hr1@example.test,hr2@example.test');
    expect(url.searchParams.get('topicName')).toBe('Ask iPro: policy question');
    expect(url.searchParams.get('message')).toBe(
      "Ask iPro couldn't answer this from our policies: Can I bring my dog?",
    );
  });

  it('keeps the question short and the link well formed', () => {
    const url = new URL(teamsChatLink(['hr@example.test'], 'x&users=evil@example.test'.repeat(60)));
    expect(url.searchParams.get('users')).toBe('hr@example.test');
    expect(url.searchParams.get('message')!.length).toBeLessThanOrEqual(500);
  });
});
