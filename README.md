# wikijs-ask

An AI Q&A panel for [Wiki.js](https://js.wiki) 2. A floating button on every page opens a chat that
answers from the wiki pages **the asking user is allowed to read**, cites them, and can look things up
on the web. Chats are saved per user and can be exported as Markdown.

- Answers are grounded in the wiki: the model gets the page index, searches and reads pages with tools, and links its sources
- Permissions come from Wiki.js itself: every lookup runs with the asking user's own login, so nobody gets answers from pages they cannot open
- Optional web tools: `web_search` (Exa) and `web_fetch` (via Exa, or direct with private-address blocking)
- Saved conversations per user (Postgres), history list, Markdown export
- Optional guest questions: visitors who are not logged in can ask from the pages the Wiki.js Guests group can read; nothing is saved for them to reopen, but every guest question is logged server-side (IP, user agent, tool calls, answer) with per-IP and global daily limits
- Markdown, LaTeX (KaTeX) and code highlighting in answers; streaming output
- Resizable / maximizable panel, English and Chinese UI
- Settings page for admins: API endpoint, key, model, web tools, limits, with a connection test and usage totals
- Two wire formats: Anthropic Messages (the Anthropic API, default `claude-opus-5`, or compatible ones such as z.ai) and OpenAI chat/completions (for example `glm-5.3-flash` on OpenCode Go)

It is a sidecar service, not a Wiki.js module: Wiki.js 2 has no plugin mechanism for UI or API
extensions, so nothing in Wiki.js is modified and it can be upgraded independently.

## How it fits together

```
browser ── /_ask/* ──> reverse proxy ──> wikijs-ask ──> Wiki.js GraphQL + page HTML (with the user's jwt)
        └─ everything else ─────────────> Wiki.js      ├─> model endpoint (Anthropic Messages or OpenAI chat/completions)
                                                        ├─> Exa (optional)
                                                        └─> Postgres database "ask"
```

| Coupling | How |
|---|---|
| Login | Reuses the Wiki.js `jwt` cookie; `users.profile` tells who is asking; guests get 401 unless guest questions are on |
| Permissions | Page list, search and page reads go to Wiki.js with the user's jwt (guests: no jwt, so the Guests group applies) |
| Admin | Users with `manage:system` can open `/_ask/settings` |
| UI | One `<script defer src="/_ask/widget.js"></script>` in the page head |

## Install

1. Run the service next to Wiki.js (see `examples/docker-compose.yml`). It needs its own Postgres database;
   the one Wiki.js uses can host it: `docker compose exec db createdb -U wiki ask`.
2. Route `/_ask/*` on the wiki's own domain to the service, **without compression** on that path (it would
   buffer the streamed answers). `examples/Caddyfile` shows Caddy; for nginx use `proxy_buffering off`.
3. Load the widget. Easiest: Wiki.js **Administration → Theme → Head HTML Injection**:
   ```html
   <script defer src="/_ask/widget.js"></script>
   ```
   (Wiki.js injects this on content pages; to have it on every page, inject it at the reverse proxy.)
4. Open `https://<your wiki>/_ask/settings` as a Wiki.js administrator, set the API key and model, press
   **Test connection**, save.

## Configuration

Required environment:

| Variable | |
|---|---|
| `ASK_ORIGIN` | The wiki's public origin, exactly, e.g. `https://wiki.example.org` |
| `DATABASE_URL` | or `PGHOST` / `PGUSER` / `PGDATABASE` / `PGPASSWORD` (`PGPASSWORD_FILE` for Docker secrets) |
| `WIKI_INTERNAL_URL` | How the service reaches Wiki.js, default `http://wiki:3000` |

Everything else can be set on the settings page (saved values override the environment):

| Setting | Env | Default |
|---|---|---|
| API format | `ASK_API_FORMAT` | `anthropic`; or `openai` (chat/completions) |
| API base URL | `ASK_BASE_URL` | empty = Anthropic API; for `openai` the `/v1` base, `/chat/completions` is appended |
| API key | `ASK_API_KEY` / `ANTHROPIC_API_KEY` | |
| Model | `ASK_MODEL` | `claude-opus-5` on the Anthropic API; required elsewhere |
| Session header | `ASK_SESSION_HEADER` | none; a header name that gets a stable id per conversation (OpenCode Go: `x-opencode-session`) |
| Effort | `ASK_EFFORT` | model default (Anthropic only) |
| Web search on/off, Exa key, results | `ASK_WEB_SEARCH`, `EXA_API_KEY`, `ASK_WEB_SEARCH_RESULTS` | on, –, 5 |
| Web fetch on/off, method | `ASK_WEB_FETCH`, `ASK_WEB_FETCH_VIA` | on, `exa` |
| Wiki name, extra instructions | `ASK_WIKI_NAME`, `ASK_EXTRA_INSTRUCTIONS` | `this wiki` |
| Max turns, history turns, characters per page | `ASK_MAX_TURNS`, `ASK_HISTORY_TURNS`, `ASK_PAGE_CHAR_CAP` | 8, 10, 60000 |
| Concurrency, queue, question length | `ASK_MAX_CONCURRENT`, `ASK_MAX_QUEUE`, `ASK_MAX_QUESTION_CHARS` | 2, 8, 4000 |
| Enabled | `ASK_ENABLED` | on |
| Guest questions on/off, web tools for guests | `ASK_GUEST_ENABLED`, `ASK_GUEST_WEB` | off, off |
| Guest questions per IP per day, all guests per day | `ASK_GUEST_PER_IP_DAY`, `ASK_GUEST_TOTAL_DAY` | 20, 300 |
| Guest follow-up turns, question length, log retention (days) | `ASK_GUEST_HISTORY_TURNS`, `ASK_GUEST_MAX_QUESTION_CHARS`, `ASK_GUEST_LOG_DAYS` | 3, 1000, 90 |

