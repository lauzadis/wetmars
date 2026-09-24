#!/usr/bin/env node
// Builds the WetMars tile pyramid from Casey Handmer's terraformed-Mars tiles.
// Needs Node 20+ and the `vips` CLI (libvips >= 8.12 with webp support).
//
//   node tools/build-tiles/build.mjs [--out DIR] [--region S,W,SIZE]... [--all] [--no-coarse]
//
// Grid: origin (-256E, 128N), root span 256 deg, level L span = 256 / 2^L deg, 512 px tiles,
// addressed {L}/{x}/{y}.webp with x east from -256, y south from +128.
//   L0-L6 (256 deg .. 4 deg)  global, built from Casey's 10-degree tiles
//   L7-L9 (2, 1, 0.5 deg)     built from his 1-degree tiles, only inside --region boxes (or --all)
// Regions are snapped outwards to even degrees. Re-running skips finished work.

import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const SOURCE = 'https://pub-c9381966294f4a70870d9ee083891ee4.r2.dev/tiles';
const ORIGIN_LON = -256, ORIGIN_LAT = 128, ROOT_SPAN = 256;
const TILE_PX = 512, GLOBAL_MAX = 6, MAX_LEVEL = 9;
const FRAME_PPD = TILE_PX / (ROOT_SPAN / 2 ** GLOBAL_MAX); // 128 px/deg at the finest global level
const QUALITY = 85;

// Default prototype boxes: [south, west, size] in degrees.
const DEFAULT_REGIONS = [
    [14, 72, 10],   // Jezero / Nili Fossae
    [-14, -80, 10], // Melas Chasma, Valles Marineris
    [80, 0, 10],    // north pole edge (equirect stretching)
];

const { values: opts } = parseArgs({
    options: {
        out: { type: 'string', default: process.env.TILES_DIR ?? 'tiles-local' },
        // Downloaded source tiles are kept here, so re-runs never download anything twice.
        source: { type: 'string', default: process.env.SOURCE_DIR },
        region: { type: 'string', multiple: true, default: [] },
        all: { type: 'boolean', default: false },
        'no-coarse': { type: 'boolean', default: false },
        concurrency: { type: 'string', default: '6' },
    },
});
const OUT = path.resolve(opts.out);
const SRC_DIR = path.resolve(opts.source ?? path.join(OUT, '.source'));
const WORK = path.join(OUT, '.work');
const CONCURRENCY = Number(opts.concurrency);

const fmt = (n) => (n < 0 ? '-' : '+') + String(Math.abs(n)).padStart(3, '0');
const tileName = (south, west) => `n${fmt(south)}_e${fmt(west)}`;
const span = (level) => ROOT_SPAN / 2 ** level;

