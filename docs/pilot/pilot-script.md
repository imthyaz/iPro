# Pilot script: first use without help

Slice 14 done-when #2; decision #99. Five pilot users each complete check-in, a leave application and
week planning **without help, on first use**. This page is the script for whoever runs the sessions.

## Who

Five Ideassion people who have never seen iPro, chosen to cover:

- two employees who mostly work from the office;
- one who mostly works from home;
- one who joined in the last three months;
- one manager. The manager does the employee tasks, then approves the other pilots' leave.

At least two should use Android and at least one an iPhone. At least one should use iPro on a laptop.

## Setup (before each session)

- **Accounts:** staging, with a test account for the participant in a seeded synthetic team. The
  participant uses the test account, not their real record. No real personal data is entered.
- **Device:** their own phone, signed in to staging, on mobile data where possible.
- **Briefing:** nothing about iPro beyond the one line below. No demo, no training, no help text sent
  in advance.
- **Notes:** a sheet per participant (below) and a timer.

## The session (about 20 minutes)

Say only this:

> "We're testing iPro, not you. Please do each task as you normally would, and think aloud as you go.
> I can't help or answer questions until the end. If you would give up, say so, and we'll move on."

Then give each task on a card, one at a time:

1. **Check in.** "You've just arrived at work. Record that you're here." For the WFH participant:
   "You're starting work from home today."
2. **Apply for leave.** "You want two days of casual leave on <two working days next week>. Ask for it."
3. **Plan your week.** "Plan next week: which days you'll be in the office and which from home."
4. **Manager only:** "Approve the leave requests waiting for you."

## What counts as help

Each of these marks the task "needed help":

- the observer answers a question or points at the screen;
- the participant gives up;
- the participant is stuck for 2 minutes;
- the participant can't tell whether the task worked.

A wrong first tap that the participant recovers from on their own is **not** help. Record it as a
stumble.

## Record per task

| Task | Done without help? | Time (s) | Taps | Stumbles (where, what they expected) | Said aloud |
| --- | --- | --- | --- | --- | --- |
| Check in | | | | | |
| Apply leave | | | | | |
| Plan week | | | | | |
| Approve (manager) | | | | | |

Design targets (CLAUDE.md) to compare against: check-in in **1 tap**, leave in **3 taps or fewer**,
approve in **1 tap or swipe**. Also note whether they saw the result: "Checked in at …", the request
in My leave, the planned week.

Afterwards, ask for each task: "How easy or hard was that, from 1 (very hard) to 7 (very easy)?" Then:
"What, if anything, surprised you?"

## Passing and fixing

- **Pass:** all five complete all three tasks without help (the manager also approves without help).
- **For each stumble or "needed help":** log it with the screen, what the participant expected and a
  severity:
  - **blocker:** they couldn't finish;
  - **major:** finished, but slow or unsure;
  - **minor:** cosmetic.
- **If anyone needed help:** fix the blockers and majors, then repeat that task with a **new**
  participant. The same person has now seen it.
- **Record the result** in the release notes: the date, who took part (role and device, no names in
  the repository), task results and the fixes made.
