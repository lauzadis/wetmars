import { defineConfig } from 'vite';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

// Dev only: serves the locally built tile pyramid (tools/build-tiles) at /tiles.
// Point TILES_DIR at another disk if the tiles don't live in ./tiles-local.
function localTiles() {
    const root = path.resolve(process.env.TILES_DIR ?? 'tiles-local');
    const types = { '.webp': 'image/webp', '.json': 'application/json' };
    return {
        name: 'local-tiles',
        configureServer(server) {
            server.middlewares.use('/tiles', async (req, res) => {
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
    plugins: [localTiles()],
});
