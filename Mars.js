import * as THREE from 'three';
import { TileGlobe } from './TileGlobe.js';

// Where the tile pyramid (tools/build-tiles) is served from. Dev: ./tiles-local via vite.config.js.
const TILE_BASE_URL = import.meta.env.VITE_TILE_BASE_URL ?? '/tiles';
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
        this.tileGlobe = null;
        this.wetGlobe = null;
        this.dryGlobe = null;
        this.dryLoading = false;
        this.loadWet();
    }

    /** Wet Mars streams from the tile pyramid at TILE_BASE_URL; there's no local fallback for it. */
    async loadWet() {
        this.updateLoadingMessage('Loading…');
        const tiles = new TileGlobe({ baseUrl: TILE_BASE_URL });
        try {
            await tiles.init();
            this.tileGlobe = tiles;
            this.scene.add(tiles.group);
            const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), TILES_TIMEOUT_MS));
            await Promise.race([tiles.whenReady, timeout]);
            this.wetGlobe = tiles.group;
            this.updateLoadingMessage('');
        } catch (error) {
            console.error('Failed to load the wet Mars tile pyramid:', error);
            this.tileGlobe = null;
            this.scene.remove(tiles.group);
            this.wetGlobe = null;
            // Left showing (not cleared to '') so the error stays visible; dry Mars still works via the toggle.
            this.updateLoadingMessage('Failed to load Mars terrain. Try refreshing, or switch to dry Mars →');
        }
        this.applyVisibility();
        if (this.onLoadingComplete) this.onLoadingComplete();
    }

    /** Dry Mars: a single 8K equirectangular texture on a sphere, shaded with the 8K normal map. */
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
        if (!isWet && !this.dryGlobe && !this.dryLoading) this.loadDry();
        this.applyVisibility();
    }

    /** The dry texture is only fetched the first time someone flips the switch. */
    async loadDry() {
        this.dryLoading = true;
        this.updateLoadingMessage('Loading dry Mars…');
        try {
            this.dryGlobe = await this.createShadedGlobe('assets/mars_8k_color.jpg');
        } catch (error) {
            console.error('Failed to load dry Mars:', error);
        }
        this.dryLoading = false;
        this.updateLoadingMessage('');
        this.applyVisibility();
    }

    applyVisibility() {
        // Keep showing wet Mars until the dry texture has arrived.
        const showDry = !this.isWet && this.dryGlobe !== null;
        if (this.wetGlobe) this.wetGlobe.visible = !showDry;
        if (this.dryGlobe) this.dryGlobe.visible = showDry;
    }

    update(camera, renderer) {
        if (this.tileGlobe && this.wetGlobe?.visible !== false) this.tileGlobe.update(camera, renderer);
    }

    get tileStats() {
        // Stats freeze once the tile globe stops updating (dry showing, or no pyramid at all);
        // returning null here rather than the frozen object keeps the debug readout honest.
        if (!this.tileGlobe || this.dryGlobe?.visible) return null;
        return this.tileGlobe.stats;
    }
}
