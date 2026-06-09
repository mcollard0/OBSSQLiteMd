# OBSSQLiteMd — Architecture
**Repo:** [mcollard0/OBSSQLiteMd](https://github.com/mcollard0/OBSSQLiteMd)
**Status:** Active — desktop live queries + mobile cached view.
## What it does
Runs SQLite queries written inside fenced code blocks and renders results as live HTML tables in Obsidian's reading view. Results are cached inside the note file so tables remain visible when the database is offline or on mobile.
## Block Formats
### Classic (`sql` / `sqlite`)
````
```sql
db: /absolute/or/vault-relative/path.db
SELECT col1, col2 FROM table WHERE condition;
/* REFRESH:15m */
```
````
`db:` — database path (absolute or vault-relative). Must be the first non-blank line. Everything else before the `/* ... */` comment is the SQL. Multi-line queries are joined with spaces before execution.
### "ObsSync" ODBC-style
````
```ObsSync
DRIVER=sqlite;DATABASE=/path/to/file.db;QUERY=SELECT * FROM table
/* REFRESH:MANUAL */
```
````
Semicolon-delimited `KEY=VALUE` pairs. `QUERY=` must be last — its value extends to end of block so SQL containing semicolons is safe. `DRIVER=` is optional and defaults to `sqlite`; any other driver value shows a clear error.
## The `/* REFRESH | CACHE */` Comment Directive
A single `/* ... */` comment inside the code block controls both refresh behaviour and cached data. Pipe `|` is the optional separator between directives.
```
/* REFRESH:15m | CACHE:{...json...} */
```
Both directives are optional and independent. The comment is stripped before the SQL is parsed and executed.
### REFRESH directive
| Value | Behaviour |
|---|---|
| *(omitted)* | Auto — query runs on every render (default) |
| `REFRESH:AUTO` / `REFRESH:AUTOMATIC` | Explicit auto — same as default |
| `REFRESH:MANUAL` | Show cache on render; live query only on 🔄 click |
| `REFRESH:15m` *(time value)* | Auto on render + re-query every N time units |
**Supported time units:** `ms` / `millisecond(s)` · `s` / `sec(s)` / `second(s)` · `m` / `min(s)` / `minute(s)` · `h` / `hr(s)` / `hour(s)` · `d` / `day(s)`. Decimal values (`1.5h`) are valid.
### CACHE directive
Written automatically by the plugin after every successful live query.
```json
{
  "columns": ["col1", "col2"],
  "rows": [["val1", "val2"]],
  "dbName": "file.db",
  "timestamp": "2026-06-08 14:00:00",
  "rowCount": 1
}
```
The cache is always fully replaced (never appended) on each successful run. `writeCache()` uses `vault.process()` for atomic writes and strips any existing `/* REFRESH:` or `/* CACHE:` line before inserting the new one.
## Refresh Modes
### Auto (default)
1. Note opens → `renderParsed()` called → DB read via `require('fs').readFileSync()` → sql.js executes query in-memory → table rendered → cache written back.
2. If `refreshInterval` is set, `window.setTimeout()` is scheduled; on fire it checks `el.isConnected` before re-rendering (chain stops automatically when note is closed).
### Manual (`REFRESH:MANUAL`)
1. On render: show cached data immediately (no query). 📂 / 🔄 click → `renderParsed()` with `forceRefresh = true` → live query runs.
2. If no cache yet: show inline 🔄 prompt instead of a table.
### Mobile (cache-only)
1. `getVaultRoot()` returns `null` (no `FileSystemAdapter` on mobile).
2. Cache exists → render cached table; 📂 / 🔄 show a Notice ("Open on desktop to refresh").
3. No cache → show "Open on desktop first" message.
## Rendering
Each result set produces an HTML `<table>` with `<thead>`, `<tbody>` (hover highlight), and `<tfoot>` footer:
```
[📂] dbname · 🕐 timestamp · N rows [⚠️ cached] [· ⏱️ 15m] [🔄]
```
📂 and 🔄 are clickable spans wired to `onRefresh`. ⚠️ cached shows when data is from cache. ⏱️ Ns shows only when a timed interval is active.
Below the table: **📋 Copy Markdown** writes a pipe-delimited markdown table to the clipboard.
## Security
Only `SELECT`, `WITH … SELECT`, and `EXPLAIN` are permitted. `FORBIDDEN_RE` rejects `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ATTACH`, `PRAGMA`, etc. String literals are stripped before the check so `SELECT 'DROP TABLE'` is not falsely blocked. Databases are loaded as a read-only in-memory snapshot — no writes ever reach the DB file.
## Mobile Support
`manifest.json` has `isDesktopOnly: false`. Node.js `fs` is required dynamically inside the desktop-only code path and is never called on mobile. `path` module calls are replaced with inline string operations.
## Build
- **esbuild** bundles to a single `main.js`; `fs` is marked external (Electron/Node runtime)
- sql.js WASM (~644 KB) inlined as binary loader — no separate `.wasm` file
- TypeScript; `@types/node` provides type coverage for desktop code paths
## API / Vault Integration
- `vault.process(file, fn)` — atomic read-modify-write for cache updates
- `ctx.getSectionInfo(el)` — maps rendered block back to source line numbers
- `FileSystemAdapter.getBasePath()` — vault root path (desktop only, null on mobile)
## Feature Status
| Feature | Status |
|---|---|
| Live query (desktop) | ✅ |
| Cached fallback | ✅ |
| Mobile cached view | ✅ |
| `REFRESH:MANUAL` | ✅ |
| `REFRESH:` timed auto | ✅ |
| Interactive footer (📂 🔄) | ✅ |
| Copy as Markdown | ✅ |
| `sql` / `sqlite` / `ObsSync` blocks | ✅ |
| Read-only enforcement | ✅ |
| Mobile live queries | ❌ sandboxed filesystem |
| Write queries | ❌ by design |
## Known Constraints
- Absolute paths outside the vault require desktop (e.g. `/var/lib/jellyfin/`)
- Large DBs load fully into memory as `Uint8Array`
- Cache JSON inline in markdown — very large result sets produce large notes
- Timed refresh chain stops when `el.isConnected` is false (note closed/navigated away)
- One sql.js engine instance shared across all blocks (lazy-initialised)
- **⚠️ WAL blind spot:** sql.js reads the database via `fs.readFileSync( dbPath )` — raw bytes of the main `.db` file only. It never reads the companion `.db-wal` file. SQLite's WAL (Write-Ahead Log) mode keeps recent writes in the WAL until a checkpoint merges them into the main file. The default autocheckpoint threshold is 1000 pages, which on low-write databases (e.g. Ombi) can mean days of uncommitted-to-disk writes. Queries will return stale results for any data written since the last checkpoint — including fields like `Available` on media requests that appear as `0` despite the live application having set them to `1`. **Proper workaround:** run a periodic `PRAGMA wal_checkpoint(PASSIVE)` on the host database via a systemd timer. This keeps the main `.db` file current without any plugin changes and works across all platforms. `better-sqlite3` is not a viable alternative — it requires platform-specific prebuilt binaries and Electron version coupling, making it non-portable.
## What was NOT built
- Native `child_process` + system `sqlite3` binary — WASM only
- Remote HTTPS bridge (Nginx / Python backend) — local files only
- Inline syntax (backtick + HTML comment anchors) — code blocks only
- Content-based hashing / change detection — simple timestamp cache
- `Promise.all()` batching / per-DB connection pooling — one query per block render
