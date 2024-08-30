import * as THREE from 'three';

export class Mars {
    constructor(scene) {
        this.scene = scene;
        this.globe = null;
        this.setupLighting();
        this.createGlobe();
    }

    createGlobe() {
        const geometry = new THREE.SphereGeometry(1, 128, 128);
        const textureLoader = new THREE.TextureLoader();
        
        const color = textureLoader.load('assets/mars_8k_color.jpg');
        const normal = textureLoader.load('assets/mars_8k_normal.jpg');
        
        // Adjust texture properties
        color.encoding = THREE.sRGBEncoding;

        const material = new THREE.MeshStandardMaterial({ 
            map: color,
            normalMap: normal,
            normalScale: new THREE.Vector2(1, 1),
            roughness: 0.8,
            metalness: 0.2
        });

        this.globe = new THREE.Mesh(geometry, material);
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
}