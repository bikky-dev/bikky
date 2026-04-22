/**
 * Postinstall hook — runs after `npm install -g bikky`.
 *
 * Writes MCP configs for Copilot / Claude Code and starts the daemon.
 * All errors are swallowed — install must never fail due to post-setup.
 */

async function postinstall(): Promise<void> {
  // Only run for global installs (not when building from source)
  if (!process.env.npm_config_global && !process.env.PREFIX) {
    return;
  }

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
