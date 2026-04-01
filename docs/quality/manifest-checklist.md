# chrome-use command manifest checklist

Use this checklist after refactors that affect command registrations.

1. Run:

```bash
bash scripts/verify-manifest.sh
```

2. Confirm checks passed:

- only two installable command directories are installed (`chrome-inspect`, `chrome-auth`)
- explicit command metadata exists for both commands
- `/chrome` and `/inspect` are not registered as standalone command selectors
- startup URL resolution follows:
  - explicit user URL
  - project docs webapp entry from `CHROME_INSPECT_PROJECT_ROOT`
  - `CHROME_USE_DEFAULT_WEBAPP_URL`
  - `about:blank`
- `chrome-inspect` wrapper scripts resolve into the shared `chrome-use/scripts/` helpers
- `open_url.sh` returns the debug URL on stdout after ensuring the local project web app is running when auto-start is enabled

3. Confirm packaging docs list only:

- `/chrome-inspect`
- `/chrome-auth`

4. Confirm no `/chrome` mention as a public command selector remains in installable command metadata.
