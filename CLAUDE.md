# RateCheck — Claude working notes

Read this file at the start of every RateCheck session. Also check memory files in
`~/.claude/projects/-Users-jwynn/memory/` for user preferences and cross-project context.

---

## What this is

RateCheck is a UK VOA business rates research console for chartered surveyors.
Natural language → SQL → evidenced results with AI headline finding and evidence chips.
Greater Manchester pilot: 123,719 hereditaments from the 2026 rating list.

**Live URL:** https://ratecheck.vercel.app (Vercel auto-deploys from GitHub main)
**Repo:** https://github.com/wynny12-arch/ratecheck
**Deploy:** `git push` → Vercel builds and deploys automatically. No manual deploy step.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 14, Pages Router |
| Hosting | Vercel |
| Auth | Supabase magic-link (OTP email) |
| Database | Supabase Postgres (read-only role for API queries) |
| AI | Anthropic claude-haiku-4-5-20251001 |
| Fonts | Inter (body), Fraunces (wordmark), JetBrains Mono (SQL/numbers) |

**Environment variables (set in Vercel + `.env.local`):**
- `ANTHROPIC_API_KEY`
- `DATABASE_URL_READONLY` — Postgres connection string for read-only role `ratecheck_readonly`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — used only in ingest scripts, not in API routes

---

## File map

```
pages/
  index.js          — full UI (icon rail, chat panel, exchange/result components)
  login.js          — magic-link sign-in page
  api/
    query.js        — SQL generation → DB execute → explanation generation
    chat.js         — conversational follow-up with auto-run for new queries
    feedback.js     — thumbs up/down + comment per result
  auth/
    callback.js     — Supabase auth redirect handler
lib/
  supabase.js       — createBrowserClient helper
styles/
  globals.css       — full CSS (chat layout, icon rail, table, evidence strip)
scripts/            — data ingest scripts (not part of the app)
```

---

## Database schema

### `list_entries` — one row per hereditament (123,719 rows)
| Column | Type | Notes |
|---|---|---|
| assessment_reference | BIGINT PK | |
| uarn | BIGINT | |
| number_or_name | VARCHAR | house number or property name |
| street | VARCHAR | VOA street names often differ from common usage |
| town | VARCHAR | |
| postcode | VARCHAR | exact match, always UPPER() |
| postcode_area | VARCHAR | outward district, e.g. M30, SK1, OL4 |
| primary_description_code | VARCHAR | e.g. CS, CO, CW, CF — first 2 chars = type prefix |
| primary_description_text | VARCHAR | |
| scat_code_and_suffix | VARCHAR | |
| rateable_value | BIGINT | whole pounds £ |
| firm_name | VARCHAR | occupier name — unreliable, often blank |
| full_property_identifier | VARCHAR | |

### `smv_assessments` — one per assessment (join on assessment_reference)
| Column | Type | Notes |
|---|---|---|
| assessment_reference | BIGINT PK | |
| uarn | BIGINT | |
| scheme_reference | BIGINT | links properties valued on same scheme |
| scat_code | VARCHAR | |
| total_area_or_units | DOUBLE PRECISION | m² |
| adopted_rv | BIGINT | whole pounds £ |
| unit_of_measurement | VARCHAR | GIA, NIA, EFA, GEA, RCA, OTH |
| unadjusted_price | DOUBLE PRECISION | £/m² Zone A equivalent for shops |

### `smv_line_items` — one per floor zone (join on assessment_reference)
| Column | Type | Notes |
|---|---|---|
| assessment_reference | BIGINT FK | |
| line_number | INTEGER | PK with assessment_reference |
| floor_description | VARCHAR | Ground, First, Mezzanine |
| description | VARCHAR | Zone A, Zone B, Rear, Internal Storage |
| area | DOUBLE PRECISION | m² |
| price | DOUBLE PRECISION | £/m² |
| value | BIGINT | whole pounds £ |

**Description code prefixes:** CS=retail shops, CO=offices, CW=warehouses, CF=factories, IF=industrial

---

## PostgreSQL gotchas (important — the SQL model gets these wrong without prompting)

1. **ROUND() requires `::numeric` cast on BOTH operands:**
   ```sql
   -- CORRECT
   ROUND(unadjusted_price::numeric, 2)
   ROUND(le.rateable_value::numeric / sa.total_area_or_units::numeric, 2)
   -- WRONG — dividing numeric by double precision returns double precision, still breaks ROUND
   ROUND(le.rateable_value::numeric / sa.total_area_or_units, 2)
   ```

2. **`percentile_cont` is an ordered-set aggregate, NOT a window function:**
   ```sql
   -- CORRECT
   percentile_cont(0.5) WITHIN GROUP (ORDER BY rateable_value)
   -- For partitioned medians, use a CTE
   WITH medians AS (
     SELECT street, percentile_cont(0.5) WITHIN GROUP (ORDER BY rateable_value) AS median_rv
     FROM list_entries GROUP BY street
   ) SELECT ...
   ```

3. **Use UPPER() for all address matching** — VOA street names are inconsistent

4. **Postcode matching:** if the question has a full postcode, filter on `postcode` (exact, uppercased) + `number_or_name`. Don't rely on street/town matching.

