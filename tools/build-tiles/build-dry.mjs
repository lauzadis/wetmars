#!/usr/bin/env node
// Builds a dry-Mars tile pyramid from real Mars imagery, instead of Casey Handmer's flood-
// simulation render: THEMIS Day IR (real photographic-ish surface detail, native 230 m/px, ASU)
// is used as luminance, colorized with the Viking Global Color Mosaic (real color, 925 m/px,
// USGS) as chrominance — the same pan-sharpening approach Casey uses for his own "unflooded" base
// color. Needs Node 20+ and the `vips` CLI.
//
//   node tools/build-tiles/build-dry.mjs [--out DIR] [--source DIR]
//
// Grid: same convention as build.mjs (wet) — origin (-256E, 128N), root span 256 deg, 512 px
// tiles — so a lon/lat box maps to the same {level}/{x}/{y} in both pyramids, even though each
// has its own self-describing tiles.json. Finest level is L6 (4 deg tiles, 128 px/deg = ~463
// m/px — THEMIS's native 230 m/px halved). Deliberately much coarser than wet's L9 finest of ~58
// m/px, and than THEMIS's own native resolution: this pipeline's costly steps (colorizing, and
// padding to the doubled-width grid frame) scale with total pixel count, and on this machine's
// disk throughput, doing them at full 230 m/px took an estimated 7+ hours. Halving each dimension
// cuts that 4x.

import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const THEMIS_BASE = 'https://www.mars.asu.edu/data/thm_dir/large';
const VIKING_COLOR_URL = 'https://planetarymaps.usgs.gov/mosaic/Mars_Viking_ClrMosaic_global_925m.tif';

const ORIGIN_LON = -256, ORIGIN_LAT = 128, ROOT_SPAN = 256; // matches build.mjs
const TILE_PX = 512, MAX_LEVEL = 6;
const FRAME_PPD = TILE_PX * 2 ** MAX_LEVEL / ROOT_SPAN; // 128 px/deg — half THEMIS's native 256 ppd
const QUALITY = 85;

const { values: opts } = parseArgs({
    options: {
        out: { type: 'string', default: process.env.DRY_TILES_DIR ?? 'tiles-dry-local' },
        source: { type: 'string', default: process.env.SOURCE_DIR },
        concurrency: { type: 'string', default: '6' },
    },
});
const OUT = path.resolve(opts.out);
const SRC_DIR = path.resolve(opts.source ?? path.join(OUT, '.source'));
const WORK = path.join(OUT, '.work');
const CONCURRENCY = Number(opts.concurrency);

function vips(...args) {
    return new Promise((resolve, reject) => {
        execFile('bash', ['-c', 'ulimit -n 8192 2>/dev/null; exec vips "$@"', 'vips', ...args],
            { env: { ...process.env, VIPS_WARNING: '0' }, maxBuffer: 1 << 26 },
            (err, _out, stderr) => (err ? reject(new Error(`vips ${args.join(' ')}\n${stderr}`)) : resolve()));
    });
}

function vipsField(file, field) {
    return new Promise((resolve, reject) => {
        execFile('vipsheader', ['-f', field, file], { env: { ...process.env, VIPS_WARNING: '0' } },
            (err, stdout) => (err ? reject(err) : resolve(stdout.trim())));
    });
}

const exists = (p) => stat(p).then(() => true, () => false);

async function pool(items, worker, limit = CONCURRENCY) {
    let next = 0, done = 0;
    const run = async () => {
        while (next < items.length) {
            const i = next++;
            await worker(items[i], i);
            done++;
            if (done % 10 === 0 || done === items.length) process.stdout.write(`\r  ${done}/${items.length}`);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    process.stdout.write('\n');
}

async function download(url, dest) {
    if (await exists(dest)) return;
    await mkdir(path.dirname(dest), { recursive: true });
    for (let attempt = 1; ; attempt++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            await pipeline(Readable.fromWeb(res.body), createWriteStream(dest + '.part'));
            await rename(dest + '.part', dest);
            return;
        } catch (err) {
            if (attempt >= 5) throw new Error(`download failed: ${url}: ${err.message}`);
            await new Promise((r) => setTimeout(r, 1000 * attempt ** 2));
        }
    }
}

const dzOpts = ['--layout', 'google', '--tile-size', String(TILE_PX), '--overlap', '0', '--depth', 'onetile',
    '--suffix', `.webp[Q=${QUALITY},strip]`];

async function moveTile(from, level, x, y) {
    const to = path.join(OUT, String(level), String(x), `${y}.webp`);
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
}

function overlapsPlanet(level, x, y) {
    const s = ROOT_SPAN / 2 ** level;
    const w = ORIGIN_LON + x * s, n = ORIGIN_LAT - y * s;
    return w < 180 && w + s > -180 && n > -90 && n - s < 90;
}

const themisName = (lat, lon) => `thm_dir_N${lat === 0 ? '00' : lat}_${String(lon).padStart(3, '0')}.png`;

async function downloadSources() {
    console.log('downloading 72 THEMIS Day IR tiles (~2.2 GB)');
    const lats = [-90, -60, -30, 0, 30, 60]; // south edge of each 30-degree row
    const lons360 = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330]; // THEMIS's own 0-360 numbering
    const cells = [];
    for (const lat of lats) for (const lon of lons360) cells.push([lat, lon]);
    await pool(cells, ([lat, lon]) => {
        const name = themisName(lat, lon);
        return download(`${THEMIS_BASE}/${name}`, path.join(SRC_DIR, 'themis', name));
    });

    console.log('downloading Viking Global Color Mosaic (~800 MB)');
    await download(VIKING_COLOR_URL, path.join(SRC_DIR, 'viking_color.tif'));
    return { lats, lons360 };
}

