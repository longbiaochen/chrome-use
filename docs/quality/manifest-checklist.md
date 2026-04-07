# chrome-use public skill manifest checklist

Use this checklist after refactors that affect public skill registrations or runtime packaging.

1. Run:

```bash
bash scripts/verify-manifest.sh
```

2. Confirm checks passed:

- only two installable public skill directories are installed (`chrome-inspect`, `chrome-auth`)
- both public skills declare implicit-capable Codex metadata
- no public `chrome-use` skill is installed or packaged
- `/chrome` and `/inspect` are not registered as standalone command selectors
- startup URL resolution follows:
  - explicit user URL
  - project docs webapp entry from `CHROME_INSPECT_PROJECT_ROOT`
  - inferred project docs webapp entry from the current working directory or git root when inspect auto-start is enabled
  - `CHROME_USE_DEFAULT_WEBAPP_URL`
  - `about:blank`
- `chrome-inspect` and `chrome-auth` wrapper scripts resolve into the shared `runtime/chrome-use/scripts/` helpers
- `open_url.sh` returns the debug URL on stdout after ensuring the local project web app is running when auto-start is enabled
- when the expected preview port is already listening but the target URL is not reachable, startup fails fast with the listener details instead of launching a second server

3. Confirm packaging docs list only the public skills:

- `chrome-inspect`
- `chrome-auth`

4. Confirm no `/chrome` mention as a public command selector remains in installable command metadata.
