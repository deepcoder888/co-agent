# AGENTS.md

Rules for anyone, human or coding agent, changing CO-AGENT. Each rule says why, in one clause.

## Code

- Runtime code uses only the Node.js 24 standard library; the only dev dependencies are `electron` and `@electron/packager`, pinned in `package.json`. Add nothing else: the app must build and run offline.
- Child processes use argv arrays with `shell: false`; user text reaches a CLI only through a spec file or stdin, never the command line.
- The local server listens on `127.0.0.1` only and checks the Host header, the per-start token on every POST/PUT/DELETE, and the Origin header; keep all three on any new route.
- Runtime data goes only to the data dir (`CO_AGENT_DATA_DIR`, default `%LOCALAPPDATA%\CO-AGENT`). The only writes outside it are the configured copy folders (`concept.thinkDir`, `seminar.thinkDir`), the backup ZIP (`backup.dir`, never overwriting), symlinks for accepted book agents under `<launchProject>\.claude\agents`, and imported agent files (only with `allowAgentImport`, only new files).
- `~/.codex` and `~/.claude` are otherwise read-only: the app reads agent definitions and session logs there.
- The agent lists in `catalogDir` are read-only for the app; what is listed in the app goes to `catalog-additions.json` and `book-additions.json` in the data dir.
- In-app chats run without anyone to approve a tool: Claude gets read-only tools with `--permission-mode dontAsk`, Codex runs `exec -s read-only`. Do not widen this.
- No personal paths, models or names in the code: user values belong in the user's `config.json`.

## Front end

- The CSP is `style-src 'self'`, so `style` attributes are dropped: set dynamic styles through CSSOM (`element.style.setProperty`).
- Build text with `textContent`, never `innerHTML` with data from the server.
- Four layouts (`threepane`, `bento`, `editorial`, `shelf`) each own `public/layouts/<id>.js` and `.css`; text on dialog backgrounds uses the layout's `--text` and `--muted`, so it stays readable in the dark 书房 layout.

## Tests

- `npm test` (`node --test`) must pass before any change is accepted. Tests never launch the real `claude` or `codex`, and never write outside temporary folders.
- `test/fixtures/helpers.mjs` builds a configured install over temporary folders and the sample catalog in `test/fixtures/catalog/`.
- Stop any dev server on the test port before running the suite.
- A test that shortens a timeout must restore it.
