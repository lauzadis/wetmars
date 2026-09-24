import * as THREE from 'three';
import { TileLoader } from './TileLoader.js';

const DEG = Math.PI / 180;
const MAX_UPLOADS_PER_FRAME = 3;
const RETRY_MS = 4000;

const VERTEX = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

// Tiles are sRGB; sampling decodes to linear (texture.colorSpace) and the include re-encodes for output.
const FRAGMENT = `
    uniform sampler2D map;
    varying vec2 vUv;
    void main() {
        gl_FragColor = vec4(texture2D(map, vUv).rgb, 1.0);
        #include <colorspace_fragment>
    }
`;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Same lon/lat -> sphere mapping as THREE.SphereGeometry with an equirectangular texture (lon -180 at u=0). */
function lonLatToVec(lon, lat, out) {
    const phi = (lon + 180) * DEG, latR = lat * DEG, cosLat = Math.cos(latR);
    return out.set(-Math.cos(phi) * cosLat, Math.sin(latR), Math.sin(phi) * cosLat);
}

/**
 * Streams a tile pyramid (built by tools/build-tiles) onto a unit sphere.
 * A quadtree over lon/lat tiles is refined where a texel would cover more than `pixelError` screen pixels.
 * A parent stays on screen until all visible children are loaded, so there are never holes.
 */
export class TileGlobe {
    constructor({ baseUrl, maxTextures = 220, pixelError = 1.2 }) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.maxTextures = maxTextures;
        this.pixelError = pixelError;
        this.group = new THREE.Group();
        this.meta = null;
        this.nodes = new Map();
        this.roots = [];
        this.ready = new Set();
        this.pending = [];
        this.renderList = [];
        this.shown = [];
        this.frame = 0;
        this.stats = { rendered: 0, finestLevel: 0, textures: 0, loading: 0, queued: 0 };
        this.whenReady = new Promise((resolve) => { this.resolveReady = resolve; });

        this.loader = new TileLoader({
            onLoad: (key, bitmap) => {
                const node = this.nodes.get(key);
                if (!node) return bitmap.close();
                node.state = 'pending';
                this.pending.push({ node, bitmap });
            },
            onError: (key, status) => {
                const node = this.nodes.get(key);
                if (!node) return;
                node.state = 'failed';
                node.retryAt = status === 404 ? Infinity : performance.now() + RETRY_MS;
            },
            onCancel: (key) => {
                const node = this.nodes.get(key);
                if (node && node.state === 'queued') node.state = 'empty';
            },
        });

