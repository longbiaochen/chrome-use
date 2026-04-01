# Claude-compatible install notes

The neutral path is still the recommended one:

```bash
bash install/install-agent-skill.sh
```

Many Claude-compatible setups also recognize `.claude/skills/`, but that is a client convenience path, not the canonical packaging target for this repo.

If you need a client-native layout, copy or symlink:

- `chrome-inspect/`
- `chrome-auth/`

into that client's skill directory.
