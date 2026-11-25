# Accessibility checks (WCAG 2.1 AA)

Slice 14 done-when #3, decision #97. Employee and manager screens must meet WCAG 2.1 AA.

## Automated (every e2e run)

`apps/web/e2e/accessibility.spec.ts` runs axe-core with the WCAG 2.0/2.1 A and AA rules on:

- Action inbox (employee and manager), My attendance, My leave, the Apply leave form, Plan my week,
  My journey, My requests, Notifications, Policies, the Ask iPro panel;
- Team today, Team calendar, Team journeys.

Each runs on desktop and phone, in light and dark. Any violation fails the build.

Automated rules find roughly half of WCAG problems. The rest needs a person, before go-live and after
any big screen change.

## Manual checklist (before go-live; then each release that changes these screens)

Do each task on a phone with the screen reader on, and on a laptop with the keyboard only: check in,
apply leave, plan a week, approve a request from the inbox, read your journey.

**Keyboard (laptop, no mouse)**

- [ ] Every control can be reached with Tab, in reading order, and used with Enter or Space.
- [ ] Focus is always visible.
- [ ] Opening a side panel or the Ask iPro panel moves focus into it, and closing it returns focus.
- [ ] Nothing traps focus; Escape closes panels.
- [ ] The swipe-to-approve has a button alternative (Approve).

**Screen reader (TalkBack on Android, VoiceOver on iPhone, NVDA on Windows)**

- [ ] Each page announces its heading; landmarks (header, navigation, main) are announced.
- [ ] Buttons say what they do, e.g. "Casual leave: 4.5 days left", "9 Nov 2026: Present".
- [ ] Results of actions (checked in, sent for approval, undo) are announced without moving focus.
- [ ] Form errors are announced and say how to fix them.
- [ ] Charts and timelines have a text equivalent (the event list, the "why" of each number).

**Seeing**

- [ ] At 200% zoom and at 320 px wide nothing is cut off and the page doesn't scroll sideways (the
      calendar and timeline scroll inside their own box).
- [ ] Status is never shown by colour alone (chips carry words).
- [ ] With "reduce motion" on, nothing animates beyond a fade.

**Touch**

- [ ] Tap targets are at least 44 × 44 px on the phone screens.

Record the date, device, screen reader and findings in the release notes; fix anything that fails
before go-live.
