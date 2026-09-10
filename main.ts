import { Plugin, Notice, FileSystemAdapter, MarkdownPostProcessorContext } from "obsidian";
import initSqlJs, { Database } from "sql.js";

// @ts-ignore — esbuild resolves this import at bundle time
import sqlWasm from "sql.js/dist/sql-wasm.wasm";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */
interface ParsedBlock {
	dbPath: string;
	query: string;
	cached: CachedResult | null;
	refreshMode: 'auto' | 'manual';
	refreshInterval: number | null; // ms; null = no timed refresh
	refreshRaw: string | null;      // original value to write back (e.g. "15m", "MANUAL")
}

interface CachedResult {
	columns: string[];
	rows: any[][];
	dbName: string;
	timestamp: string;
	rowCount: number;
}

/* ------------------------------------------------------------------ */
/*  Comment parser — extracts REFRESH: and CACHE: from block comments  */
/*  Pipe is an optional separator. Supported REFRESH values:           */
/*    REFRESH:MANUAL                  — user must click to refresh     */
/*    REFRESH:AUTO / AUTOMATIC        — refresh on render (default)    */
/*    REFRESH:15m, 30s, 2h, 1d, etc. — timed auto-refresh             */
/* ------------------------------------------------------------------ */
interface ParsedComment {
	refreshMode: 'auto' | 'manual';
	refreshInterval: number | null;
	refreshRaw: string | null;
	cached: CachedResult | null;
	raw: string | null;
}

function parseTimeMs( val: string ): number | null {
	const m = val.match( /^(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?)$/i );
	if ( !m ) return null;
	const n = parseFloat( m[1] );
	const u = m[2].toLowerCase();
	if ( u === 'ms' || u.startsWith( 'millisecond' ) ) return n;
	if ( u === 's' || u === 'sec' || u === 'secs' || u.startsWith( 'second' ) ) return n * 1_000;
	if ( u === 'm' || u === 'min' || u === 'mins' || u.startsWith( 'minute' ) ) return n * 60_000;
	if ( u === 'h' || u === 'hr' || u === 'hrs' || u.startsWith( 'hour' ) ) return n * 3_600_000;
	if ( u === 'd' || u.startsWith( 'day' ) ) return n * 86_400_000;
	return null;
}

