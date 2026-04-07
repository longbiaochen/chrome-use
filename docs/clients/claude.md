# Claude-compatible install notes

The same product positioning applies here: `chrome-inspect` is the inspect-first workflow for live page selection handoff, and `chrome-auth` keeps the dedicated session stable so users do not have to keep redoing login or re-explaining page context.

The neutral path is still the recommended one:

```bash
bash install/install-agent-skill.sh
```

Many Claude-compatible setups also recognize `.claude/skills/`, but that is a client convenience path, not the canonical packaging target for this repo.

If you need a client-native layout, copy or symlink:

- `skills/chrome-inspect/`
- `skills/chrome-auth/`

into that client's skill directory.
