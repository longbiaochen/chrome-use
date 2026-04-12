# Generic `.agents/skills` install

`chrome-use` gives generic skill-compatible agents a fast browser handoff path: the user clicks the live page once, the agent keeps waiting, and the returned payload contains durable structured context instead of a screenshot-only or copy-paste explanation flow.

Preferred neutral install target:

```bash
bash install/install.sh --target generic
```

This materializes copied skill directories at:

- `~/.agents/skills/chrome-inspect`
- `~/.agents/skills/chrome-auth`

The managed shared runtime is staged under:

- `~/.chrome-use/dist/runtime/chrome-use`

Override the target root if your client uses a different neutral skill directory:

```bash
AGENT_SKILLS_ROOT="$HOME/.agents/skills" bash install/install.sh --target generic
```

Environment defaults:

```bash
export CHROME_USE_PROFILE_DIR="$HOME/.chrome-use/agent-profile"
export CHROME_USE_DEBUG_PORT="9223"
```

`agent-profile` on `127.0.0.1:9223` is the only supported dedicated runtime for public `chrome-use` skills.
Every public inspect/auth attach now runs a strict preflight first:

- if the canonical dedicated runtime is already healthy, continue immediately
- otherwise auto-repair by launching/reusing the canonical `agent-profile` owner process on port `9223`
- re-run ownership checks and block hard if the endpoint is still owned by the wrong profile, wrong port, or multiple owner processes

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

For manual login-state preparation or user-created Chrome Web Apps, install the dedicated macOS launcher:

```bash
bash scripts/install-agent-profile-chrome-app.sh
```

This adds `Agent Profile Chrome`, which always opens the canonical `agent-profile` runtime so users can prepare auth state and create profile-scoped Web Apps from the same dedicated profile that agents will later inspect and manipulate.
