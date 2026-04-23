/**
 * Postinstall hook — runs after `npm install bikky`.
 *
 * Writes MCP configs for Copilot / Claude Code and starts the daemon.
 * All errors are swallowed — install must never fail due to post-setup.
 */

async function postinstall(): Promise<void> {
  try {
    const { startAll } = await import("./lifecycle.js");
    await startAll();
  } catch {
    // Silent — don't break npm install
  }
}

postinstall().catch(() => {
  // swallow
});
