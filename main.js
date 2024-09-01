import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Mars } from './Mars.js';

let scene, camera, renderer, marsGlobe, controls;
let slider, sliderKnob, infoText;

function init() {
    scene = new THREE.Scene();

    // Camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 2;

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    // Create Mars
    marsGlobe = new Mars(scene);

    // Set up OrbitControls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.25;
    controls.screenSpacePanning = false;
    controls.minDistance = 1.1;
    controls.maxDistance = 5;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.33;
    controls.panSpeed = 0.5;

    // Handle window resize
    window.addEventListener('resize', onWindowResize, false);

    createSlider()
    createInfoText();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

/**
 * Slider controls Mars texture (wet / dry)
 */
function createSlider() {
    slider = document.createElement('div');
    slider.style.position = 'absolute';
    slider.style.top = '20px';
    slider.style.right = '20px';
    slider.style.width = '60px';
    slider.style.height = '30px';
    slider.style.backgroundColor = 'rgba(255, 255, 255, 0.3)';
    slider.style.borderRadius = '15px';
    slider.style.cursor = 'pointer';

    sliderKnob = document.createElement('div');
    sliderKnob.style.position = 'absolute';
    sliderKnob.style.width = '26px';
    sliderKnob.style.height = '26px';
    sliderKnob.style.borderRadius = '13px';
    sliderKnob.style.backgroundColor = 'white';
    sliderKnob.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
    sliderKnob.style.transition = 'left 0.1s';

    slider.appendChild(sliderKnob);
    document.body.appendChild(slider);

    updateSliderPosition(marsGlobe.isWet);

    slider.addEventListener('click', onSliderClick);
}

function onSliderClick(event) {
    const next = !marsGlobe.isWet
    marsGlobe.setWetness(next);
    updateSliderPosition(next);
}

function updateSliderPosition(isWet) {
    sliderKnob.style.left = isWet ? '34px' : '2px';
    slider.style.backgroundColor = isWet ? 'rgba(0, 191, 255, 0.3)' : 'rgba(255, 255, 255, 0.3)';
}

function createInfoText() {
    infoText = document.createElement('div');
    infoText.style.position = 'absolute';
    infoText.style.bottom = '20px';
    infoText.style.right = '20px';
    infoText.style.width = '300px'; // Adjust width as needed
    infoText.style.textAlign = 'right';
    infoText.style.color = 'white';
    infoText.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    infoText.style.padding = '10px';
    infoText.style.borderRadius = '5px';
    infoText.style.fontSize = '14px'; // Adjust font size as needed
    infoText.style.lineHeight = '1.4';
    infoText.innerHTML = `
        Made by <a href="https://x.com/mataslauzadis" target="_blank" style="color: #007bff;">Matas Lauzadis</a><br>
        with data from <a href="https://x.com/CJHandmer" target="_blank" style="color: #007bff;">Casey Handmer</a>
    `;

    document.body.appendChild(infoText);
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

init();
animate();
