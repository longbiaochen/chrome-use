# Generic `.agents/skills` install

Preferred neutral install target:

```bash
bash install/install-agent-skill.sh
```

This creates a symlink at `~/.agents/skills/chrome-use`.

Override the target root if your client uses a different neutral skill directory:

```bash
AGENT_SKILLS_ROOT="$HOME/.agents/skills" bash install/install-agent-skill.sh
```

Environment defaults:

```bash
export CHROME_USE_PROFILE_DIR="$HOME/.chrome-use/agent-profile"
export CHROME_USE_DEBUG_PORT="9223"
```
