# Contributing to OpenAdmin

Thanks for helping. OpenAdmin is a small, dependency-free Node.js project; the fastest way to
contribute is to reproduce a bug, add a test and keep the change focused.

## Requirements

- Node.js 22.5 or newer (for <code>node:sqlite</code>)
- No package manager step: there are no npm dependencies

## Run the tests

    node --test tests/

The suite covers authentication, quotas, the API, page rendering, backups, DNS, mail and
webmail. Add a test for every behavioural fix.

## Run the panel locally

    OA_DEMO=1 node src/server.mjs

Open <http://127.0.0.1:2222>. The demo accounts are <code>demouser</code>,
<code>demoreseller</code> and <code>demoadmin</code>, all with password <code>demo</code>.

## Code style

- ES modules, two-space indentation, semicolons.
- Prefer Node.js built-ins; a new dependency needs a strong reason.
- Keep the provider boundary: privileged system work belongs in <code>src/providers/</code>.
- Use the existing UI components and design tokens instead of one-off markup.
- Never log passwords, session tokens, private keys or full message bodies.

## Pull requests

1. Describe the user-visible problem and the fix.
2. Include tests and mention how you ran them.
3. Keep unrelated refactors out of the same pull request.
4. Update the relevant document in <code>docs/</code> when behaviour changes.

## Security

Do not open a public issue for an unpatched vulnerability. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the project's
AGPL-3.0-or-later licence.