5. **Never use numeric values from the question as filter criteria** — always fetch from DB. A question saying "is the 167 sqm area in line with peers?" must not filter `WHERE total_area = 167`.

---

## API routes

### `POST /api/query`
Accepts: `{ question: string }`
Returns: `{ sql, rows, explanation, signals, rowCount }`

Flow:
1. Generate SQL with `claude-haiku` (SYSTEM_SQL prompt + schema)
2. Strip `--` comments, split on `;`, take first statement
3. Validate (no banned keywords, no multi-statement)
4. Execute against Postgres read-only role
5. On DB error: one retry with error context
6. If rows > 0 and ≤ 200 and question is analytical: generate explanation + signals
7. Log to `query_log` table regardless of success/failure

**Explanation output:** JSON `{ finding: "...", signals: [...] }` — signals are 3–6 short evidence statements under 10 words each.

**SQL prompt rules (key ones):**
- For named property lookups: anchor by assessment_reference, description_code, postcode_area — never cross property types
- For valuation breakdowns (smv_line_items): select ONLY floor_description, description, area, price, value — no property-level columns mixed in
- Never select adjacent numeric + text column pairs without separator (causes garbled output like "167.55NIA")

### `POST /api/chat`
Accepts: `{ context: { question, rows, explanation }, messages: [...] }`
Returns: `{ reply, followup_query: string|null }`

The model either:
- Answers from current data → `reply` + `followup_query: null`
- Needs more data → short "fetching that now" reply + `followup_query` = specific query string

The frontend (`FollowUpThread`) detects `followup_query !== null` and calls `runQuery()` automatically — no user action needed.

**Critical prompt rules:**
- Model must NEVER say "I cannot answer" — always set followup_query when more data helps
- Peer/comparable followup_query must request ONE ROW PER PROPERTY (aggregate: RV, area, RV/sqm, unadjusted_price) — never smv_line_items zone breakdowns in a peer comparison

### `POST /api/feedback`
Accepts: `{ queryLogId, thumbsUp, comment }`
Writes to `query_feedback` table. Linked to `query_log` by `query_log_id`.

---

## UI architecture

**Layout:** masthead (56px) → app-shell (flex row) → icon-rail (52px) + side-panel (280px, slide-in) + chat-panel (flex-1)

**Chat panel:** fixed input bar at bottom, scrollable exchanges above. Each exchange has:
- Question + timestamp + elapsed time
- Headline finding (bold key assertion) + evidence chips
- Results table (with `← scroll →` hint when overflowing)
- Generated SQL (collapsible `<details>`)
- Follow-up thread (input + message history)
- Thumbs up/down feedback

**Scroll behaviour:** when a new exchange lands, scroll to the TOP of that exchange (not the bottom of the table) using a sentinel `<div ref={lastExchangeRef}>` placed before the last exchange.

**Icon rail panels:** Recent queries (localStorage, max 12), Example queries (4 groups), Schema reference, How to use tips.

**Mobile:** side panel overlays at <768px with backdrop. iOS height: `-webkit-fill-available`.

---

## State architecture

- `exchanges` — array in Home state, append-only during session (not persisted beyond localStorage for recent queries)
- `recentQueries` — localStorage key `ratecheck_recent`, max 12, deduped
- Follow-up thread messages — local state inside each `FollowUpThread` component
- Auth — Supabase session via `getServerSideProps`, redirects to `/login` if no session

**Not yet implemented (v2):**
- Server-side session persistence (exchanges lost on page refresh)
- Anthropic prompt caching (would reduce costs on busy sessions)
- Streaming responses

---

## Design tokens

```css
--paper:       #faf7f2   /* warm cream background */
--paper-soft:  #f4efe6
--ink:         #1a1714   /* near-black text */
--ink-soft:    #4a443d
--ink-faint:   #8c857c
--rule:        #d8d1c4
--accent:      #7a1c2c   /* oxblood — primary action colour */
--accent-soft: #b94052
--accent-tint: #f4ebed
```

---

## Data coverage

- **Source:** VOA 2026 rating list, England & Wales compiled epoch 0001 baseline
- **Scope:** Greater Manchester only (filtered at ingest)
- **list_entries:** 123,719 rows
- **smv_assessments:** 113,353 rows
- **smv_line_items:** 354,135 rows
- **Top description codes:** CS 29,239 · CO 24,659 · CW 17,923 · IF 13,943 · CP 11,539
- **Postcode prefixes:** SK 25,064 · OL 19,201 · BL 15,299 · M2 13,422 · M1 13,250

**Test property:** 225 Monton Road, M30 9PS — assessment_reference 28114711000, RV £30,000, CS retail, zoned valuation (Zone A £390/sqm, total 167.55 sqm ground floor)

---

## Known behaviours and lessons learned

- `firm_name` is unreliable — Tesco Express may be blank or use a legal entity name; always look up by postcode + number_or_name
- M28 and M30 are on different schemes with different Zone A rates (M28 ~£165/sqm vs M30 £390/sqm) — not valid comparables for each other
- All CS shops on the same parade typically share the same Zone A rate; variation comes from zone depths and area
- The retry mechanism in `/api/query` handles most SQL generation errors automatically
- Wide tables (peer comparison results) trigger `← scroll →` hint via ResizeObserver
- Follow-up threads are scoped to their parent exchange — they don't know about other exchanges in the session
