/**
 * Test: does sql.js (WASM SQLite) use indexes?
 *
 * Run:  node tests/test_index.mjs
 *
 * This loads the test.db via sql.js and runs EXPLAIN QUERY PLAN
 * to prove the WASM engine uses the same indexes as native SQLite.
 */
import initSqlJs from "sql.js";
import fs from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname( fileURLToPath( import.meta.url ) );
const dbPath = path.join( __dirname, "..", "test.db" );

async function main() {
	const SQL = await initSqlJs();
	const fileBuffer = fs.readFileSync( dbPath );
	const db = new SQL.Database( new Uint8Array( fileBuffer ) );

	console.log( "=== Tables ===" );
	const tables = db.exec( "SELECT name FROM sqlite_master WHERE type='table';" );
	console.log( tables[0].values.flat().join( ", " ) );

	console.log( "\n=== EXPLAIN QUERY PLAN: indexed column (department) ===" );
	const plan1 = db.exec( "EXPLAIN QUERY PLAN SELECT name, salary FROM employees WHERE department='Engineering';" );
	console.log( plan1[0].columns.join( " | " ) );
	for ( const row of plan1[0].values ) {
		console.log( row.join( " | " ) );
	}

	console.log( "\n=== EXPLAIN QUERY PLAN: indexed column (salary range) ===" );
	const plan2 = db.exec( "EXPLAIN QUERY PLAN SELECT name, department FROM employees WHERE salary > 100000;" );
	console.log( plan2[0].columns.join( " | " ) );
	for ( const row of plan2[0].values ) {
		console.log( row.join( " | " ) );
	}

	console.log( "\n=== EXPLAIN QUERY PLAN: non-indexed column (name) ===" );
	const plan3 = db.exec( "EXPLAIN QUERY PLAN SELECT * FROM employees WHERE name='Alice Chen';" );
	console.log( plan3[0].columns.join( " | " ) );
	for ( const row of plan3[0].values ) {
		console.log( row.join( " | " ) );
	}

	console.log( "\n=== Query result as markdown table ===" );
	const result = db.exec( "SELECT name, department, salary FROM employees WHERE department='Engineering' ORDER BY salary DESC;" );
	const cols = result[0].columns;
	const rows = result[0].values;

	console.log( "| " + cols.join( " | " ) + " |" );
	console.log( "| " + cols.map( () => "---" ).join( " | " ) + " |" );
	for ( const row of rows ) {
		console.log( "| " + row.map( ( c ) => String( c ?? "" ) ).join( " | " ) + " |" );
	}

	db.close();
	console.log( "\n✅ All tests passed." );
}

main().catch( ( err ) => {
	console.error( "❌ Test failed:", err );
	process.exit( 1 );
} );
