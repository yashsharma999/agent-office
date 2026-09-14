# Identity

Who a user is, across the browser, Telegram and the agent runtime.

## Before

The browser minted an anonymous id (`c-…`) in localStorage and sent it with
every request. Anyone who knew (or guessed) an id owned that world: agents,
Gmail/Calendar grants, chat history. Telegram chats were separate people.

## Now

- **Cognito user pool** (`COGNITO_*` in `.env`, hosted UI, code grant with a
  client secret). `src/auth.js` exchanges the code, verifies the id token with
  `aws-jwt-verify`, and keeps two httpOnly cookies: `ao_id` (1 h) and `ao_rt`
  (30 d). An expired id token is refreshed silently on the next request.
- **The server decides who you are.** `ui-server.js` guards everything under
  `/api`: with sign-in configured, `req.user.sub` is the only user id; ids in
  the query string or body are ignored (`userOf(req)`). Without the
  `COGNITO_*` settings (plain local dev) the old anonymous id still works.
- **Routes**: `/auth/login`, `/auth/callback`, `/auth/logout`, `/api/me`.
- **Claim**: after the first sign-in the page offers to bring the browser's
  pre-sign-in world across (`/api/claimable`, `POST /api/claim` →
  `claimLegacy` in `src/aliases.js`). Prefs are copied only if the account has
  no agents yet; chat snapshots are copied under the new user prefix. Gmail
  and Calendar tokens live in the AgentCore vault under the old id, so those
  need connecting again.
- **Telegram**: `/link` in the bot mints a 6-character code (10 min). Typing
  it into AGENTS → LINK TELEGRAM (`POST /api/telegram/link`) stores
  `alias:tg-<chatId> → userId`; the bot then runs turns as that user
  (`resolveAlias`). An unlinked chat is still a person of its own.

## Where things live

| thing | store |
| --- | --- |
| user record (agents, theme, links) | DynamoDB `my-agent-prefs`, key = Cognito `sub` |
| link codes, Telegram aliases | same table, keys `link:<CODE>`, `alias:tg-<chatId>` |
| chat snapshots | S3 `chats/<sub>/…` |
| Google tokens | AgentCore Identity vault, per user id |

## Not done yet

- Sessions are cookie-only; there is no CSRF token. `SameSite=Lax` covers the
  state-changing POSTs for now.
- The client secret rides in App Runner env vars (same as the rest of the
  runtime config). Move to Secrets Manager when the harness gets a secrets
  pass.
- No account page: nothing lists linked Telegram chats or lets you unlink.
