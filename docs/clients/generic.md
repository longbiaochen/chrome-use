# Generic `.agents/skills` install

`chrome-use` gives generic skill-compatible agents a fast browser handoff path: the user clicks the live page once, the agent keeps waiting, and the returned payload contains durable structured context instead of a screenshot-only or copy-paste explanation flow.

Preferred neutral install target:

```bash
bash install/install.sh --target generic
```

This materializes copied skill directories at:

- `~/.agents/skills/chrome-inspect`
- `~/.agents/skills/chrome-auth`

The managed shared runtime and public skill payloads are installed under:

- `~/.chrome-use/runtime/chrome-use`
- `~/.chrome-use/skills/chrome-inspect`
- `~/.chrome-use/skills/chrome-auth`

Override the target root if your client uses a different neutral skill directory:

```bash
AGENT_SKILLS_ROOT="$HOME/.agents/skills" bash install/install.sh --target generic
```

Environment defaults:

```bash
export CHROME_USE_BROWSER_KIND="cft"
export CHROME_USE_CFT_CHANNEL="stable"
export CHROME_USE_PROFILE_DIR="$HOME/.chrome-use/browser-data/stable"
export CHROME_USE_DEBUG_PORT="9223"
```

Managed `Chrome for Testing` on `127.0.0.1:9223` is the supported public runtime for `chrome-use` skills.
Every public inspect/auth attach now runs a strict preflight first:

- if the canonical managed browser runtime is already healthy, continue immediately
- otherwise auto-repair by launching/reusing the canonical Chrome for Testing owner process on port `9223`
- re-run ownership checks and block hard if the endpoint is still owned by the wrong runtime, wrong port, or multiple owner processes

`chrome-auth` resolves startup URL with:

- explicit user URL
- `CHROME_USE_DEFAULT_WEBAPP_URL`
- `about:blank`

`chrome-inspect` resolves startup URL with:

- explicit user URL
- `CHROME_INSPECT_PROJECT_ROOT` docs webapp entry
- inferred current-repo docs webapp entry when inspect auto-start is enabled and the working directory or git root looks like a local project
- `CHROME_USE_DEFAULT_WEBAPP_URL`
- `about:blank`

The install exposes only these public skills:

- `chrome-inspect`
- `chrome-auth`

Both public skills may trigger explicitly or implicitly. `/chrome` and `/inspect` are not installed as commands.

For manual login-state preparation, use the bootstrap wrapper:

```bash
~/.chrome-use/bin/chrome-use-open-google-chrome
```