function vips(...args) {
    return new Promise((resolve, reject) => {
        execFile('bash', ['-c', 'ulimit -n 8192 2>/dev/null; exec vips "$@"', 'vips', ...args],
            { env: { ...process.env, VIPS_WARNING: '0' }, maxBuffer: 1 << 26 },
            (err, _out, stderr) => (err ? reject(new Error(`vips ${args.join(' ')}\n${stderr}`)) : resolve()));
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
            if (done % 25 === 0 || done === items.length) process.stdout.write(`\r  ${done}/${items.length}`);
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

// Does grid tile (x, y) at `level` overlap the planet?
function overlapsPlanet(level, x, y) {
    const s = span(level);
    const w = ORIGIN_LON + x * s, n = ORIGIN_LAT - y * s;
    return w < 180 && w + s > -180 && n > -90 && n - s < 90;
}

// ---------- L0-L6: global, from the 10-degree tiles ----------
async function buildCoarse() {
    if (await exists(path.join(OUT, '.coarse-done'))) return console.log('coarse levels: already built');
    console.log('coarse levels: downloading 648 10-degree tiles');
    const rows = [];
    for (let south = 80; south >= -90; south -= 10) {
        for (let west = -180; west < 180; west += 10) rows.push([south, west]);
    }
    const scaled = path.join(WORK, 'l6');
    await mkdir(scaled, { recursive: true });
    await pool(rows, async ([s, w]) => {
        const name = tileName(s, w);
        const src = path.join(SRC_DIR, '10', `${name}.jpg`);
        await download(`${SOURCE}/10/${name}.jpg`, src);
        const dst = path.join(scaled, `${name}.v`);
        if (!(await exists(dst))) await vips('resize', src, dst, String(FRAME_PPD * 10 / 2048), '--kernel', 'lanczos3');
    });

    console.log('coarse levels: mosaic + padding to the grid frame');
    const joined = path.join(WORK, 'global.v');
    const frame = path.join(WORK, 'frame.v');
    await vips('arrayjoin', rows.map(([s, w]) => path.join(scaled, `${tileName(s, w)}.v`)).join(' '), joined, '--across', '36');
    await vips('embed', joined, frame,
        String((-180 - ORIGIN_LON) * FRAME_PPD), String((ORIGIN_LAT - 90) * FRAME_PPD),
        String(2 * ROOT_SPAN * FRAME_PPD), String(ROOT_SPAN * FRAME_PPD), '--extend', 'copy');

    console.log('coarse levels: slicing pyramid');
    const dz = path.join(WORK, 'dz');
    await rm(dz, { recursive: true, force: true });
    await vips('dzsave', frame, dz, ...dzOpts);
    // dz level z has 2^(z-1) grid rows; z=0 is a single 512x256 tile we don't use.
    for (let z = 1; z <= GLOBAL_MAX + 1; z++) {
        const level = z - 1;
        for (const yDir of await readdir(path.join(dz, String(z)))) {
            for (const file of await readdir(path.join(dz, String(z), yDir))) {
                const x = parseInt(file, 10), y = Number(yDir);
                if (overlapsPlanet(level, x, y)) await moveTile(path.join(dz, String(z), yDir, file), level, x, y);
            }
        }
    }
    await rm(WORK, { recursive: true, force: true });
    await writeFile(path.join(OUT, '.coarse-done'), '');
}

// ---------- L7-L9: 2x2-degree blocks from the 1-degree tiles ----------
async function buildBlock([south, west]) {
    const marker = path.join(OUT, '7', String((west - ORIGIN_LON) / span(7)), `${(ORIGIN_LAT - (south + 2)) / span(7)}.webp`);
    if (await exists(marker)) return;
    const cells = [[south + 1, west], [south + 1, west + 1], [south, west], [south, west + 1]]; // NW NE SW SE
    const work = path.join(WORK, `block_${tileName(south, west)}`);
    await mkdir(work, { recursive: true });
    const scaled = await Promise.all(cells.map(async ([s, w]) => {
        const name = tileName(s, w);
        const src = path.join(SRC_DIR, '1', `${name}.jpg`);
        await download(`${SOURCE}/1/${name}.jpg`, src);
        const dst = path.join(work, `${name}.v`);
        await vips('thumbnail', src, dst, '1024', '--height', '1024', '--size', 'force'); // 4096 -> 1024, JPEG shrink-on-load
        return dst;
    }));
    const block = path.join(work, 'block.v');
    await vips('arrayjoin', scaled.join(' '), block, '--across', '2');
    const dz = path.join(work, 'dz');
    await vips('dzsave', block, dz, ...dzOpts);
    // dz levels 0..2 -> grid levels 7..9. Finest first: the L7 tile is the "block done" marker, so it must land last.
    for (let z = 2; z >= 0; z--) {
        const level = 7 + z, s = span(level);
        const x0 = (west - ORIGIN_LON) / s, y0 = (ORIGIN_LAT - (south + 2)) / s;
        for (const yDir of await readdir(path.join(dz, String(z)))) {
            for (const file of await readdir(path.join(dz, String(z), yDir))) {
                await moveTile(path.join(dz, String(z), yDir, file), level, x0 + parseInt(file, 10), y0 + Number(yDir));
            }
        }
    }
    await rm(work, { recursive: true, force: true });
}

function snapRegion(south, west, size) {
    const s = Math.max(-90, Math.floor(south / 2) * 2), w = Math.max(-180, Math.floor(west / 2) * 2);
    const n = Math.min(90, Math.ceil((south + size) / 2) * 2), e = Math.min(180, Math.ceil((west + size) / 2) * 2);
    return { south: s, west: w, north: n, east: e };
}

async function main() {
    await mkdir(OUT, { recursive: true });
    console.log(`output: ${OUT}`);
    if (!opts['no-coarse']) await buildCoarse();

    let detail;
    if (opts.all) {
        detail = 'all';
    } else {
        const specs = opts.region.length ? opts.region.map((r) => r.split(',').map(Number)) : DEFAULT_REGIONS;
        detail = specs.map(([s, w, size]) => snapRegion(s, w, size));
    }
    const boxes = detail === 'all' ? [{ south: -90, west: -180, north: 90, east: 180 }] : detail;
    const blocks = new Set();
    for (const b of boxes) {
        for (let s = b.south; s < b.north; s += 2) for (let w = b.west; w < b.east; w += 2) blocks.add(`${s},${w}`);
    }
    const list = [...blocks].map((k) => k.split(',').map(Number));
    console.log(`fine levels: ${list.length} 2-degree blocks (${list.length * 4} source tiles)`);
    // A block that keeps failing shouldn't kill a multi-hour run; report it and let a re-run pick it up.
    const failed = [];
    await pool(list, async (block) => {
        try {
            await buildBlock(block);
        } catch (err) {
            failed.push(block);
            console.error(`\nblock ${block} failed: ${err.message.split('\n')[0]}`);
        }
    });
    if (failed.length) {
        console.error(`${failed.length} blocks failed; re-run the same command to retry them. tiles.json not updated.`);
        process.exit(1);
    }

    await writeFile(path.join(OUT, 'tiles.json'), JSON.stringify({
        version: 1,
        format: 'webp',
        tilePx: TILE_PX,
        origin: { lon: ORIGIN_LON, lat: ORIGIN_LAT },
        rootSpan: ROOT_SPAN,
        extent: { west: -180, east: 180, south: -90, north: 90 },
        maxLevel: MAX_LEVEL,
        globalMaxLevel: GLOBAL_MAX,
        // Levels above globalMaxLevel exist only inside these boxes (or everywhere when "all").
        detail: detail === 'all' ? 'all' : detail.map((b) => [b.west, b.south, b.east, b.north]),
        attribution: 'Terraformed Mars render by Casey Handmer',
    }, null, 2));
    await rm(WORK, { recursive: true, force: true });
    console.log('done');
}

main().catch((err) => { console.error(err); process.exit(1); });
