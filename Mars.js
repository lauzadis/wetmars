import * as THREE from 'three';

export class Mars {
    constructor(scene) {
        this.scene = scene;
        this.globe = null;
        this.isWet = true;
        this.setupLighting();
        this.createGlobe();
    }

    createGlobe() {
        const geometry = new THREE.SphereGeometry(1, 128, 128);
        const textureLoader = new THREE.TextureLoader();
        
        this.wetTexture = textureLoader.load('assets/wet_mars_5.png');
        this.dryTexture = textureLoader.load('assets/mars_8k_color.jpg');
        const normal = textureLoader.load('assets/mars_8k_normal.jpg');
        
        // Adjust texture properties
        this.wetTexture.encoding = THREE.sRGBEncoding;
        this.dryTexture.encoding = THREE.sRGBEncoding;

        // Create a custom shader material
        this.material = new THREE.ShaderMaterial({
            uniforms: {
                colorMap: { value: this.wetTexture },
                normalMap: { value: normal },
                normalScale: { value: new THREE.Vector2(1, 1) }
            },
            vertexShader: `
                varying vec2 vUv;
                varying vec3 vNormal;
                void main() {
                    vUv = uv;
                    vNormal = normalize(normalMatrix * normal);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform sampler2D colorMap;
                uniform sampler2D normalMap;
                uniform vec2 normalScale;
                varying vec2 vUv;
                varying vec3 vNormal;
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
            `
        });

        this.globe = new THREE.Mesh(geometry, this.material);
        this.scene.add(this.globe);
    }

    setupLighting() {
        // Remove previous lights
        this.scene.remove(...this.scene.children.filter(child => child instanceof THREE.Light));

        // Add ambient light
        const ambientLight = new THREE.AmbientLight(0x404040, 0.5);
        this.scene.add(ambientLight);

        // Add directional light (sun-like)
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(5, 3, 5);
        this.scene.add(directionalLight);

        // Add subtle warm fill light
        const fillLight = new THREE.PointLight(0xffad70, 0.3);
        fillLight.position.set(-5, 0, -5);
        this.scene.add(fillLight);
    }

    update() {
        // slow rotation
        this.globe.rotation.y += 0.001;
    }

    setWetness(isWet) {
        this.isWet = isWet;
        this.material.uniforms.colorMap.value = this.isWet ? this.wetTexture : this.dryTexture;
        this.material.needsUpdate = true;
    }
}