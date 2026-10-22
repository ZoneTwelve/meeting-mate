# Meeting Mate working agreements

- Use `pnpm`. Keep recording, transcription, and repository tracking local; do not add a cloud service or Playwright dependency without an explicit request.
- The authorized publishing target is the **public** GitHub repository `ZoneTwelve/meeting-mate`. Public visibility is intentional. Verify the actual `origin` target before publishing; never overwrite an unrelated remote, force-push, or change global Git settings.
- After a requested feature is genuinely complete, run its relevant `pnpm` tests and `pnpm run check`, review the results, then commit and push that completed feature to the authorized origin. A timer or a dirty worktree is not evidence that a feature is complete.
- Before staging, inspect existing staged/unstaged changes. Stage only audited, explicitly selected files or hunks belonging to the completed feature. Never sweep unfinished or unrelated work into a commit. Delegated agents hand their scoped changes to the integrating agent; that agent owns the final audit and publication.
- Before every commit and push, inspect the staged file list and diff for credentials, tokens, private keys, `.env` values, actual meeting links/codes, participant data, recordings, transcripts, browser profiles/cookies, downloaded models, logs, and other generated/private artifacts. Audit the initial commit especially carefully. `.gitignore` is a safeguard, not a substitute for reviewing tracked/staged content. Keep local `config.json` private; examples must use placeholders or clearly fictitious test data.
- Do not print secrets while auditing. If authentication, tests, ownership, or privacy checks block publication, report the exact blocker and leave the changes local. Never claim an unverified push succeeded.
- `scripts/repo-watch.mjs` is a read-only periodic Git observer. It may write bounded metadata under ignored `.meeting-mate/`, but it must never stage, commit, push, fetch, run tests, or decide a feature is complete. Installation is a separate explicit step after review; it must not modify or restart the recorder LaunchAgent.
- Preserve the authorized native recorder app and its signature. Do not rebuild/re-sign it or interrupt an active meeting as part of unrelated repository work.
- Document verification honestly: distinguish unit/mock tests, synthetic native recording tests, and real Meet tests. Do not claim transcript speaker labels identify real people without an explicit identity-mapping source.

See [repository operations](docs/repository.md) for watcher commands and publication boundaries.