        this.frustum = new THREE.Frustum();
        this.matrix = new THREE.Matrix4();
        this.camPos = new THREE.Vector3();
        this.camDir = new THREE.Vector3();
        this.size = new THREE.Vector2();
    }

    async init() {
        const res = await fetch(`${this.baseUrl}/tiles.json`);
        if (!res.ok) throw new Error(`tiles.json: HTTP ${res.status}`);
        this.meta = await res.json();
        for (let x = 0; x < 2; x++) {
            if (this.overlapsPlanet(0, x, 0)) this.roots.push(this.node(0, x, 0));
        }
    }

    get attribution() {
        return this.meta?.attribution;
    }

    /** The grid is padded past the planet; does this tile overlap it at all? */
    overlapsPlanet(level, x, y) {
        const { origin, rootSpan, extent } = this.meta;
        const span = rootSpan / 2 ** level;
        const west = origin.lon + x * span, north = origin.lat - y * span;
        return west < extent.east && west + span > extent.west && north > extent.south && north - span < extent.north;
    }

    /** Is this tile part of the built pyramid? Fine levels may only exist inside some boxes. */
    isCovered(level, x, y) {
        const { origin, rootSpan, globalMaxLevel, detail } = this.meta;
        if (level <= globalMaxLevel || detail === 'all') return true;
        const span = rootSpan / 2 ** level;
        const west = origin.lon + x * span, north = origin.lat - y * span;
        return detail.some(([w, s, e, n]) => west >= w && west + span <= e && north - span >= s && north <= n);
    }

    node(level, x, y) {
        const key = `${level}/${x}/${y}`;
        let node = this.nodes.get(key);
        if (node) return node;

        const { origin, rootSpan, extent } = this.meta;
        const span = rootSpan / 2 ** level;
        const west = origin.lon + x * span, north = origin.lat - y * span;
        const east = west + span, south = north - span;
        // The grid is padded past the planet; only the part inside the extent gets a mesh.
        const cw = Math.max(west, extent.west), ce = Math.min(east, extent.east);
        const cs = Math.max(south, extent.south), cn = Math.min(north, extent.north);

        const center = lonLatToVec((cw + ce) / 2, (cs + cn) / 2, new THREE.Vector3());
        // Sampled once and reused for distance(): near the poles, lines of longitude converge, so a
        // wedge's corner can sit right under the camera while its bounding sphere (fit to the whole,
        // oddly-shaped patch) is much bigger than the wedge itself. Subtracting that sphere's radius
        // from the distance to its center then makes the *whole* wedge look close, which cascades into
        // every other tile touching the pole and blows up the tile count. Nearest-sample distance
        // doesn't have that failure mode: it can only under-refine a tile whose closest point falls
        // between samples, and 3x3 is dense enough that's negligible next to the pole-singularity fix.
        const samples = [];
        let angle = 0;
        for (const lon of [cw, (cw + ce) / 2, ce]) {
            for (const lat of [cs, (cs + cn) / 2, cn]) {
                const sample = lonLatToVec(lon, lat, new THREE.Vector3());
                samples.push(sample);
                angle = Math.max(angle, center.angleTo(sample));
            }
        }
        angle = angle * 1.02 + 1e-4;
        const sphere = angle >= Math.PI / 2
            ? new THREE.Sphere(new THREE.Vector3(), 1)
            : new THREE.Sphere(center.clone().multiplyScalar(Math.cos(angle)), Math.sin(angle));

        node = {
            key, level, x, y, span, west, north, cw, ce, cs, cn, center, angle, sphere, samples,
            state: 'empty', retryAt: 0, texture: null, mesh: null, lastUsed: 0, kids: null,
        };
        this.nodes.set(key, node);
        return node;
    }

    /**
     * The children that replace `node` when it is refined, or [] if it can't be. Children outside the
     * planet are skipped, but if any child on the planet isn't in the pyramid (edge of a partial build)
     * the node stays as it is: replacing it with only some children would leave a hole.
     */
    kids(node) {
        if (!node.kids) {
            node.kids = [];
            const level = node.level + 1;
            const kids = [];
            if (level <= this.meta.maxLevel) {
                for (let dy = 0; dy < 2; dy++) {
                    for (let dx = 0; dx < 2; dx++) {
                        const x = node.x * 2 + dx, y = node.y * 2 + dy;
                        if (this.overlapsPlanet(level, x, y)) kids.push([level, x, y]);
                    }
                }
            }
            if (kids.every(([l, x, y]) => this.isCovered(l, x, y))) {
                node.kids = kids.map(([l, x, y]) => this.node(l, x, y));
            }
        }
        return node.kids;
    }

    update(camera, renderer) {
        if (!this.meta) return;
        this.frame++;
        const now = performance.now();

        camera.getWorldPosition(this.camPos);
        const dist = this.camPos.length();
        this.altitude = Math.max(dist - 1, 1e-6);
        this.camDir.copy(this.camPos).divideScalar(dist);
        this.horizon = dist > 1 ? Math.acos(1 / dist) : 0; // angular radius of the visible cap
        this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        this.frustum.setFromProjectionMatrix(this.matrix);
        renderer.getDrawingBufferSize(this.size);
        this.pixelsPerUnit = this.size.y / (2 * Math.tan(camera.fov * DEG / 2));
        this.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

        this.uploadPending();
        this.renderList.length = 0;
        for (const root of this.roots) this.visit(root);
        this.show();
        this.loader.update(now);
        this.evict();

        let finest = 0;
        for (const node of this.renderList) finest = Math.max(finest, node.level);
        this.stats = {
            rendered: this.renderList.length, finestLevel: finest, textures: this.ready.size,
            loading: this.loader.loading, queued: this.loader.queued,
        };
        if (this.resolveReady && this.roots.every((r) => r.state === 'ready')) {
            this.resolveReady();
            this.resolveReady = null;
        }
    }

    isVisible(node) {
        const angle = Math.acos(clamp(this.camDir.dot(node.center), -1, 1));
        return angle <= node.angle + this.horizon && this.frustum.intersectsSphere(node.sphere);
    }

    distance(node) {
        let nearest = Infinity;
        for (const sample of node.samples) nearest = Math.min(nearest, this.camPos.distanceTo(sample));
        return Math.max(nearest, this.altitude);
    }

    needsRefine(node, dist) {
        const texel = node.span * DEG / this.meta.tilePx; // north-south texel size on the unit sphere
        return texel * this.pixelsPerUnit / dist > this.pixelError;
    }

    request(node, dist) {
        if (node.state === 'failed' && performance.now() > node.retryAt) node.state = 'empty';
        if (node.state !== 'empty' && node.state !== 'queued') return;
        node.state = 'queued';
        this.loader.touch(node.key, `${this.baseUrl}/${node.level}/${node.x}/${node.y}.${this.meta.format}`, dist);
    }

    visit(node) {
        node.lastUsed = this.frame;
        const dist = this.distance(node);
        this.request(node, dist);
        if (node.state !== 'ready') return;

        if (node.level < this.meta.maxLevel && this.needsRefine(node, dist)) {
            const kids = this.kids(node).filter((k) => this.isVisible(k));
            if (kids.length) {
                let allReady = true;
                for (const kid of kids) {
                    kid.lastUsed = this.frame;
                    this.request(kid, this.distance(kid));
                    if (kid.state !== 'ready') allReady = false;
                }
                if (allReady) {
                    for (const kid of kids) this.visit(kid);
                    return;
                }
            }
        }
        this.renderList.push(node);
    }

    uploadPending() {
        for (let n = 0; n < MAX_UPLOADS_PER_FRAME && this.pending.length; n++) {
            const { node, bitmap } = this.pending.shift();
            const texture = new THREE.Texture(bitmap);
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.flipY = false; // ImageBitmaps aren't flipped on upload; v = 0 is the top (north) row
            texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
            texture.minFilter = THREE.LinearMipmapLinearFilter;
            texture.anisotropy = this.anisotropy;
            texture.onUpdate = () => bitmap.close();
            texture.needsUpdate = true;
            node.texture = texture;
            node.state = 'ready';
            node.lastUsed = this.frame;
            this.ready.add(node);
        }
    }

    show() {
        for (const mesh of this.shown) mesh.visible = false;
        this.shown.length = 0;
        for (const node of this.renderList) {
            if (!node.mesh) node.mesh = this.createMesh(node);
            node.mesh.visible = true;
            this.shown.push(node.mesh);
        }
    }

    createMesh(node) {
        const material = new THREE.ShaderMaterial({
            uniforms: { map: { value: node.texture } },
            vertexShader: VERTEX,
            fragmentShader: FRAGMENT,
            side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(buildPatch(node), material);
        mesh.frustumCulled = false;
        mesh.visible = false;
        this.group.add(mesh);
        return mesh;
    }

    evict() {
        if (this.ready.size <= this.maxTextures) return;
        const stale = [...this.ready].filter((n) => n.lastUsed < this.frame).sort((a, b) => a.lastUsed - b.lastUsed);
        for (const node of stale) {
            if (this.ready.size <= this.maxTextures) break;
            if (node.mesh) {
                this.group.remove(node.mesh);
                node.mesh.geometry.dispose();
                node.mesh.material.dispose();
                node.mesh = null;
            }
            node.texture.dispose();
            node.texture = null;
            node.state = 'empty';
            this.ready.delete(node);
        }
    }
}

/**
 * Lat/lon patch on the unit sphere, clamped to the planet, with a small skirt (a strip dropped below
 * the surface along the border) so neighbouring tiles of different levels never show cracks.
 */
function buildPatch(node) {
    const { cw, ce, cs, cn, west, north, span } = node;
    const segLon = clamp(Math.ceil((ce - cw) / 1.5), 2, 32);
    const segLat = clamp(Math.ceil((cn - cs) / 1.5), 2, 32);
    const cols = segLon + 1, rows = segLat + 1;

    const border = [];
    for (let c = 0; c < segLon; c++) border.push(c);
    for (let r = 0; r < segLat; r++) border.push(r * cols + segLon);
    for (let c = segLon; c > 0; c--) border.push(segLat * cols + c);
    for (let r = segLat; r > 0; r--) border.push(r * cols);

    const count = cols * rows + border.length;
    const positions = new Float32Array(count * 3);
    const uvs = new Float32Array(count * 2);
    const indices = [];
    const p = new THREE.Vector3();

    for (let r = 0; r < rows; r++) {
        const lat = cn - (cn - cs) * r / segLat;
        for (let c = 0; c < cols; c++) {
            const lon = cw + (ce - cw) * c / segLon;
            const i = r * cols + c;
            lonLatToVec(lon, lat, p).toArray(positions, i * 3);
            uvs[i * 2] = (lon - west) / span;
            uvs[i * 2 + 1] = (north - lat) / span;
        }
    }
    for (let r = 0; r < segLat; r++) {
        for (let c = 0; c < segLon; c++) {
            const a = r * cols + c, b = a + 1, d = a + cols, e = d + 1;
            indices.push(a, d, b, b, d, e);
        }
    }

    const skirtScale = 1 - span * DEG * 0.02;
    const first = cols * rows;
    border.forEach((src, j) => {
        const i = first + j;
        p.fromArray(positions, src * 3).multiplyScalar(skirtScale).toArray(positions, i * 3);
        uvs[i * 2] = uvs[src * 2];
        uvs[i * 2 + 1] = uvs[src * 2 + 1];
    });
    for (let j = 0; j < border.length; j++) {
        const k = (j + 1) % border.length;
        indices.push(border[j], first + j, border[k], border[k], first + j, first + k);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(indices);
    return geometry;
}
