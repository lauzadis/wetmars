import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Mars } from './Mars.js';

let scene, camera, renderer, marsGlobe, controls;
let slider, sliderKnob, infoButton, modal, closeButton;

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

    // Handle window resize
    window.addEventListener('resize', onWindowResize, false);

    createSlider()
    createInfoModal();
}

function onWindowResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

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
    // sliderKnob.style.transition = 'left 0.1s';

    slider.appendChild(sliderKnob);
    document.body.appendChild(slider);

    updateSliderPosition(marsGlobe.isWet);

    slider.addEventListener('click', onSliderClick);
}

function onSliderClick(event) {
    const sliderRect = slider.getBoundingClientRect();
    const clickPosition = event.clientX - sliderRect.left;
    const isWet = clickPosition > sliderRect.width / 2;
    marsGlobe.setWetness(isWet);
    updateSliderPosition(isWet);
}

function updateSliderPosition(isWet) {
    sliderKnob.style.left = isWet ? '34px' : '2px';
    slider.style.backgroundColor = isWet ? 'rgba(0, 191, 255, 0.3)' : 'rgba(255, 255, 255, 0.3)';
}

function createInfoModal() {
    // Create info button
    infoButton = document.createElement('button');
    infoButton.textContent = 'Info';
    infoButton.style.position = 'absolute';
    infoButton.style.top = '60px';
    infoButton.style.right = '20px';
    infoButton.style.padding = '10px';
    infoButton.style.backgroundColor = 'rgba(255, 255, 255, 0.3)';
    infoButton.style.color = 'white';
    infoButton.style.border = 'none';
    infoButton.style.borderRadius = '5px';
    infoButton.style.cursor = 'pointer';

    document.body.appendChild(infoButton);

    // Create modal
    modal = document.createElement('div');
    modal.style.position = 'fixed';
    modal.style.top = '0';
    modal.style.left = '0';
    modal.style.width = '100vw';
    modal.style.height = '100vh';
    modal.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    modal.style.display = 'none';
    modal.style.justifyContent = 'center';
    modal.style.alignItems = 'center';

    // Create modal content
    const modalContent = document.createElement('div');
    modalContent.style.backgroundColor = 'rgba(255, 255, 255, 0.66)';
    modalContent.style.padding = '20px';
    modalContent.style.borderRadius = '10px';
    modalContent.style.textAlign = 'center';
    modalContent.innerHTML = `
        <p>Made by <a href="https://x.com/mataslauzadis" target="_blank">Matas Lauzadis</a> with data from 
        <a href="https://x.com/CJHandmer" target="_blank">Casey Handmer</a></p>
        <button id="closeModal" style="padding: 10px; background-color: #007bff; color: white; border: none; border-radius: 5px; cursor: pointer;">Close</button>
    `;

    modal.appendChild(modalContent);
    document.body.appendChild(modal);

    // Event listeners
    infoButton.addEventListener('click', () => {
        modal.style.display = 'flex';
    });

    closeButton = document.getElementById('closeModal');
    closeButton.addEventListener('click', () => {
        modal.style.display = 'none';
    });
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    marsGlobe.update();
    renderer.render(scene, camera);
}

init();
animate();
