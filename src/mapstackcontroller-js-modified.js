// Assuming this file handles the map logic and projections
// Add support for Flat Earther Mode with Azimuthal Equidistant Projection

// Import or define Leaflet and Proj4Leaflet (if not already available)
// Note: Ensure Leaflet and Proj4Leaflet are loaded in the project

// Custom CRS for Flat Earth (Azimuthal Equidistant Projection)
const flatEarthCRS = new L.Proj.CRS('AEPD', '+proj=aeqd +lat_0=90 +lon_0=0 +x_0=0 +y_0=0 +R=6371000 +units=m +no_defs', {
    resolutions: [
        8192, 4096, 2048, 1024, 512, 256, 128, 64, 32, 16, 8, 4, 2, 1, 0.5, 0.25
    ],
    origin: [0, 0],
    bounds: L.bounds([-8192, -8192], [8192, 8192])
});

// Standard CRS (default)
const standardCRS = L.CRS.EPSG3857;

// Initialize the map with the standard projection
let map = null;
let isFlatMode = false;

// Function to initialize the map
function initMap(containerId) {
    map = L.map(containerId, {
        crs: standardCRS,
        center: [0, 0],
        zoom: 2
    });
    
    // Add default layer (e.g., OpenStreetMap)
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors'
    }).addTo(map);
    
    // TODO: Original dev to implement Gleason's map overlay here
    // Example:
    // const gleasonLayer = L.imageOverlay('path/to/gleason_map.png', [[-90, -180], [90, 180]]);
    // gleasonLayer.addTo(map);
    
    // TODO: Original dev to implement elevation/sea level data here
    // Example:
    // const elevationLayer = L.heatLayer(elevationData, { radius: 25, gradient: { 0.4: 'blue', 1.0: 'red' } });
    // elevationLayer.addTo(map);
}

// Function to toggle Flat Earther Mode
function toggleFlatEartherMode() {
    if (!map) {
        console.error('Map not initialized');
        return false;
    }
    
    isFlatMode = !isFlatMode;
    
    if (isFlatMode) {
        // Switch to Flat Earth projection
        map.options.crs = flatEarthCRS;
        map.setView([0, 0], 2);
        
        // TODO: Original dev to add Gleason's map and elevation layers here
        // Example:
        // gleasonLayer.addTo(map);
        // elevationLayer.addTo(map);
        
        console.log('Flat Earther Mode: ON');
    } else {
        // Switch back to standard projection
        map.options.crs = standardCRS;
        map.setView([0, 0], 2);
        
        // TODO: Original dev to remove Gleason's map and elevation layers here
        // Example:
        // map.removeLayer(gleasonLayer);
        // map.removeLayer(elevationLayer);
        
        console.log('Flat Earther Mode: OFF');
    }
    
    // Force map to update
    map.invalidateSize();
    return isFlatMode;
}

// Export for use in other modules (if using ES6 modules)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { initMap, toggleFlatEartherMode };
}