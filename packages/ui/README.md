# bikky-ui

Local web UI for browsing and managing [bikky](https://github.com/bikky-dev/bikky) memory.

```bash
npx bikky-ui
```

The UI reads the same `~/.bikky/config.json` as the `bikky` CLI and opens a local dashboard at <http://localhost:1422>.

The Memory dashboard, list, and search views default to current user-facing memories. Internal telemetry, system lifecycle summaries, entity sidecars, and superseded archive records stay available for diagnostics but are hidden from the main views by default.

Memory cards and detail pages show provenance when it is available: configured user, origin surface/operation, agent, last operation, repo, branch, workstream, task, session, and episode. Older records still fall back to legacy `source`, `actor_id`, and actor-label metadata.

## Development checks

```bash
npm test
npm run build
npm run test:e2e
```

`npm run test:e2e` runs the Playwright browser regression suite against mocked API responses, including Memory filter coverage.

For setup, configuration, and security details, see the main bikky repository:

- [README](https://github.com/bikky-dev/bikky#readme)
- [Configuration guide](https://github.com/bikky-dev/bikky/blob/main/docs/configuration.md)
- [Security policy](https://github.com/bikky-dev/bikky/blob/main/SECURITY.md)

For maintainer contact, reach Saber Zrelli on GitHub: [@zrelli-s](https://github.com/zrelli-s).