// THEMIS ships in 0-360 longitude order; re-center the mosaic to -180..180 by swapping halves.
async function buildThemisMosaic(lats, lons360) {
    console.log('mosaicking THEMIS tiles');
    const rows = [];
    for (const lat of lats) {
        const files = lons360.map((lon) => path.join(SRC_DIR, 'themis', themisName(lat, lon)));
        const row = path.join(WORK, `themis_row_${lat}.v`);
        await vips('arrayjoin', files.join(' '), row, '--across', String(lons360.length));
        rows.push(row);
    }
    // lats is south-to-north; arrayjoin wants rows top(north)-to-bottom(south).
    const global360 = path.join(WORK, 'themis_0_360.v');
    await vips('arrayjoin', [...rows].reverse().join(' '), global360, '--across', '1');

    const width = Number(await vipsField(global360, 'width'));
    const height = Number(await vipsField(global360, 'height'));
    const half = width / 2;
    const left = path.join(WORK, 'themis_left.v');   // lon 0..180
    const right = path.join(WORK, 'themis_right.v'); // lon 180..360 == -180..0
    await vips('crop', global360, left, '0', '0', String(half), String(height));
    await vips('crop', global360, right, String(half), '0', String(half), String(height));
    const recentered = path.join(WORK, 'themis_recentered.v'); // now spans -180..180
    await vips('arrayjoin', `${right} ${left}`, recentered, '--across', '2');
    await Promise.all([...rows, global360, left, right].map((f) => rm(f, { force: true })));
    return { file: recentered, width, height };
}

function vipsAvg(file) {
    return new Promise((resolve, reject) => {
        execFile('vips', ['avg', file], { env: { ...process.env, VIPS_WARNING: '0' } },
            (err, stdout) => (err ? reject(err) : resolve(Number(stdout.trim()))));
    });
}

const rmQuiet = (f) => rm(f, { force: true });

/**
 * Viking color (925 m/px) becomes chrominance; THEMIS becomes luminance, via a hillshade-style
 * multiply (output = color * themis/mean(themis)) rather than a strict HSV V-channel swap, since
 * that doesn't require radiometrically matching two different instruments' brightness scales.
 *
 * Done one grid cell at a time rather than as one full-planet operation: `vips multiply` promotes
 * uchar*float to float, and at full-planet size that intermediate alone would be tens of GB. Each
 * `vips` CLI call round-trips through disk, so this trades some total I/O for never needing more
 * than a few hundred MB resident at once — worth it since disk space, not raw throughput, was the
 * binding constraint here.
 */
