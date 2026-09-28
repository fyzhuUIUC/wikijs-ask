# wikijs-ask

An AI Q&A panel for [Wiki.js](https://js.wiki) 2. A floating button on every page opens a chat that
answers from the wiki pages **the asking user is allowed to read**, cites them, and can look things up
on the web. Chats are saved per user and can be exported as Markdown.

- Answers are grounded in the wiki: the model gets the page index, searches and reads pages with tools, and links its sources
- Permissions come from Wiki.js itself: every lookup runs with the asking user's own login, so nobody gets answers from pages they cannot open
- Optional web tools: `web_search` (Exa) and `web_fetch` (via Exa, or direct with private-address blocking)
- Saved conversations per user (Postgres), history list, Markdown export
- Markdown, LaTeX (KaTeX) and code highlighting in answers; streaming output
- Resizable / maximizable panel, English and Chinese UI
- Settings page for admins: API endpoint, key, model, web tools, limits, with a connection test and usage totals
- Any Anthropic Messages API endpoint: the Anthropic API (default `claude-opus-5`) or compatible ones such as z.ai (`glm-5.3-flash`)

It is a sidecar service, not a Wiki.js module: Wiki.js 2 has no plugin mechanism for UI or API
extensions, so nothing in Wiki.js is modified and it can be upgraded independently.

## How it fits together

```
browser ── /_ask/* ──> reverse proxy ──> wikijs-ask ──> Wiki.js GraphQL + page HTML (with the user's jwt)
        └─ everything else ─────────────> Wiki.js      ├─> model endpoint (Anthropic Messages API)
                                                        ├─> Exa (optional)
                                                        └─> Postgres database "ask"
```

| Coupling | How |
|---|---|
| Login | Reuses the Wiki.js `jwt` cookie; `users.profile` tells who is asking, guests get 401 |
| Permissions | Page list, search and page reads go to Wiki.js with the user's jwt |
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
| API base URL | `ASK_BASE_URL` | empty = Anthropic API |
| API key | `ASK_API_KEY` / `ANTHROPIC_API_KEY` | |
| Model | `ASK_MODEL` | `claude-opus-5` on the Anthropic API; required elsewhere |
| Effort | `ASK_EFFORT` | model default (Anthropic only) |
| Web search on/off, Exa key, results | `ASK_WEB_SEARCH`, `EXA_API_KEY`, `ASK_WEB_SEARCH_RESULTS` | on, –, 5 |
| Web fetch on/off, method | `ASK_WEB_FETCH`, `ASK_WEB_FETCH_VIA` | on, `exa` |
| Wiki name, extra instructions | `ASK_WIKI_NAME`, `ASK_EXTRA_INSTRUCTIONS` | `this wiki` |
| Max turns, history turns, characters per page | `ASK_MAX_TURNS`, `ASK_HISTORY_TURNS`, `ASK_PAGE_CHAR_CAP` | 8, 10, 60000 |
| Concurrency, queue, question length | `ASK_MAX_CONCURRENT`, `ASK_MAX_QUEUE`, `ASK_MAX_QUESTION_CHARS` | 2, 8, 4000 |
| Enabled | `ASK_ENABLED` | on |

Keys saved on the settings page are stored in the `settings` table of the `ask` database; protect its backups accordingly.

### Theming

The panel reads CSS variables with built-in fallbacks. Define any of them on `:root` in your site CSS:
`--wa-primary`, `--wa-primary-soft`, `--wa-accent`, `--wa-accent-ink`, `--wa-link`, `--wa-surface`.

## Security model

- Only logged-in Wiki.js users can ask; what the model can read is exactly what that user can read.
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
| POST | `/_ask/chat` | `{conversation_id?, question}` → SSE: `status`, `tool`, `tool_result`, `text`, `sources`, `saved`, `done`, `error` |
| GET | `/_ask/conversations` | own conversations |
| GET / DELETE | `/_ask/conversations/<id>` | messages / delete |
| GET | `/_ask/conversations/<id>/export` | Markdown |
| GET | `/_ask/me` | `{email, admin}` |
| GET / PUT | `/_ask/admin/settings` | admin |
| POST | `/_ask/admin/test` | admin: test model settings |
| GET | `/_ask/admin/stats` | admin: usage totals |

## Notes on compatible endpoints

- z.ai ignores `tool_choice: {type: "none"}`, so on the last turn the tools are left out of the request instead.
- Anthropic-only parameters (server-side refusal fallback, adaptive thinking, eager tool input streaming) are
  sent only when the base URL is the Anthropic API.

## AI-assisted development

This project is vibe-coded: the code and documentation were written with an AI coding assistant, directed by the author, and exercised end to end on a live Wiki.js deployment. Review it as you would any third-party code before relying on it.

## License

MIT