function parseComment( source: string ): ParsedComment {
	const m = source.match( /\/\*\s*([\s\S]*?)\*\// );
	if ( !m ) return { refreshMode: 'auto', refreshInterval: null, refreshRaw: null, cached: null, raw: null };
	const inner = m[1];

	let refreshMode: 'auto' | 'manual' = 'auto';
	let refreshInterval: number | null = null;
	let refreshRaw: string | null = null;
	const rm = inner.match( /\bREFRESH:\s*([^\s|]+)/i );
	if ( rm ) {
		const rv = rm[1];
		if ( /^auto(?:matic)?$/i.test( rv ) ) {
			/* default — no change */
		} else if ( /^manual$/i.test( rv ) ) {
			refreshMode = 'manual';
			refreshRaw = 'MANUAL';
		} else {
			const ms = parseTimeMs( rv );
			if ( ms !== null ) { refreshInterval = ms; refreshRaw = rv; }
		}
	}

	let cached: CachedResult | null = null;
	const ci = inner.search( /\bCACHE:/i );
	if ( ci >= 0 ) {
		try { cached = JSON.parse( inner.slice( inner.indexOf( ':', ci ) + 1 ).trim() ); } catch { /* ignore */ }
	}

	return { refreshMode, refreshInterval, refreshRaw, cached, raw: m[0] };
}

/* ------------------------------------------------------------------ */
/*  Parse block. Supports an optional CACHE comment embedded inside:    */
/*                                                                     */
/*  ```sql                                                             */
/*  db: /path/to/file.db                                               */
/*  select name, salary from employees;                                */
/*  CACHE:{"columns":[...],"rows":[...],...}                            */
/*  ```                                                                */
/* ------------------------------------------------------------------ */
function parseBlock( source: string ): ParsedBlock | null {
	const { refreshMode, cached, raw, refreshInterval, refreshRaw } = parseComment( source );

	/* Remove the comment before parsing db/query lines */
	const clean = raw ? source.replace( raw, "" ) : source;
	const lines = clean.trim().split( "\n" );
	let dbPath = "";
	const queryLines: string[] = [];

	for ( const line of lines ) {
		const trimmed = line.trim();
		if ( trimmed.length === 0 ) continue;
		if ( trimmed.toLowerCase().startsWith( "db:" ) && !dbPath ) {
			dbPath = trimmed.slice( 3 ).trim();
		} else {
			queryLines.push( trimmed );
		}
	}

	const query = queryLines.join( " " ).trim();
	if ( !dbPath || !query ) return null;
	return { dbPath, query, cached, refreshMode, refreshInterval, refreshRaw };
}

/* ------------------------------------------------------------------ */
/*  Parse ODBC-style block. Format (QUERY must be last):               */
/*  DRIVER=sqlite;DATABASE=/path/to/file.db;QUERY=SELECT ...           */
/* ------------------------------------------------------------------ */
function parseOdbcBlock( source: string ): ParsedBlock | null {
	const { refreshMode, cached, raw, refreshInterval, refreshRaw } = parseComment( source );
	const clean = ( raw ? source.replace( raw, "" ) : source ).trim();

	/* QUERY= value extends to end of content (SQL can contain semicolons) */
	const queryKeyIdx = clean.search( /\bQUERY\s*=/i );
	const headerStr   = queryKeyIdx >= 0 ? clean.slice( 0, queryKeyIdx ) : clean;
	const query       = queryKeyIdx >= 0 ? clean.slice( clean.indexOf( "=", queryKeyIdx ) + 1 ).trim() : "";

	/* Parse DRIVER, DATABASE (and any other params) from the header portion */
	const params: Record<string, string> = {};
	for ( const part of headerStr.split( /\s*;\s*/ ) ) {
		if ( !part.trim() ) continue;
		const eq = part.indexOf( "=" );
		if ( eq === -1 ) continue;
		params[ part.slice( 0, eq ).trim().toUpperCase() ] = part.slice( eq + 1 ).trim();
	}

	const dbPath = params[ "DATABASE" ] ?? "";
	if ( !dbPath || !query ) return null;
	return { dbPath, query, cached, refreshMode, refreshInterval, refreshRaw };
}

/* ------------------------------------------------------------------ */
/*  Security: only allow SELECT / WITH / EXPLAIN                       */
/* ------------------------------------------------------------------ */
const FORBIDDEN_RE = /\b(INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

function isReadOnly( sql: string ): boolean {
	const normalized = sql.trim().toUpperCase();
	if ( normalized.startsWith( "SELECT" ) || normalized.startsWith( "WITH" ) || normalized.startsWith( "EXPLAIN" ) ) {
		const stripped = sql.replace( /"[^"]*"/g, "" ).replace( /'[^']*'/g, "" );
		return !FORBIDDEN_RE.test( stripped );
	}
	return false;
}

/* ------------------------------------------------------------------ */
/*  Path helpers                                                       */
/* ------------------------------------------------------------------ */
function resolveDbPath( rawPath: string, vaultRoot: string ): string {
	const isAbs = rawPath.startsWith( "/" ) || /^[A-Za-z]:[\\/]/.test( rawPath );
	if ( isAbs ) return rawPath;
	return vaultRoot.replace( /\/+$/, "" ) + "/" + rawPath;
}

/* ------------------------------------------------------------------ */
/*  Local timestamp with timezone offset                               */
/*  Output: "2026-06-08 15:54:20 +02:00" or "... UTC"                 */
/* ------------------------------------------------------------------ */
function localTimestamp(): string {
	const d = new Date();
	const pad = ( n: number ) => String( n ).padStart( 2, '0' );
	const date = `${d.getFullYear()}-${pad( d.getMonth() + 1 )}-${pad( d.getDate() )}`;
	const time = `${pad( d.getHours() )}:${pad( d.getMinutes() )}:${pad( d.getSeconds() )}`;
	const offsetMin = -d.getTimezoneOffset(); // getTimezoneOffset() is negative east of UTC
	if ( offsetMin === 0 ) return `${date} ${time} UTC`;
	const sign = offsetMin > 0 ? '+' : '-';
	const abs  = Math.abs( offsetMin );
	return `${date} ${time} ${sign}${pad( Math.floor( abs / 60 ) )}:${pad( abs % 60 )}`;
}

/* ------------------------------------------------------------------ */
/*  Markdown table string                                              */
/* ------------------------------------------------------------------ */
function toMarkdownTable( columns: string[], rows: any[][] ): string {
	if ( columns.length === 0 ) return "*No results.*";
	const header = "| " + columns.join( " | " ) + " |";
	const sep    = "| " + columns.map( () => "---" ).join( " | " ) + " |";
	const body   = rows.map( ( row ) =>
		"| " + row.map( ( cell ) => String( cell ?? "" ) ).join( " | " ) + " |"
	).join( "\n" );
	return [ header, sep, body ].join( "\n" );
}

/* ------------------------------------------------------------------ */
/*  Render HTML table with metadata footer                             */
/* ------------------------------------------------------------------ */
function renderTable( el: HTMLElement, columns: string[], rows: any[][], dbName: string, timestamp: string, isStale: boolean, onRefresh: () => void, timerLabel?: string ): string {
	const table = el.createEl( "table" );
	table.addClass( "obs-sqlite-md-table" );

	const thead = table.createEl( "thead" );
	const headerRow = thead.createEl( "tr" );
	for ( const col of columns ) {
		headerRow.createEl( "th", { text: col } );
	}

	const tbody = table.createEl( "tbody" );
	for ( const row of rows ) {
		const tr = tbody.createEl( "tr" );
		for ( const cell of row ) {
			tr.createEl( "td", { text: String( cell ?? "" ) } );
		}
	}

	/* Footer: db name | timestamp | row count */
	const tfoot = table.createEl( "tfoot" );
	const footRow = tfoot.createEl( "tr" );
	footRow.addClass( "obs-sqlite-md-footer" );
	const footCell = footRow.createEl( "td" );
	footCell.setAttribute( "colspan", String( columns.length ) );
	const staleTag = isStale ? " ⚠️ cached" : "";
	const timerTag = timerLabel ? ` · ⏱️ ${timerLabel}` : "";
	const folderBtn = footCell.createEl( "span", { text: "📂", cls: "obs-sqlite-md-footer-btn" } );
	folderBtn.addEventListener( "click", onRefresh );
	footCell.appendText( ` ${dbName} · 🕐 ${timestamp} · ${rows.length} row${rows.length !== 1 ? "s" : ""}${staleTag}${timerTag} ` );
	const cycleBtn = footCell.createEl( "span", { text: "🔄", cls: "obs-sqlite-md-footer-btn" } );
	cycleBtn.addEventListener( "click", onRefresh );

	const md = toMarkdownTable( columns, rows );

	const btnRow = el.createEl( "div", { cls: "obs-sqlite-md-actions" } );
	const copyBtn = btnRow.createEl( "button", { text: "📋 Copy Markdown" } );
	copyBtn.addEventListener( "click", () => {
		navigator.clipboard.writeText( md );
		new Notice( "Markdown table copied!" );
	} );

	return md;
}

/* ------------------------------------------------------------------ */
/*  The Plugin                                                         */
/* ------------------------------------------------------------------ */
export default class ObsSQLiteMdPlugin extends Plugin {

	private sqlEngine: any = null;

	async onload() {

		this.registerMarkdownCodeBlockProcessor( "sql", async ( source, el, ctx ) => {
			await this.renderSqlBlock( source, el, ctx );
		} );

		this.registerMarkdownCodeBlockProcessor( "sqlite", async ( source, el, ctx ) => {
			await this.renderSqlBlock( source, el, ctx );
		} );

		this.registerMarkdownCodeBlockProcessor( "ObsSync", async ( source, el, ctx ) => {
			await this.renderOdbcBlock( source, el, ctx );
		} );
	}

	onunload() {
	}

	private async getSqlEngine(): Promise<any> {
		if ( this.sqlEngine ) return this.sqlEngine;
		this.sqlEngine = await initSqlJs( { wasmBinary: sqlWasm } );
		return this.sqlEngine;
	}

	private getVaultRoot(): string | null {
		const adapter = this.app.vault.adapter;
		if ( adapter instanceof FileSystemAdapter ) {
			return adapter.getBasePath();
		}
		return null;
	}

	/* -------------------------------------------------------------- */
	/*  Write CACHE comment into the code block in the note file       */
	/* -------------------------------------------------------------- */
	private async writeCache( ctx: MarkdownPostProcessorContext, cached: CachedResult, refreshLabel: string | null ): Promise<void> {
		const sectionInfo = ctx.getSectionInfo( ctx.el );
		if ( !sectionInfo ) return;

		const file = this.app.vault.getFileByPath( ctx.sourcePath );
		if ( !file ) return;

		const refreshPart = refreshLabel ? `${refreshLabel} | ` : '';
		const cacheComment = `/* ${refreshPart}CACHE:${JSON.stringify( cached )} */`;

		await this.app.vault.process( file, ( content ) => {
			const lines = content.split( "\n" );
			const startLine = sectionInfo.lineStart; /* opening ``` */
			const endLine = sectionInfo.lineEnd;     /* closing ``` */

			/* Collect block body, stripping any old CACHE comment */
			const bodyLines: string[] = [];
			let inCache = false;
			for ( let i = startLine + 1; i < endLine; i++ ) {
				const line = lines[i];
				if ( /^\/\*\s*(REFRESH:|CACHE:)/i.test( line.trim() ) ) { inCache = true; }
				if ( !inCache ) { bodyLines.push( line ); }
				if ( inCache && line.trim().endsWith( "*/" ) ) { inCache = false; }
			}

			const newBlock = [
				lines[startLine],
				...bodyLines,
				cacheComment,
				lines[endLine],
			];

			const before = lines.slice( 0, startLine );
			const after = lines.slice( endLine + 1 );
			return [ ...before, ...newBlock, ...after ].join( "\n" );
		} );
	}

	/* -------------------------------------------------------------- */
	/*  Core render logic (shared by all block formats)               */
	/* -------------------------------------------------------------- */
	private async renderParsed( parsed: ParsedBlock, el: HTMLElement, ctx: MarkdownPostProcessorContext, forceRefresh = false ): Promise<void> {
		if ( !isReadOnly( parsed.query ) ) {
			el.createEl( "p", { text: "🔒 Read-only queries only. Supported: SELECT, WITH...SELECT, EXPLAIN.", cls: "obs-sqlite-md-help" } );
			return;
		}

		const vaultRoot = this.getVaultRoot();
		if ( !vaultRoot ) {
			/* Mobile: live queries unavailable — show cache if present */
			if ( parsed.cached ) {
				renderTable( el, parsed.cached.columns, parsed.cached.rows,
					parsed.cached.dbName, parsed.cached.timestamp, true,
					() => { new Notice( "📱 Open on desktop to refresh." ); } );
			} else {
				el.createEl( "p", { text: "📱 Open this note on desktop first to populate the cache.", cls: "obs-sqlite-md-help" } );
			}
			return;
		}

		/* Manual refresh mode: show cache without querying unless 🔄 was clicked */
		if ( parsed.refreshMode === 'manual' && !forceRefresh ) {
			if ( parsed.cached ) {
				renderTable( el, parsed.cached.columns, parsed.cached.rows,
					parsed.cached.dbName, parsed.cached.timestamp, true, async () => {
						el.empty();
						await this.renderParsed( parsed, el, ctx, true );
					} );
			} else {
				const msg = el.createEl( "p", { cls: "obs-sqlite-md-help" } );
				msg.appendText( "🗄️ Manual refresh — click " );
				const btn = msg.createEl( "span", { text: "🔄", cls: "obs-sqlite-md-footer-btn" } );
				btn.addEventListener( "click", async () => { el.empty(); await this.renderParsed( parsed, el, ctx, true ); } );
				msg.appendText( " to load data." );
			}
			return;
		}

		/* Desktop only from here — safe to require Node built-ins */
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const fs = require( "fs" ) as typeof import( "fs" );

		const dbPath = resolveDbPath( parsed.dbPath, vaultRoot );
		const dbName = dbPath.split( /[\\/]/ ).pop() || dbPath;
		const dbAvailable = fs.existsSync( dbPath );

		/* ---- DB unavailable: show cached result ---- */
		if ( !dbAvailable ) {
			if ( parsed.cached ) {
				renderTable( el, parsed.cached.columns, parsed.cached.rows,
					parsed.cached.dbName, parsed.cached.timestamp, true, async () => {
						el.empty();
						await this.renderParsed( parsed, el, ctx );
					} );
				return;
			}
			el.createEl( "p", { text: `📂 Database not found: ${dbPath}`, cls: "obs-sqlite-md-help-title" } );
			el.createEl( "p", { text: "Verify the path is correct and the database is accessible. Results will be cached after the first successful query.", cls: "obs-sqlite-md-help" } );
			return;
		}

		/* ---- DB available: run query ---- */
		let db: Database | null = null;
		try {
			const SQL = await this.getSqlEngine();
			const fileBuffer = fs.readFileSync( dbPath );
			db = new SQL.Database( new Uint8Array( fileBuffer ) );

			const results = db.exec( parsed.query );

			if ( results.length === 0 ) {
				el.createEl( "p", { text: "Query returned no results." } );
				return;
			}

			const now = localTimestamp();

			for ( const result of results ) {
				renderTable( el, result.columns, result.values, dbName, now, false, async () => {
					el.empty();
					await this.renderParsed( parsed, el, ctx );
				}, parsed.refreshInterval ? ( parsed.refreshRaw ?? undefined ) : undefined );

				/* Cache result back into the code block */
				const cached: CachedResult = {
					columns: result.columns,
					rows: result.values,
					dbName: dbName,
					timestamp: now,
					rowCount: result.values.length,
				};
				const refreshLabel = parsed.refreshRaw ? `REFRESH:${parsed.refreshRaw}` : null;
				this.writeCache( ctx, cached, refreshLabel ).catch( ( err ) => {
					console.warn( "obs-sqlite-md: cache write failed", err );
				} );
			}

			/* Schedule timed auto-refresh if interval is set */
			if ( parsed.refreshInterval ) {
				window.setTimeout( async () => {
					if ( !el.isConnected ) return;
					el.empty();
					await this.renderParsed( parsed, el, ctx );
				}, parsed.refreshInterval );
			}

		} catch ( err: any ) {
			/* Query error — fall back to cache if available */
			if ( parsed.cached ) {
				el.createEl( "p", { text: `📝 Query issue: ${err.message} — showing last cached result.`, cls: "obs-sqlite-md-help" } );
				renderTable( el, parsed.cached.columns, parsed.cached.rows,
					parsed.cached.dbName, parsed.cached.timestamp, true, async () => {
						el.empty();
						await this.renderParsed( parsed, el, ctx );
					} );
			} else {
				el.createEl( "p", { text: `📝 Query issue: ${err.message}`, cls: "obs-sqlite-md-help-title" } );
				el.createEl( "p", { text: "Check your SQL syntax. Column and table names are case-sensitive in some databases.", cls: "obs-sqlite-md-help" } );
			}
		} finally {
			if ( db ) db.close();
		}
	}

	/* -------------------------------------------------------------- */
	/*  Entry point for sql / sqlite code blocks                      */
	/* -------------------------------------------------------------- */
	private async renderSqlBlock( source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext ): Promise<void> {
		const parsed = parseBlock( source );
		if ( !parsed ) {
			el.createEl( "p", { text: "📖 SQL block format:", cls: "obs-sqlite-md-help-title" } );
			el.createEl( "pre", { text: "db: /path/to/database.db\nSELECT column1, column2 FROM table WHERE condition;", cls: "obs-sqlite-md-help" } );
			return;
		}
		await this.renderParsed( parsed, el, ctx );
	}

	/* -------------------------------------------------------------- */
	/*  Entry point for ObsSync ODBC-style code blocks                */
	/* -------------------------------------------------------------- */
	private async renderOdbcBlock( source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext ): Promise<void> {
		/* Validate driver before full parse */
		const driverMatch = source.match( /\bDRIVER\s*=\s*([^;\n]+)/i );
		const driver = ( driverMatch ? driverMatch[1].trim() : "sqlite" ).toLowerCase();
		if ( driver !== "sqlite" ) {
			el.createEl( "p", { text: `🔌 Unsupported driver: "${driver}". Currently only DRIVER=sqlite is supported.`, cls: "obs-sqlite-md-help" } );
			return;
		}

		const parsed = parseOdbcBlock( source );
		if ( !parsed ) {
			el.createEl( "p", { text: "📖 ObsSync block format:", cls: "obs-sqlite-md-help-title" } );
			el.createEl( "pre", { text: "DRIVER=sqlite;DATABASE=/path/to/file.db;QUERY=SELECT * FROM table", cls: "obs-sqlite-md-help" } );
			return;
		}
		await this.renderParsed( parsed, el, ctx );
	}
}
