#!/usr/bin/env node
// Builds a dry-Mars tile pyramid from real Mars imagery, instead of Casey Handmer's flood-
// simulation render: THEMIS Day IR (real photographic-ish surface detail, USGS's official 100
// m/px global mosaic v12) is used as luminance, colorized with the Viking Global Color Mosaic
// (real color, 925 m/px, USGS) as chrominance — the same pan-sharpening approach Casey uses for
// his own "unflooded" base color. Needs Node 20+ and the `vips` CLI.
//
// An earlier version of this script built its own THEMIS mosaic from 72 separate 256-ppd tiles
// (ASU's 2006 release); that source turned out to have severe polar coverage gaps (~30%+ of a
// tile near 60N/S, vs <1.2% near the equator — real satellite orbit-track gaps, not a processing
// bug). USGS's official v12 mosaic (a different, more thoroughly-blended release) cuts that to
// ~9% near the poles. It ships as one 21GB GeoTIFF rather than small tiles — download it yourself
// (see the README note below) and point --themis-tif at it.
//
//   node tools/build-tiles/build-dry.mjs --themis-tif /path/to/themis_100m_v12.tif [--out DIR]
//
// Source: https://planetarymaps.usgs.gov/mosaic/Mars_MO_THEMIS-IR-Day_mosaic_global_100m_v12.tif
// (21.2 GiB; USGS, public domain, "please cite authors" — see Edwards et al. 2011, JGR 116,
// E10008). Simple Cylindrical, planetocentric, longitude 0-360E, 213390x106696px.
//
// Grid: same convention as build.mjs (wet) — origin (-256E, 128N), root span 256 deg, 512 px
// tiles — so a lon/lat box maps to the same {level}/{x}/{y} in both pyramids, even though each
// has its own self-describing tiles.json. Finest level is L7 (2 deg tiles, 256 px/deg = ~231
// m/px) — the same detail level originally targeted from the old ASU tiles, just from the
// cleaner source. Deliberately much coarser than wet's L9 finest of ~58 m/px, and a bit coarser
// than this source's true 100 m/px native (matching that exactly isn't a clean fit for this
// power-of-two tile grid, and would be ~16x the processing below instead of ~4x).

