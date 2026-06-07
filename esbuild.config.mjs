import esbuild from "esbuild";
import process from "process";
import fs from "fs";

const prod = process.argv[2] === "production";

const wasmPlugin = {
	name: "wasm-loader",
	setup( build ) {
		build.onResolve( { filter: /\.wasm$/ }, ( args ) => {
			return { path: args.path, namespace: "wasm-inline" };
		} );
		build.onLoad( { filter: /.*/, namespace: "wasm-inline" }, async ( args ) => {
			const wasmPath = new URL( args.path, import.meta.url ).pathname;
			// We don't inline wasm — sql.js loads it at runtime
			return { contents: "export default {}", loader: "js" };
		} );
	},
};

const context = await esbuild.context( {
	entryPoints: [ "main.ts" ],
	bundle: true,
	external: [ "obsidian", "electron", "@codemirror/*", "@lezer/*", "fs", "path" ],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
	loader: {
		".wasm": "binary",
	},
	plugins: [],
} );

if ( prod ) {
	await context.rebuild();
	const stat = fs.statSync( "main.js" );
	console.log( `Bundle size: ${( stat.size / 1024 ).toFixed( 1 )} KB` );
	process.exit( 0 );
} else {
	await context.watch();
}
