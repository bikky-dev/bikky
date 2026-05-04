# Security Policy

Thanks for helping keep bikky and its users safe.

## Supported Versions

Security fixes land on the latest minor release of each package:

| Package    | Supported versions       |
| ---------- | ------------------------ |
| `bikky`    | latest minor (`0.4.x`)   |
| `bikky-ui` | latest minor (`0.1.x`)   |

Older versions are not patched. If you're on an old version, please upgrade before reporting a vulnerability that may already be fixed.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security reports.**

Use GitHub's private vulnerability reporting:

1. Go to https://github.com/bikky-dev/bikky/security/advisories/new
2. Fill in the details — include reproduction steps, affected versions, and impact.
3. Submit. We'll get an email and respond from there.

If you can't use GitHub for any reason, open a regular issue titled "Security contact request" (no details) and we'll arrange a private channel.

## What to Expect

| When                                | What happens                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| Within **3 business days**          | We acknowledge the report and confirm we can reproduce (or ask for more info). |
| Within **7 business days**          | We share an initial assessment: severity, affected versions, intended fix.    |
| Within **90 days** (typical)        | We ship a patched release and publish a GitHub Security Advisory with credit.  |

For critical issues actively being exploited, we'll move faster and coordinate disclosure timing with you.

## Scope

In scope:
- The `bikky` npm package (CLI, MCP server, daemon).
- The `bikky-ui` npm package (local web UI server + frontend).
- The default daemon, postinstall scripts, and any code shipped in either tarball.

Out of scope:
- Vulnerabilities in dependencies that are already tracked upstream (please report to the upstream maintainer).
- Vulnerabilities that require physical access to the user's machine or already-compromised credentials.
- Findings from automated scanners with no demonstrated impact.
- Issues in third-party services bikky integrates with (Qdrant Cloud, OpenAI, etc.) — report those to the respective vendors.

## Safe Harbor

We support good-faith security research. If you make a reasonable effort to comply with this policy, we will:
- Not pursue legal action against you for the research.
- Work with you to understand and resolve the issue quickly.
- Recognise your contribution publicly (with your permission) in the advisory and release notes.

Thank you for helping make bikky safer for everyone.
