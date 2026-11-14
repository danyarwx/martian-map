# Prompts for running the helmet build in a loop

Two prompts: one for the **orchestrator** (the session that hands out work), one for each **worker**
agent or subagent. Both work from `docs/helmet/PLAN.md` (the spec) and `docs/helmet/STATUS.md` (the board).

How to run it with Claude Code:
- **One session, self-paced:** open the repo on branch `feat/helmet-3d` and run
  `/loop` followed by the orchestrator prompt below (no interval, so it paces itself).
- **With subagents:** the orchestrator starts up to 3 worker subagents at a time, each in its own git
  worktree (`isolation: "worktree"`), on tasks from **different lanes** with no shared files.
- **With ECC:** `/ecc:loop-start` (sequential pattern) with the orchestrator prompt as the task. Keep
  ECC hooks off (SETUP.md).

---

## Orchestrator prompt

```
You are the orchestrator for the Martian Map helmet build. Work on branch feat/helmet-3d.

Every iteration:
1. git fetch origin && git merge --ff-only origin/feat/helmet-3d (never rebase, never force-push).
2. Read docs/helmet/PLAN.md (all of it on the first iteration; §0, §2 and the tasks you hand out after
   that) and docs/helmet/STATUS.md.
3. If "Questions for the human" has an open question that blocks everything left, stop and report it.
4. Pick the ready tasks: status [ ] and every dependency [x]. Prefer the lowest milestone, then the
   critical path T0 → T1.1 → T2.1 → T2.4 → T3.5 → T4.2 → T5.0 → T5.3.
5. Start at most 3 worker subagents in parallel, each in its own worktree, each on ONE ready task from a
   DIFFERENT lane whose file lists do not overlap. Give each the worker prompt below with its task id.
   M0 tasks run one at a time, in order.
6. When a worker finishes: check its branch builds (npm run build && npm test) and only touches the files
   its task lists. Merge it into feat/helmet-3d with a merge commit "helmet: merge <task id>", push,
   and make sure STATUS.md shows [x] with the commit. If it failed, mark [!] with the reason and the
   next step; retry once with that reason in the prompt, then leave it for the human.
7. Every 5 merged tasks: merge origin/main into feat/helmet-3d (merge commit), run build + tests, fix or
   report conflicts, and note "Last sync" in STATUS.md.
8. After M2 and after M4: run node scripts/eval_helmet.cjs (once T4.4 exists) and take one Playwright
   screenshot of #helmet at 1280x720, look at it, and add the metrics row to STATUS.md.

Stop when: every non-stretch task is [x] or [!]; or a blocker needs the human; or the time box in
PLAN.md §2.13 is used up (then apply the cut order and finish M5's T7.2–T7.3 with what exists).
At the end, report: what is done, the eval numbers, open questions, and the preview URL.
Never merge into main. Never add dependencies or network hosts. Never edit PLAN.md §2.
```

---

## Worker prompt (one per task)

```
You implement ONE task of the Martian Map helmet build: <TASK ID>.

1. Read docs/helmet/PLAN.md §0 (rules), §2 (decisions), §3 (existing code), §4 (architecture and
   contracts) and the section of your task. Read docs/helmet/STATUS.md.
2. Set your task to [~] <your name> <time> in STATUS.md (only your line).
3. Read the existing code you depend on before writing anything: src/helmet/contracts.ts,
   src/helmet/frames.ts, and the files your task names. Follow the code style you find (comments that
   say why, small pure functions, typed arrays for pixel data, no new dependencies).
4. Implement exactly the task. Touch only the files it lists. If you must change contracts.ts or a file
   outside the list, stop and write the reason under "Questions for the human" instead.
5. Write the tests the task asks for, next to the module (*.test.ts, node:test, node:assert/strict).
   Pure algorithm code must be testable in Node without a browser.
6. Validate: npm run build && npm test, plus the task's own "done when" check. For anything visual,
   start `npx vite --port 5173`, take ONE Playwright screenshot of the relevant hash
   (#helmet / #helmet-eval) and look at it. Remember the CV must never import world/, sim/ or eval/.
7. Commit on your branch: "helmet: <TASK ID> <short title>" with the attribution lines from your
   environment, and push.
8. Update STATUS.md: [x] <commit> on your line, one Log line (date, task, you, commit, one-sentence
   note, any numbers measured). If you could not finish: [!] with what blocks and what you tried.
9. Reply with: files changed, test results, what you checked visually, anything the orchestrator
   or the human must know.
```

---

## Reviews owed to teammates

- **T4.3** changes `src/lib/` (Dev 2's planner): add a STATUS note tagging Dev 2 and keep existing
  tests untouched.
- **T5.4** adds props to `src/map/MarsMap.tsx` (Dev 1): new optional props only, no behaviour change
  when they are absent.
