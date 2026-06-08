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

A footer row shows the database filename, when the data was retrieved, and the row count.

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

- **Live query** — reads the database from disk each time the note is rendered.
- **Cached fallback** — after a successful query, the result is cached as a comment inside the code block (`/* CACHE:{...} */`). If the database is unavailable later (e.g. network drive disconnected, server off), the cached result is shown with a ⚠️ cached indicator.
- **Metadata footer** — every table shows: `📂 dbname · 🕐 timestamp · N rows`.
- **Copy as Markdown** — button below each table copies the result as a pipe-delimited markdown table.
- **Index support** — uses sql.js (SQLite compiled to WebAssembly), so all SQLite features work including indexes, joins, CTEs, and window functions.
- **Read-only by design** — the database is loaded into memory as a read-only snapshot. No changes are ever written back.
- **Instructional messages** — clear guidance instead of cryptic errors when something is misconfigured.

## How Caching Works

After a successful query, the plugin appends a `/* CACHE:{...} */` comment to the end of the code block inside your note file. This is invisible in reading view but preserved in the markdown source:

````markdown
```sql
db: /var/lib/jellyfin/data/jellyfin.db
SELECT Type, count(*) FROM BaseItems GROUP BY Type;
/* CACHE:{"columns":["Type","count(*)"],"rows":[...],"dbName":"jellyfin.db","timestamp":"2026-06-07 22:36:00","rowCount":7} */
```
````

The cache is updated on each successful query. When the database is unreachable, the last cached result is displayed.

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

- **Desktop only** — uses Node.js `fs` to read database files from disk. `manifest.json` has `isDesktopOnly: true`.
- Databases can live anywhere the OS user has read access (inside or outside the vault).

## Technical Notes

- Uses [sql.js](https://github.com/sql-js/sql.js) v1.14+ — SQLite compiled to WebAssembly via Emscripten.
- The WASM binary (~644 KB) is embedded into `main.js` at build time. No separate `.wasm` file to manage.
- Databases are read into memory as a `Uint8Array`. Large databases (hundreds of MB) will use proportional memory.
- Registers `sql`, `sqlite`, and `ObsSync` as code block languages.

## License

MIT
