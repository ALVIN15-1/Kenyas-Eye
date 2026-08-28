// Assuming this file handles UI chips/buttons for map layers
// Add a toggle for "Flat Earther Mode"

// Example: Add a new chip/button for Flat Earther Mode
function addFlatEartherToggle() {
    const flatEartherChip = document.createElement('button');
    flatEartherChip.innerText = 'Flat Earther Mode';
    flatEartherChip.id = 'flat-earther-toggle';
    flatEartherChip.className = 'map-chip';
    flatEartherChip.addEventListener('click', toggleFlatEartherMode);
    
    // Append to the existing chips container (adjust selector as needed)
    const chipsContainer = document.querySelector('.map-chips-container') || document.body;
    chipsContainer.appendChild(flatEartherChip);
}

// Toggle function to switch between Flat Earth and standard projection
function toggleFlatEartherMode() {
    const isFlatMode = window.mapController?.toggleFlatEartherMode();
    const toggleButton = document.getElementById('flat-earther-toggle');
    if (isFlatMode) {
        toggleButton.classList.add('active');
        toggleButton.innerText = 'Flat Earther Mode (ON)';
    } else {
        toggleButton.classList.remove('active');
        toggleButton.innerText = 'Flat Earther Mode';
    }
}

// Initialize the toggle when the page loads
document.addEventListener('DOMContentLoaded', addFlatEartherToggle);

// Export for use in other modules (if using ES6 modules)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { addFlatEartherToggle, toggleFlatEartherMode };
}