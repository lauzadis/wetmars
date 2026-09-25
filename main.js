import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Mars } from './Mars.js';

let scene, camera, renderer, marsGlobe, controls;
let slider, sliderKnob, infoText, playPauseButton, loadingMessage, debugText;

const MARS_RADIUS_KM = 3389.5;

function init() {
    scene = new THREE.Scene();

    // Camera
    camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 2;

    // Renderer
    renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    document.body.appendChild(renderer.domElement);

    createLoadingMessage();

    // Create Mars
    marsGlobe = new Mars(scene);

    // Set up OrbitControls
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.25;
    controls.screenSpacePanning = false;
    controls.minDistance = 1.003; // ~10 km above the surface, close to where the finest tiles run out of detail
    controls.maxDistance = 5;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.33;
    controls.panSpeed = 0.5;

    // Handle window resize
    window.addEventListener('resize', onWindowResize, false);

    createSlider()
    createInfoText();
    createPlayPauseButton();
    if (new URLSearchParams(window.location.search).has('debug')) {
        createDebugText();
        window.wetmars = { camera, controls, marsGlobe };
    }
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

/**
 * A small "i" icon in the bottom-left; hovering (or tapping, on touch) expands a panel with
 * credits to its right.
 */
function createInfoText() {
    infoText = document.createElement('div');
    infoText.style.position = 'absolute';
    infoText.style.bottom = '20px';
    infoText.style.left = '20px';
    infoText.style.display = 'flex';
    infoText.style.flexDirection = 'row';
    infoText.style.alignItems = 'center';

    const panel = document.createElement('div');
    panel.style.whiteSpace = 'nowrap';
    panel.style.marginLeft = '8px';
    panel.style.color = 'white';
    panel.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    panel.style.padding = '10px';
    panel.style.borderRadius = '5px';
    panel.style.fontSize = '14px';
    panel.style.lineHeight = '1.4';
    panel.style.opacity = '0';
    panel.style.transform = 'scale(0.95)';
    panel.style.transformOrigin = 'left center';
    panel.style.transition = 'opacity 0.15s ease, transform 0.15s ease';
    panel.style.pointerEvents = 'none';
    panel.innerHTML = `
        Made by <a href="https://x.com/mataslauzadis" target="_blank" style="color: #007bff;">Matas Lauzadis</a>
        with data from <a href="https://x.com/CJHandmer" target="_blank" style="color: #007bff;">Casey Handmer</a>
    `;

    const icon = document.createElement('div');
    icon.textContent = 'i';
    icon.style.width = '30px';
    icon.style.height = '30px';
    icon.style.borderRadius = '50%';
    icon.style.backgroundColor = 'rgba(255, 255, 255, 0.3)';
    icon.style.display = 'flex';
    icon.style.alignItems = 'center';
    icon.style.justifyContent = 'center';
    icon.style.cursor = 'pointer';
    icon.style.fontFamily = 'Georgia, serif';
    icon.style.fontStyle = 'italic';
    icon.style.fontWeight = 'bold';
    icon.style.color = 'white';
    icon.style.userSelect = 'none';

    const showPanel = () => { panel.style.opacity = '1'; panel.style.transform = 'scale(1)'; panel.style.pointerEvents = 'auto'; };
    const hidePanel = () => { panel.style.opacity = '0'; panel.style.transform = 'scale(0.95)'; panel.style.pointerEvents = 'none'; };

    // Hover for desktop; click toggles too so the icon also works on touch screens.
    infoText.addEventListener('mouseenter', showPanel);
    infoText.addEventListener('mouseleave', hidePanel);
    icon.addEventListener('click', (event) => {
        event.stopPropagation();
        panel.style.opacity === '1' ? hidePanel() : showPanel();
    });
    document.addEventListener('click', hidePanel);

    infoText.appendChild(icon);
    infoText.appendChild(panel);
    document.body.appendChild(infoText);
}

function createPlayPauseButton() {
    playPauseButton = document.createElement('button');
    playPauseButton.style.position = 'absolute';
    playPauseButton.style.top = '20px';
    playPauseButton.style.right = '90px';
    playPauseButton.style.width = '30px';
    playPauseButton.style.height = '30px';
    playPauseButton.style.backgroundColor = 'rgba(255, 255, 255, 0.3)';
    playPauseButton.style.border = 'none';
    playPauseButton.style.borderRadius = '50%';
    playPauseButton.style.cursor = 'pointer';
    playPauseButton.style.display = 'flex';
    playPauseButton.style.justifyContent = 'center';
    playPauseButton.style.alignItems = 'center';

    const pauseIcon = `<svg width="12" height="12" viewBox="0 0 12 12">
        <rect width="4" height="12" fill="white"/>
        <rect x="8" width="4" height="12" fill="white"/>
    </svg>`;

    playPauseButton.innerHTML = pauseIcon;

    playPauseButton.addEventListener('click', togglePlayPause);
    document.body.appendChild(playPauseButton);
}

function togglePlayPause() {
    controls.autoRotate = !controls.autoRotate;
    
    const pauseIcon = `<svg width="12" height="12" viewBox="0 0 12 12">
        <rect width="4" height="12" fill="white"/>
        <rect x="8" width="4" height="12" fill="white"/>
    </svg>`;

    const playIcon = `<svg width="12" height="12" viewBox="-2 0 16 12">
        <path d="M0 0 L12 6 L0 12 Z" fill="white"/>
    </svg>`;

    playPauseButton.innerHTML = controls.autoRotate ? pauseIcon : playIcon;
}

function createLoadingMessage() {
    loadingMessage = document.createElement('div');
    loadingMessage.id = 'loading-message';
    loadingMessage.style.position = 'fixed';
    loadingMessage.style.top = '50%';
    loadingMessage.style.left = '50%';
    loadingMessage.style.transform = 'translate(-50%, -50%)';
    loadingMessage.style.backgroundColor = 'rgba(0,0,0,0.7)';
    loadingMessage.style.color = 'white';
    loadingMessage.style.padding = '20px';
    loadingMessage.style.borderRadius = '10px';
    loadingMessage.style.fontFamily = 'Arial, sans-serif';
    loadingMessage.style.zIndex = '1000';
    document.body.appendChild(loadingMessage);
}

/**
 * Debug readout (add ?debug to the URL): altitude and tile streaming stats.
 */
function createDebugText() {
    debugText = document.createElement('div');
    debugText.style.position = 'absolute';
    debugText.style.bottom = '20px';
    debugText.style.left = '20px';
    debugText.style.color = 'white';
    debugText.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    debugText.style.padding = '10px';
    debugText.style.borderRadius = '5px';
    debugText.style.fontFamily = 'monospace';
    debugText.style.fontSize = '12px';
    debugText.style.whiteSpace = 'pre';
    document.body.appendChild(debugText);
}

function updateDebugText() {
    if (!debugText) return;
    const altitudeKm = (camera.position.length() - 1) * MARS_RADIUS_KM;
    const stats = marsGlobe.tileStats;
    debugText.textContent = `altitude  ${altitudeKm.toFixed(1)} km\n` + (stats
        ? `level     ${stats.finestLevel}\ntiles     ${stats.rendered} drawn, ${stats.textures} cached\nloading   ${stats.loading} active, ${stats.queued} queued`
        : 'tiles     - (dry Mars, or no tile pyramid)');
}

/**
 * The globe has a radius of 1, so distances near the surface are tiny. Keep the clip planes tight
 * around what can be seen, and slow orbiting/zooming down in proportion to the altitude.
 */
function updateCameraForAltitude() {
    const distance = camera.position.length();
    const altitude = Math.max(distance - 1, 1e-5);
    camera.near = altitude * 0.5;
    camera.far = Math.sqrt(Math.max(distance * distance - 1, 0)) * 1.05 + altitude; // horizon distance
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();

    controls.zoomSpeed = 2.5 * altitude / distance; // each wheel step scales the altitude, not the distance
    controls.rotateSpeed = Math.min(1, altitude);
    controls.autoRotateSpeed = 0.33 * Math.min(1, altitude);
}

function animate() {
    requestAnimationFrame(animate);
    controls.update();
    updateCameraForAltitude();
    marsGlobe.update(camera, renderer);
    renderer.render(scene, camera);
    updateDebugText();
}

init();
animate();