async function colorize(themis) {
    console.log('resizing Viking color to match THEMIS resolution');
    // vips multiply needs pixel-exact matching dimensions; Viking's aspect ratio isn't *exactly*
    // 2:1, so a uniform scale factor could land a pixel or two off. --size force pins the output
    // to the THEMIS mosaic's exact width/height (the tiny non-uniform stretch is invisible here).
    const vikingFull = path.join(WORK, 'viking_full.v');
    await vips('thumbnail', path.join(SRC_DIR, 'viking_color.tif'), vikingFull, String(themis.width),
        '--height', String(themis.height), '--size', 'force');

    const mean = await vipsAvg(themis.file);
    const cellSize = 3840; // divides themis.width/height evenly, giving the same 6x12 grid as build.mjs's blocks
    const cols = themis.width / cellSize, rows = themis.height / cellSize;
    console.log(`colorizing in ${rows}x${cols} pieces (global THEMIS mean ${mean.toFixed(1)})`);

    const cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
    const pieceFile = (r, c) => path.join(WORK, `piece_${r}_${c}.v`);

    await pool(cells, async ([r, c]) => {
        const x = c * cellSize, y = r * cellSize;
        const tag = `${r}_${c}`;
        const themisCell = path.join(WORK, `tc_${tag}.v`), vikingCell = path.join(WORK, `vc_${tag}.v`);
        await vips('crop', themis.file, themisCell, String(x), String(y), String(cellSize), String(cellSize));
        await vips('crop', vikingFull, vikingCell, String(x), String(y), String(cellSize), String(cellSize));

        const ratio = path.join(WORK, `ratio_${tag}.v`); // themis / mean(themis), float, values around 1.0
        await vips('linear', themisCell, ratio, String(1 / mean), '0');
        const blended = path.join(WORK, `blended_${tag}.v`); // uchar x float -> float; small enough per-cell to be fine
        await vips('multiply', vikingCell, ratio, blended);
        const cast = path.join(WORK, `cast_${tag}.v`);
        await vips('cast', blended, cast, 'uchar'); // clips out-of-range floats (e.g. bright ratio outliers)

        // THEMIS has real data gaps (satellite orbit-track seams, no alpha channel — a genuine
        // value of 0), which the multiply above would otherwise render as solid black. Falling
        // back to plain Viking color there reads as an unremarkable flat patch instead of a hole.
        const nodata = path.join(WORK, `nodata_${tag}.v`);
        await vips('relational_const', themisCell, nodata, 'lesseq', '1');
        await vips('ifthenelse', nodata, vikingCell, cast, pieceFile(r, c));

        await Promise.all([themisCell, vikingCell, ratio, blended, cast, nodata].map(rmQuiet));
    }, 4);

    console.log('reassembling colorized pieces');
    const rowFiles = [];
    for (let r = 0; r < rows; r++) {
        const rowFile = path.join(WORK, `color_row_${r}.v`);
        const rowPieces = Array.from({ length: cols }, (_, c) => pieceFile(r, c));
        await vips('arrayjoin', rowPieces.join(' '), rowFile, '--across', String(cols));
        await Promise.all(rowPieces.map(rmQuiet));
        rowFiles.push(rowFile);
    }
    const colorFull = path.join(WORK, 'color_full.v');
    await vips('arrayjoin', rowFiles.join(' '), colorFull, '--across', '1');
    await Promise.all([...rowFiles, vikingFull].map(rmQuiet));
    return colorFull;
}

async function main() {
    await mkdir(OUT, { recursive: true });
    await mkdir(WORK, { recursive: true });
    console.log(`output: ${OUT}`);

    const { lats, lons360 } = await downloadSources();
    const themisNative = await buildThemisMosaic(lats, lons360);
    console.log('downsampling THEMIS 2x to the target resolution');
    const themisHalf = path.join(WORK, 'themis_half.v');
    await vips('resize', themisNative.file, themisHalf, '0.5', '--kernel', 'lanczos3');
    await rm(themisNative.file, { force: true });
    const themis = { file: themisHalf, width: themisNative.width / 2, height: themisNative.height / 2 };

    const colorImage = await colorize(themis);
    await rm(themis.file, { force: true });

    console.log('padding to the grid frame');
    const frame = path.join(WORK, 'frame.v');
    await vips('embed', colorImage, frame,
        String((-180 - ORIGIN_LON) * FRAME_PPD), String((ORIGIN_LAT - 90) * FRAME_PPD),
        String(2 * ROOT_SPAN * FRAME_PPD), String(ROOT_SPAN * FRAME_PPD), '--extend', 'copy');
    await rm(colorImage, { force: true });

    console.log('slicing pyramid');
    const dz = path.join(WORK, 'dz');
    await rm(dz, { recursive: true, force: true });
    await vips('dzsave', frame, dz, ...dzOpts);
    await rm(frame, { force: true });
    for (let z = 1; z <= MAX_LEVEL + 1; z++) {
        const level = z - 1;
        for (const yDir of await readdir(path.join(dz, String(z)))) {
            for (const file of await readdir(path.join(dz, String(z), yDir))) {
                const x = parseInt(file, 10), y = Number(yDir);
                if (overlapsPlanet(level, x, y)) await moveTile(path.join(dz, String(z), yDir, file), level, x, y);
            }
        }
    }

    await writeFile(path.join(OUT, 'tiles.json'), JSON.stringify({
        version: 1,
        format: 'webp',
        tilePx: TILE_PX,
        origin: { lon: ORIGIN_LON, lat: ORIGIN_LAT },
        rootSpan: ROOT_SPAN,
        extent: { west: -180, east: 180, south: -90, north: 90 },
        maxLevel: MAX_LEVEL,
        globalMaxLevel: MAX_LEVEL, // uniform coverage everywhere, no partial-detail regions
        detail: 'all',
        attribution: 'THEMIS Day IR (ASU) colorized with the Viking Global Color Mosaic (USGS)',
    }, null, 2));

    await rm(WORK, { recursive: true, force: true });
    console.log('done');
}

main().catch((err) => { console.error(err); process.exit(1); });