import { execFile } from 'node:child_process';
import { mkdir, rename, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const VIKING_COLOR_URL = 'https://planetarymaps.usgs.gov/mosaic/Mars_Viking_ClrMosaic_global_925m.tif';

const ORIGIN_LON = -256, ORIGIN_LAT = 128, ROOT_SPAN = 256; // matches build.mjs
const TILE_PX = 512, MAX_LEVEL = 7;
const FRAME_PPD = TILE_PX * 2 ** MAX_LEVEL / ROOT_SPAN; // 256 px/deg -> ~231 m/px
const QUALITY = 85;

const { values: opts } = parseArgs({
    options: {
        out: { type: 'string', default: process.env.DRY_TILES_DIR ?? 'tiles-dry-local' },
        'themis-tif': { type: 'string', default: process.env.THEMIS_TIF },
        source: { type: 'string', default: process.env.SOURCE_DIR }, // only for the small Viking download
        concurrency: { type: 'string', default: '6' },
    },
});
if (!opts['themis-tif']) {
    console.error('Missing --themis-tif (or THEMIS_TIF env var) — see this file\'s header for the download URL.');
    process.exit(1);
}
const OUT = path.resolve(opts.out);
const THEMIS_TIF = path.resolve(opts['themis-tif']);
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

function vipsAvg(file) {
    return new Promise((resolve, reject) => {
        execFile('vips', ['avg', file], { env: { ...process.env, VIPS_WARNING: '0' } },
            (err, stdout) => (err ? reject(err) : resolve(Number(stdout.trim()))));
    });
}

const exists = (p) => stat(p).then(() => true, () => false);
const rmQuiet = (f) => rm(f, { force: true });

// For resuming after a crash/kill: a .v file can exist with a correct-looking header (vipsheader
// succeeds) while its pixel data is truncated (vips-sequential writes aren't atomic) — this reads
// a pixel to be sure, so a truncated file from an interrupted run gets regenerated, not reused.
async function isReadable(file) {
    if (!(await exists(file))) return false;
    try {
        await vipsAvg(file);
        return true;
    } catch {
        return false;
    }
}

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

/**
 * Resizes the source GeoTIFF straight to the target grid resolution (skipping any intermediate
 * full-native-resolution step — at 213390x106696px that would be needlessly expensive), then
 * re-centers it: the source ships in 0-360 longitude order, so swapping its two halves gives the
 * -180..180 order our grid uses.
 */
async function buildThemis(targetWidth, targetHeight) {
    const recentered = path.join(WORK, 'themis_recentered.v'); // now spans -180..180
    if (await isReadable(recentered)) {
        console.log('THEMIS mosaic already built, reusing it');
        return { file: recentered, width: targetWidth, height: targetHeight };
    }

    console.log(`resizing THEMIS source to ${targetWidth}x${targetHeight}`);
    const resized = path.join(WORK, 'themis_0_360.v');
    await vips('thumbnail', THEMIS_TIF, resized, String(targetWidth), '--height', String(targetHeight), '--size', 'force');

    console.log('re-centering to -180..180');
    const half = targetWidth / 2;
    const left = path.join(WORK, 'themis_left.v');   // lon 0..180
    const right = path.join(WORK, 'themis_right.v'); // lon 180..360 == -180..0
    await vips('crop', resized, left, '0', '0', String(half), String(targetHeight));
    await vips('crop', resized, right, String(half), '0', String(half), String(targetHeight));
    await vips('arrayjoin', `${right} ${left}`, recentered, '--across', '2');
    await Promise.all([resized, left, right].map(rmQuiet));
    return { file: recentered, width: targetWidth, height: targetHeight };
}

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
    const colorFull = path.join(WORK, 'color_full.v');
    if (await isReadable(colorFull)) {
        console.log('colorizing already done, reusing it');
        return colorFull;
    }

    const cellSize = 3840; // divides themis.width/height evenly
    const cols = themis.width / cellSize, rows = themis.height / cellSize;
    const rowFile = (r) => path.join(WORK, `color_row_${r}.v`);
    const vikingFull = path.join(WORK, 'viking_full.v');

    // Skip whole rows that are already built (and, within them, never re-request pieces that were
    // already deleted after that row was assembled — the point of checking row-completeness first).
    // Also means vikingFull is never touched at all when every row is already done, so a resumed
    // run that only needs the final join doesn't waste time re-verifying/rebuilding a ~13GB file
    // it no longer needs — this is what made the previous attempt redo the Viking resize pointlessly.
    const rowDone = await Promise.all(Array.from({ length: rows }, (_, r) => isReadable(rowFile(r))));
    const pendingRows = Array.from({ length: rows }, (_, r) => r).filter((r) => !rowDone[r]);

    if (pendingRows.length) {
        // vips multiply needs pixel-exact matching dimensions; Viking's aspect ratio isn't *exactly*
        // 2:1, so a uniform scale factor could land a pixel or two off. --size force pins the output
        // to the THEMIS mosaic's exact width/height (the tiny non-uniform stretch is invisible here).
        if (await isReadable(vikingFull)) {
            console.log('Viking resize already done, reusing it');
        } else {
            console.log('resizing Viking color to match THEMIS resolution');
            await vips('thumbnail', path.join(SRC_DIR, 'viking_color.tif'), vikingFull, String(themis.width),
                '--height', String(themis.height), '--size', 'force');
        }

        const mean = await vipsAvg(themis.file);
        console.log(`colorizing ${rows - pendingRows.length}/${rows} rows already done; `
            + `processing ${pendingRows.length} more (${cols} pieces each, global THEMIS mean ${mean.toFixed(1)})`);

        const pieceFile = (r, c) => path.join(WORK, `piece_${r}_${c}.v`);
        const cells = [];
        for (const r of pendingRows) for (let c = 0; c < cols; c++) cells.push([r, c]);

        await pool(cells, async ([r, c]) => {
            if (await isReadable(pieceFile(r, c))) return; // resuming a previous run that got this far
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
        }, 2); // lower than the general default: this machine hit an OOM kill at concurrency 4, likely
        // from memory pressure elsewhere on the system (lots of open browser tabs) rather than this
        // loop alone, but there's no reason to push it

        console.log('reassembling colorized pieces');
        for (const r of pendingRows) {
            const rowPieces = Array.from({ length: cols }, (_, c) => pieceFile(r, c));
            await vips('arrayjoin', rowPieces.join(' '), rowFile(r), '--across', String(cols));
            await Promise.all(rowPieces.map(rmQuiet));
        }
    } else {
        console.log(`colorizing already done (all ${rows} rows), skipping to final join`);
    }

    const rowFiles = Array.from({ length: rows }, (_, r) => rowFile(r));
    await vips('arrayjoin', rowFiles.join(' '), colorFull, '--across', '1');
    await Promise.all([...rowFiles, vikingFull].map(rmQuiet));
    return colorFull;
}

async function main() {
    await mkdir(OUT, { recursive: true });
    await mkdir(WORK, { recursive: true });
    console.log(`output: ${OUT}`);
    console.log(`themis source: ${THEMIS_TIF}`);

    console.log('downloading Viking Global Color Mosaic (~800 MB)');
    await download(VIKING_COLOR_URL, path.join(SRC_DIR, 'viking_color.tif'));

    const targetWidth = 360 * FRAME_PPD, targetHeight = 180 * FRAME_PPD;
    const themis = await buildThemis(targetWidth, targetHeight);

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
        attribution: 'THEMIS Day IR global mosaic v12 (USGS/ASU) colorized with the Viking Global Color Mosaic (USGS)',
    }, null, 2));

    await rm(WORK, { recursive: true, force: true });
    console.log('done');
}

main().catch((err) => { console.error(err); process.exit(1); });
