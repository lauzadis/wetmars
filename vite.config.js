import { defineConfig } from 'vite';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

// Dev only: serves a locally built tile pyramid (tools/build-tiles) at the given URL prefix.
function localTiles(urlPrefix, dirEnvVar, defaultDir) {
    const root = path.resolve(process.env[dirEnvVar] ?? defaultDir);
    const types = { '.webp': 'image/webp', '.json': 'application/json' };
    return {
        name: `local-tiles${urlPrefix}`,
        configureServer(server) {
            server.middlewares.use(urlPrefix, async (req, res) => {
                // Answer 404 ourselves: falling through would make Vite return index.html with a 200.
                const file = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
                try {
                    if (!file.startsWith(root + path.sep) || !(await stat(file)).isFile()) throw new Error('not found');
                } catch {
                    res.statusCode = 404;
                    return res.end();
                }
                res.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
                res.setHeader('Cache-Control', 'no-cache');
                createReadStream(file).pipe(res);
            });
        },
    };
}

export default defineConfig({
    // Point TILES_DIR / DRY_TILES_DIR at another disk if the tiles don't live in these defaults.
    plugins: [
        localTiles('/tiles', 'TILES_DIR', 'tiles-local'),
        localTiles('/tiles-dry', 'DRY_TILES_DIR', 'tiles-dry-local'),
    ],
});
