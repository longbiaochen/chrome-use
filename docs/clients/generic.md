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

Both installed skills resolve startup URL with:

- explicit user URL
- `CHROME_USE_DEFAULT_WEBAPP_URL`
- `about:blank`

The install exposes only:

- `chrome-inspect`
- `chrome-auth`

`/chrome` and `/inspect` are not installed as commands.
