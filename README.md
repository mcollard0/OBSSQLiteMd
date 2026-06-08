# OBSSQLiteMd

An Obsidian plugin that runs SQLite queries against local databases and renders the results as tables in reading view. Write SQL in a fenced code block, get a live table.

## Usage

Add a fenced `sql` (or `sqlite`) code block to any note:

````markdown
```sql
db: /var/lib/jellyfin/data/jellyfin.db
SELECT name, department, salary
FROM employees
WHERE department = 'Engineering'
ORDER BY salary DESC;
```
````

Or use an ODBC-style connection string with an `ObsSync` block:

````markdown
```ObsSync
DRIVER=sqlite;DATABASE=/var/lib/jellyfin/data/jellyfin.db;QUERY=SELECT name, department, salary FROM employees WHERE department = 'Engineering' ORDER BY salary DESC
```
````

Switch to **reading view** — the code block is replaced with a rendered table:

| name | department | salary |
| --- | --- | --- |
| Eve Johnson | Engineering | 140000 |
| Carol Davis | Engineering | 130000 |
| Alice Chen | Engineering | 125000 |
| Hank Brown | Engineering | 115000 |

A footer row shows the database filename, when the data was retrieved, and the row count. Click 📂 or 🔄 in the footer to manually refresh.

## Block Formats

### `sql` / `sqlite`

```
db: /absolute/path/to/database.db
SELECT ...;
```

- **`db:`** — path to the SQLite database file. Absolute paths or vault-relative paths.
- **Query** — any read-only SQL: `SELECT`, `WITH ... SELECT`, or `EXPLAIN QUERY PLAN`.
- Write operations (`INSERT`, `UPDATE`, `DELETE`, `DROP`, etc.) are blocked.

### `ObsSync` (ODBC-style)

```
DRIVER=sqlite;DATABASE=/absolute/path/to/database.db;QUERY=SELECT ...
```

- **`DRIVER=`** — optional, defaults to `sqlite`. Currently only `sqlite` is supported.
- **`DATABASE=`** — path to the SQLite database file. Absolute paths or vault-relative paths.
- **`QUERY=`** — must be last; its value extends to end of the block, so semicolons inside the SQL are safe.

## Features

- **Live query** — reads the database from disk each time the note is rendered (desktop).
- **Cached fallback** — after a successful query, results are cached inside the code block. If the database is unavailable, the cached result is shown with a ⚠️ cached indicator.
- **Mobile support** — on mobile, cached data is displayed read-only. Open on desktop first to populate the cache.
- **Refresh modes** — control when queries re-run via the `REFRESH:` directive (see below).
- **Timed auto-refresh** — `REFRESH:15m` re-runs the query every N time units while the note is open.
- **Interactive footer** — 📂 and 🔄 in the footer row are clickable; they trigger a live refresh on desktop or show a notice on mobile.
- **Copy as Markdown** — button below each table copies the result as a pipe-delimited markdown table.
- **Index support** — uses sql.js (SQLite compiled to WebAssembly), so all SQLite features work including indexes, joins, CTEs, and window functions.
- **Read-only by design** — the database is loaded into memory as a read-only snapshot. No changes are ever written back.
- **Instructional messages** — clear guidance instead of cryptic errors when something is misconfigured.

## Refresh Modes

Add a `/* REFRESH:... */` comment anywhere in the block to control when the query runs:

| Value | Behaviour |
| --- | --- |
| *(omitted)* | Auto — query runs on every render (default) |
| `REFRESH:AUTO` | Same as default |
| `REFRESH:MANUAL` | Show cache on render; live query only on 🔄 click |
| `REFRESH:15m` | Auto on render + re-query every 15 minutes |

**Time units:** `ms` · `s` / `sec(s)` / `second(s)` · `m` / `min(s)` / `minute(s)` · `h` / `hr(s)` / `hour(s)` · `d` / `day(s)`. Decimal values (`1.5h`) are valid.

Examples:

````markdown
```sql
db: /var/lib/jellyfin/data/jellyfin.db
SELECT Type, count(*) FROM BaseItems GROUP BY Type;
/* REFRESH:5m */
```
````

````markdown
```sql
db: /path/to/large.db
SELECT * FROM expensive_view;
/* REFRESH:MANUAL */
```
````

## How Caching Works

After a successful query, the plugin writes a `/* REFRESH:... | CACHE:{...} */` comment to the end of the code block. This is invisible in reading view but preserved in the markdown source:

````markdown
```sql
db: /var/lib/jellyfin/data/jellyfin.db
SELECT Type, count(*) FROM BaseItems GROUP BY Type;
/* REFRESH:5m | CACHE:{"columns":["Type","count(*)"],"rows":[...],"dbName":"jellyfin.db","timestamp":"2026-06-08 14:00:00","rowCount":7} */
```
````

The cache is updated on each successful query. When the database is unreachable, the last cached result is displayed. If no `REFRESH:` directive is present, the comment is just `/* CACHE:{...} */` (backward compatible).

## Installation

### From source

```bash
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into your vault:

```
.obsidian/plugins/obs-sqlite-md/
├── main.js
├── manifest.json
└── styles.css
```

Enable the plugin in **Settings → Community plugins**.

### Development

```bash
npm run dev    # watch mode — rebuilds on file changes
```

## Requirements

- **Desktop** — live queries use Node.js `fs` to read database files from disk. Absolute paths and vault-relative paths both work.
- **Mobile** — displays cached data only. Open the note on desktop first to populate the cache; subsequent mobile views show the last cached result.
- Databases can live anywhere the desktop OS user has read access (inside or outside the vault).

## Technical Notes

- Uses [sql.js](https://github.com/sql-js/sql.js) v1.14+ — SQLite compiled to WebAssembly via Emscripten.
- The WASM binary (~644 KB) is embedded into `main.js` at build time. No separate `.wasm` file to manage.
- Databases are read into memory as a `Uint8Array`. Large databases (hundreds of MB) will use proportional memory.
- Registers `sql`, `sqlite`, and `ObsSync` as code block languages.
- Node.js `fs` is required dynamically at runtime (never at module load), so the plugin loads safely on mobile without crashing.
- Timed refresh uses a `window.setTimeout` chain; the chain stops automatically when `el.isConnected` is false (note closed or navigated away).
- See `ARCHITECTURE.md` for full design details.

## License

MIT
