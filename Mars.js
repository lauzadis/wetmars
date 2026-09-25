import * as THREE from 'three';
import { TileGlobe } from './TileGlobe.js';

// Where each tile pyramid (tools/build-tiles/build.mjs and build-dry.mjs) is served from.
// Dev: ./tiles-local and ./tiles-dry-local via vite.config.js.
const WET_TILE_BASE_URL = import.meta.env.VITE_TILE_BASE_URL ?? '/tiles';
const DRY_TILE_BASE_URL = import.meta.env.VITE_DRY_TILE_BASE_URL ?? '/tiles-dry';
const TILES_TIMEOUT_MS = 10000;

const VERTEX_SHADER = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;

const FRAGMENT_SHADER = `
    uniform sampler2D colorMap;
    uniform sampler2D normalMap;
    uniform vec2 normalScale;
    varying vec2 vUv;
    void main() {
        vec3 normal = texture2D(normalMap, vUv).rgb * 2.0 - 1.0;
        normal.xy *= normalScale;
        normal = normalize(normal);

        // Simulate ambient occlusion
        float ao = (normal.z + 1.0) * 0.5;
        ao = smoothstep(0.0, 1.0, ao);
        ao = mix(0.8, 1.0, ao);  // Adjust these values to control the shadow intensity

        vec3 color = texture2D(colorMap, vUv).rgb;
        gl_FragColor = vec4(color * ao, 1.0);
    }
`;

export class Mars {
    constructor(scene, onLoadingComplete) {
        this.scene = scene;
        this.isWet = true;
        this.onLoadingComplete = onLoadingComplete;
        this.textureLoader = new THREE.TextureLoader();
        // Each side is { group: THREE.Object3D, tileGlobe: TileGlobe | null } once loaded, or null.
        // tileGlobe is null for the legacy single-texture fallback, which needs no per-frame update.
        this.wet = null;
        this.dry = null;
        this.dryLoading = false;
        this.loadWet();
    }

    /** Streams a tile pyramid at baseUrl; throws (after cleaning up) if it never becomes ready. */
    async loadTileGlobe(baseUrl) {
        const tiles = new TileGlobe({ baseUrl });
        try {
            await tiles.init();
            this.scene.add(tiles.group);
            const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), TILES_TIMEOUT_MS));
            await Promise.race([tiles.whenReady, timeout]);
            return { group: tiles.group, tileGlobe: tiles };
        } catch (error) {
            this.scene.remove(tiles.group);
            throw error;
        }
    }

    /** Wet Mars streams from the tile pyramid at WET_TILE_BASE_URL; there's no local fallback for it. */
    async loadWet() {
        this.updateLoadingMessage('Loading…');
        try {
            this.wet = await this.loadTileGlobe(WET_TILE_BASE_URL);
            this.updateLoadingMessage('');
        } catch (error) {
            console.error('Failed to load the wet Mars tile pyramid:', error);
            this.wet = null;
            // Left showing (not cleared to '') so the error stays visible; dry Mars still works via the toggle.
            this.updateLoadingMessage('Failed to load Mars terrain. Try refreshing, or switch to dry Mars →');
        }
        this.applyVisibility();
        if (this.onLoadingComplete) this.onLoadingComplete();
    }

    /** Legacy dry Mars: a single 8K equirectangular texture on a sphere, shaded with the 8K normal map. */
    async createShadedGlobe(colorUrl) {
        this.normalMap ??= this.textureLoader.loadAsync('assets/mars_8k_normal.jpg');
        const [colorMap, normalMap] = await Promise.all([this.textureLoader.loadAsync(colorUrl), this.normalMap]);
        const material = new THREE.ShaderMaterial({
            uniforms: {
                colorMap: { value: colorMap },
                normalMap: { value: normalMap },
                normalScale: { value: new THREE.Vector2(1, 1) }
            },
            vertexShader: VERTEX_SHADER,
            fragmentShader: FRAGMENT_SHADER
        });
        const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 128, 128), material);
        this.scene.add(globe);
        return globe;
    }

    updateLoadingMessage(message) {
        const loadingDiv = document.getElementById('loading-message');
        if (loadingDiv) {
            loadingDiv.textContent = message;
            loadingDiv.style.display = message ? 'block' : 'none';
        }
    }

    setWetness(isWet) {
        this.isWet = isWet;
        if (!isWet && !this.dry && !this.dryLoading) this.loadDry();
        this.applyVisibility();
    }

    /**
     * Dry Mars is only fetched the first time someone flips the switch. It streams from the same
     * kind of tile pyramid as wet, colorized from THEMIS + Viking imagery rather than Casey
     * Handmer's flood-simulation render. If that pyramid isn't hosted yet (DRY_TILE_BASE_URL
     * unset or unreachable — e.g. it hasn't been uploaded to production), falls back to the
     * legacy single 8K texture rather than leaving dry Mars broken.
     */
    async loadDry() {
        this.dryLoading = true;
        this.updateLoadingMessage('Loading dry Mars…');
        try {
            this.dry = await this.loadTileGlobe(DRY_TILE_BASE_URL);
        } catch (error) {
            console.warn('Dry Mars tile pyramid unavailable, using the legacy texture:', error);
            try {
                this.dry = { group: await this.createShadedGlobe('assets/mars_8k_color.jpg'), tileGlobe: null };
            } catch (fallbackError) {
                console.error('Failed to load the dry Mars fallback texture:', fallbackError);
                this.dry = null;
            }
        }
        this.dryLoading = false;
        this.updateLoadingMessage('');
        this.applyVisibility();
        if (this.onLoadingComplete) this.onLoadingComplete();
    }

    /** Whichever side (wet/dry) is actually on screen right now — dry only once it's loaded. */
    get active() {
        return !this.isWet && this.dry ? this.dry : this.wet;
    }

    applyVisibility() {
        // Keep showing wet Mars until the dry side has arrived.
        const active = this.active;
        if (this.wet) this.wet.group.visible = active === this.wet;
        if (this.dry) this.dry.group.visible = active === this.dry;
    }

    update(camera, renderer) {
        this.active?.tileGlobe?.update(camera, renderer);
    }

    get tileStats() {
        // Stats freeze once a tile globe stops updating (it's not the active side); returning
        // null here rather than a frozen object keeps the debug readout honest. Also null for the
        // legacy fallback texture, which has no tileGlobe at all.
        return this.active?.tileGlobe?.stats ?? null;
    }

    /** Credit for whichever data source is actually showing; null for the legacy fallback texture. */
    get attribution() {
        return this.active?.tileGlobe?.attribution ?? null;
    }
}
