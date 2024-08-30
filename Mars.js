import * as THREE from 'three';

export class Mars {
    constructor(scene) {
        this.scene = scene;
        this.globe = null;
        this.createGlobe();
    }

    createGlobe() {
        const geometry = new THREE.SphereGeometry(1, 64, 64);
        const textureLoader = new THREE.TextureLoader();
        
        // const color = textureLoader.load('assets/mars_1k_color.jpg');
        const color = textureLoader.load('assets/8k_mars.jpg');
        const normal = textureLoader.load('assets/mars_1k_normal.jpg');
        const bump = textureLoader.load('assets/mars_1k_bump.jpg');
        
        const material = new THREE.MeshPhongMaterial({ 
            map: color,
            normalMap: normal,
            bumpMap: bump,
            bumpScale: 0.05,
        });

        this.globe = new THREE.Mesh(geometry, material);
        this.scene.add(this.globe);

        // Add ambient light
        const ambientLight = new THREE.AmbientLight(0x333333);
        this.scene.add(ambientLight);

        // Add directional light
        const directionalLight = new THREE.DirectionalLight(0xffffff, 1);
        directionalLight.position.set(5, 3, 5);
        this.scene.add(directionalLight);
    }

    update() {
        // slow rotation
        this.globe.rotation.y += 0.001;
    }
}