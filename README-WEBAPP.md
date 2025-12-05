# OSM to 3D Print - Web App

This is a browser-based single-page web application that converts OpenStreetMap (OSM) data into STL files for 3D printing. It runs entirely in your browser - no server required!

## Features

- 🗺️ **Fetch OSM data directly** - Uses Overpass API to get building and road data
- 🏗️ **3D model generation** - Creates watertight STL models optimized for 3D printing
- 🛣️ **Roads support** - Includes streets with configurable width and height
- 📐 **Customizable parameters** - Adjust size, heights, and road dimensions
- 💾 **Direct download** - STL files download automatically when ready

## Usage

1. **Open the app**: Simply open `index.html` in a modern web browser (Chrome, Firefox, Safari, Edge)

2. **Configure your area**:
   - Enter bounding box coordinates (North, East, South, West in decimal degrees)
   - Set target size (width in mm for your print bed)
   - Adjust building heights and base thickness
   - Configure road settings if including roads

3. **Generate STL**:
   - Click "Generate STL" button
   - Wait for OSM data to be fetched and processed
   - The STL file will automatically download when ready

## Example: Center City Philadelphia

Default coordinates are set for Center City Philadelphia:
- North: 39.9615
- East: -75.1520
- South: 39.9435
- West: -75.1750

## Tips

- **Start small**: Large areas take longer to process and may hit API limits
- **Road width**: Start with 0.6-1.0 mm for residential areas
- **Building height**: Scale appropriately for your print size
- **Base thickness**: 1.8-2.0 mm works well for most prints

## Technical Details

- Uses Overpass API for OSM data fetching
- Pure JavaScript - no build step required
- Runs entirely client-side
- Generates ASCII STL format

## Browser Compatibility

Works in all modern browsers that support:
- ES6+ JavaScript
- Fetch API
- Blob API

## Limitations

- Processing large areas may take time
- Overpass API has rate limits
- Complex geometries may need optimization for very large models

## Original Python Version

This web app is a port of the original Python version. For server-side processing with more advanced features, see the original `main.py`.