Keys saved on the settings page are stored in the `settings` table of the `ask` database; protect its backups accordingly.

### Presets

The settings page has buttons that fill in format, base URL and session header:

| Preset | Format | Base URL | Session header | Model example |
|---|---|---|---|---|
| Anthropic | `anthropic` | empty | none | `claude-opus-5` |
| z.ai | `anthropic` | `https://api.z.ai/api/anthropic` | none | `glm-5.3-flash` |
| OpenCode Go | `openai` | `https://opencode.ai/zen/go/v1` | `x-opencode-session` | `glm-5.3-flash` |

Requests carry `User-Agent: wikijs-ask/<version>`.

### Guest questions

Off by default. When on (settings page → Guests):

- A visitor without a Wiki.js login can ask. The service calls Wiki.js without a jwt, so the model sees exactly
  what the Guests group can read. Web tools are off for guests unless `guest_web` is on.
- Nothing is saved for the guest to reopen: no history list, no export, nothing in browser storage. Follow-up
  questions work while the panel stays open (the conversation id lives in page memory and is bound to the IP that
  started it; the server reads the earlier turns from its own log, never from the client).
- Every guest question that reaches the model is written to the `guest_log` table: time, IP, user agent, page,
  question, tool calls with their inputs, sources, answer or error (with any partial answer), tokens, duration.
  Admins can browse it at the bottom of the settings page. Rows older than `guest_log_days` are deleted.
- Limits: `guest_per_ip_day` and `guest_total_day` count the last 24 hours from that log; guest questions have their
  own length limit; they share the global concurrency gate with logged-in users.
- The client IP is the last `X-Forwarded-For` entry (the one the nearest proxy added; Caddy replaces the header),
  or the socket address. Run the service behind the reverse proxy only.

Wiki.js 2.5 `pages.list` checks access by path only, so pages opened to guests by a **tag** rule never show up in
it. The service therefore also lists pages through `pages.search` with an empty query, which checks tags; with the
basic search engine this returns every page up to its "max hits" setting (Administration → Search Engine).

### Theming

The panel reads CSS variables with built-in fallbacks. Define any of them on `:root` in your site CSS:
`--wa-primary`, `--wa-primary-soft`, `--wa-accent`, `--wa-accent-ink`, `--wa-link`, `--wa-surface`.

## Security model

- Only logged-in Wiki.js users can ask, unless guest questions are on; what the model can read is exactly what
  that user (or the Guests group) can read.
- Guest questions are logged in full server-side and limited per IP and per day (see above).
- API calls must come from the wiki page: `Origin` must equal `ASK_ORIGIN`, a custom `X-Wiki-Ask` header is
  required (a cross-site request would need a CORS preflight, which is never answered), and
  `Sec-Fetch-Site` must be `same-origin`.
- Conversation history is read from the database, never taken from the client; every query is scoped to the user.
- A global concurrency gate with a bounded queue protects the model endpoint.
- The system prompt restricts the assistant to questions about the wiki, so it is not a free general-purpose proxy.
- `web_fetch` in `direct` mode checks the address at connect time (after DNS, so rebinding does not help):
  only public unicast addresses, only ports 80/443, http(s) only, size and redirect limits. The `exa` mode
  makes no outbound request from the server at all.
- Model and Exa errors are logged server-side; users see short messages.

## API

| Method | Path | |
|---|---|---|
| POST | `/_ask/chat` | `{conversation_id?, question}` → SSE: `status`, `tool`, `tool_result`, `text`, `sources`, `saved`, `done`, `error`; also for guests when enabled |
| GET | `/_ask/conversations` | own conversations |
| GET / DELETE | `/_ask/conversations/<id>` | messages / delete |
| GET | `/_ask/conversations/<id>/export` | Markdown |
| GET | `/_ask/me` | `{guest: false, email, name, admin, enabled}` or `{guest: true, guest_enabled, enabled}` |
| GET / PUT | `/_ask/admin/settings` | admin |
| POST | `/_ask/admin/test` | admin: test model settings |
| GET | `/_ask/admin/stats` | admin: usage totals, guest counts |
| GET | `/_ask/admin/guest-log?before=<id>` | admin: guest questions, 100 per page, newest first |

## Notes on compatible endpoints

- z.ai ignores `tool_choice: {type: "none"}`, so on the last turn the tools are left out of the request instead.
- Anthropic-only parameters (server-side refusal fallback, adaptive thinking, eager tool input streaming) are
  sent only when the base URL is the Anthropic API.
- OpenCode Go serves GLM only over chat/completions (its Messages endpoint answers `ModelProtocolUnsupported`) and
  refuses requests without `x-opencode-session`. Its terms describe it as meant for coding agents and say traffic is
  monitored for abuse.

## AI-assisted development

This project is vibe-coded: the code and documentation were written with an AI coding assistant, directed by the author, and exercised end to end on a live Wiki.js deployment. Review it as you would any third-party code before relying on it.

## License

MIT
