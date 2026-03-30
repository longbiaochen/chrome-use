# Codex adapter notes

Codex supports the same `SKILL.md` payload as the generic install, plus optional metadata in `chrome-use/agents/openai.yaml`.

Install options:

```bash
bash install/install-agent-skill.sh
```

or:

```bash
bash install/install-codex-skill.sh
```

If you want Codex to use the same dedicated profile path as an existing local setup:

```bash
export CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-mcp-profile"
```

Typical Codex MCP wrapper command:

```bash
CHROME_USE_PROFILE_DIR="$HOME/.codex/chrome-mcp-profile" \
  bash chrome-use/scripts/chrome_devtools_mcp_wrapper.sh
```
