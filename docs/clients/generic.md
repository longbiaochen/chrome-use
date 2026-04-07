# Generic `.agents/skills` install

Preferred neutral install target:

```bash
bash install/install-agent-skill.sh
```

This creates symlinks at:

- `~/.agents/skills/chrome-inspect`
- `~/.agents/skills/chrome-auth`

Override the target root if your client uses a different neutral skill directory:

```bash
AGENT_SKILLS_ROOT="$HOME/.agents/skills" bash install/install-agent-skill.sh
```

Environment defaults:

```bash
export CHROME_USE_PROFILE_DIR="$HOME/.chrome-use/agent-profile"
export CHROME_USE_DEBUG_PORT="9223"
```

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
