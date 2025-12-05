// OSM to 3D Print - Browser-based Web App
// Ported from Python to JavaScript

class OSMToSTL {
    constructor() {
        // Use geometry processor module
        this.geometryProcessor = new GeometryProcessor();
        this.stlGenerator = new STLGenerator();
        this.vertices = [];
        this.faces = [];
        this.map = null;
        this.mapRectangle = null;
        this.scene = null;
        this.camera = null;
        this.renderer = null;
        this.controls = null;
        this.stlMesh = null;
        this.layerMeshes = {}; // Store layer meshes for color updates
        this.generatedSTLContent = null;
        this.generatedSTLFilename = null;
        this.generatedLayers = {
            buildings: null,
            roads: null,
            greens: null,
            water: null
        };
        this.autoGenerateTimeout = null;
        this.isSelectingArea = false;
        this.selectionStart = null;
        this.selectionRectangle = null;
        this.setupEventListeners();
        this.initMap();
        this.init3DPreview();
    }

    setupEventListeners() {
        document.getElementById('generate-btn').addEventListener('click', () => this.generate());
        document.getElementById('include-roads').addEventListener('change', (e) => {
            document.getElementById('roads-settings').style.display = e.target.checked ? 'block' : 'none';
            this.onParameterChange();
        });
        document.getElementById('multi-material').addEventListener('change', (e) => {
            const downloadsDiv = document.getElementById('multi-material-downloads');
            downloadsDiv.style.display = e.target.checked ? 'block' : 'none';
        });
        
        // File list downloads are handled dynamically
        document.getElementById('update-map-btn').addEventListener('click', () => this.updateMapPreview());
        document.getElementById('search-city-btn').addEventListener('click', () => this.searchCity());
        document.getElementById('city-search').addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                this.searchCity();
            }
        });
        document.getElementById('select-area-btn').addEventListener('click', () => this.startAreaSelection());
        document.getElementById('clear-selection-btn').addEventListener('click', () => this.clearSelection());
        document.getElementById('reset-camera-btn').addEventListener('click', () => this.resetCamera());
        document.getElementById('wireframe-toggle').addEventListener('change', (e) => {
            const wireframe = e.target.checked;
            // Update single mesh
            if (this.stlMesh) {
                this.stlMesh.material.wireframe = wireframe;
            }
            // Update all layer meshes
            if (this.scene) {
                this.scene.traverse((child) => {
                    if (child instanceof THREE.Mesh && child.userData.isLayerMesh) {
                        child.material.wireframe = wireframe;
                    }
                });
            }
        });
        
        // Color picker event listeners
        document.getElementById('apply-colors-btn').addEventListener('click', () => this.applyColors());
        
        // Auto-apply colors when changed
        ['color-buildings', 'color-roads', 'color-greens', 'color-water'].forEach(id => {
            document.getElementById(id).addEventListener('change', () => this.applyColors());
        });
        
        // Update map when bbox inputs change
        ['bbox-north', 'bbox-east', 'bbox-south', 'bbox-west'].forEach(id => {
            const input = document.getElementById(id);
            let timeout;
            input.addEventListener('input', () => {
                clearTimeout(timeout);
                timeout = setTimeout(() => {
                    this.updateMapPreview();
                    this.onParameterChange();
                }, 500);
            });
        });

        // Listen to all parameter inputs for auto-generation
        const paramInputs = [
            'target-size', 'max-height', 'default-height', 'base-thickness',
            'road-width', 'road-height', 'include-greens', 'include-water'
        ];
        
        paramInputs.forEach(id => {
            const input = document.getElementById(id);
            if (input) {
                input.addEventListener('input', () => this.onParameterChange());
                input.addEventListener('change', () => this.onParameterChange());
            }
        });
    }

    onParameterChange() {
        const autoGenerate = document.getElementById('auto-generate');
        if (autoGenerate && autoGenerate.checked) {
            // Debounce auto-generation to avoid too many requests
            clearTimeout(this.autoGenerateTimeout);
            this.autoGenerateTimeout = setTimeout(() => {
                this.generate();
            }, 1500); // Wait 1.5 seconds after last change
        }
    }

    log(message, type = 'info') {
        const logEl = document.getElementById('log');
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        logEl.appendChild(entry);
        logEl.scrollTop = logEl.scrollHeight;
        console.log(message);
    }

    updateStatus(message, type = '') {
        const statusEl = document.getElementById('status');
        statusEl.textContent = message;
        statusEl.className = `status ${type}`;
    }

    updateProgress(percent) {
        const progressBar = document.getElementById('progress');
        const progressFill = document.getElementById('progress-fill');
        progressBar.style.display = 'block';
        progressFill.style.width = `${percent}%`;
    }

    async fetchOSMData(bbox) {
        const [north, east, south, west] = bbox;
        const includeGreens = document.getElementById('include-greens').checked;
        const includeWater = document.getElementById('include-water').checked;
        
        // Combined Overpass API query to reduce API calls and avoid rate limits
        let combinedQuery = `[out:json][timeout:180];
(
  way["building"](${south},${west},${north},${east});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|service|living_street|unclassified|cycleway|footway|path)"](${south},${west},${north},${east});`;

        if (includeGreens) {
            combinedQuery += `
  way["leisure"~"^(park|garden|playground|nature_reserve)$"](${south},${west},${north},${east});
  way["landuse"~"^(forest|grass|meadow|recreation_ground|village_green)$"](${south},${west},${north},${east});
  relation["leisure"~"^(park|garden|playground|nature_reserve)$"](${south},${west},${north},${east});
  relation["landuse"~"^(forest|grass|meadow|recreation_ground|village_green)$"](${south},${west},${north},${east});`;
        }

        if (includeWater) {
            combinedQuery += `
  way["natural"~"^(water|bay)$"](${south},${west},${north},${east});
  way["waterway"](${south},${west},${north},${east});
  relation["natural"~"^(water|bay)$"](${south},${west},${north},${east});
  relation["waterway"](${south},${west},${north},${east});`;
        }

        combinedQuery += `
);
out body;
>;
out skel qt;`;

        this.log('Fetching all OSM data in a single request...');
        const allData = await this.queryOverpass(combinedQuery);
        
        // Separate the data by type
        const buildings = [];
        const roads = [];
        const greens = [];
        const water = [];

        allData.forEach(feature => {
            const tags = feature.tags || {};
            
            if (tags.building) {
                buildings.push(feature);
            } else if (tags.highway) {
                roads.push(feature);
            } else if (tags.leisure || tags.landuse) {
                const leisure = tags.leisure || '';
                const landuse = tags.landuse || '';
                if (['park', 'garden', 'playground', 'nature_reserve'].includes(leisure) ||
                    ['forest', 'grass', 'meadow', 'recreation_ground', 'village_green'].includes(landuse)) {
                    greens.push(feature);
                }
            } else if (tags.natural === 'water' || tags.natural === 'bay' || tags.waterway) {
                water.push(feature);
            }
        });

        this.log(`Found ${buildings.length} buildings, ${roads.length} roads`);
        if (includeGreens) {
            this.log(`Found ${greens.length} green spaces`);
        }
        if (includeWater) {
            this.log(`Found ${water.length} water bodies`);
        }

        return { buildings, roads, greens, water };
    }

    async queryOverpass(query) {
        const overpassUrl = 'https://overpass-api.de/api/interpreter';
        
        try {
            const response = await fetch(overpassUrl, {
                method: 'POST',
                body: query,
                headers: {
                    'Content-Type': 'text/plain'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            return this.parseOSMData(data);
        } catch (error) {
            this.log(`Error fetching OSM data: ${error.message}`, 'error');
            throw error;
        }
    }

    parseOSMData(data) {
        const nodes = {};
        const ways = [];

        // First pass: index all nodes
        if (data.elements) {
            data.elements.forEach(element => {
                if (element.type === 'node') {
                    nodes[element.id] = { lat: element.lat, lon: element.lon };
                } else if (element.type === 'way') {
                    ways.push(element);
                }
            });
        }

        // Second pass: convert ways to geometries
        const geometries = [];
        ways.forEach(way => {
            if (way.nodes && way.nodes.length >= 2) {
                const coords = way.nodes
                    .map(nodeId => {
                        const node = nodes[nodeId];
                        return node ? [node.lon, node.lat] : null;
                    })
                    .filter(coord => coord !== null);

                if (coords.length >= 2) {
                    // Check if closed polygon (first and last points are the same or very close)
                    const first = coords[0];
                    const last = coords[coords.length - 1];
                    const isClosed = coords.length >= 4 && 
                        Math.abs(first[0] - last[0]) < 1e-9 && 
                        Math.abs(first[1] - last[1]) < 1e-9;
                    
                    if (isClosed && coords.length >= 4) {
                        // Ensure polygon is closed
                        if (coords[0][0] !== coords[coords.length - 1][0] ||
                            coords[0][1] !== coords[coords.length - 1][1]) {
                            coords.push([...coords[0]]);
                        }
                        geometries.push({
                            type: 'Polygon',
                            coordinates: [coords],
                            tags: way.tags || {}
                        });
                    } else if (coords.length >= 2) {
                        geometries.push({
                            type: 'LineString',
                            coordinates: coords,
                            tags: way.tags || {}
                        });
                    }
                }
            }
        });

        return geometries;
    }

    getBuildingHeight(feature, defaultHeight) {
        const tags = feature.tags || {};
        const heightAttrs = ['height', 'building:height', 'building:levels'];
        
        for (const attr of heightAttrs) {
            if (tags[attr] !== undefined) {
                const height = tags[attr];
                if (typeof height === 'number' && !isNaN(height)) {
                    if (attr === 'building:levels') {
                        return height * 3; // meters per level
                    }
                    return height;
                } else if (typeof height === 'string') {
                    const match = height.match(/(\d+\.?\d*)/);
                    if (match) {
                        return parseFloat(match[1]);
                    }
                }
            }
        }
        return defaultHeight;
    }

    createSolidBase(baseSize, baseThickness) {
        return this.geometryProcessor.createSolidBase(baseSize, baseThickness);
    }

    fanTriangulate(loopIndices, facesOut) {
        if (loopIndices.length < 3) return;
        for (let i = 1; i < loopIndices.length - 1; i++) {
            facesOut.push([loopIndices[0], loopIndices[i], loopIndices[i + 1]]);
        }
    }

    addPrismFromPolygon(coords, z0, z1) {
        // Delegate to geometry processor
        this.geometryProcessor.vertices = this.vertices;
        this.geometryProcessor.faces = this.faces;
        this.geometryProcessor.addPrismFromPolygon(coords, z0, z1);
        this.vertices = this.geometryProcessor.vertices;
        this.faces = this.geometryProcessor.faces;
    }

    addPrismFromPolygon_OLD(coords, z0, z1) {
        // Safety check: skip overly complex polygons
        if (!coords || coords.length < 3) {
            return;
        }
        
        // Remove duplicate last point if present
        const cleanCoords = coords.length > 0 && 
            coords[0][0] === coords[coords.length - 1][0] && 
            coords[0][1] === coords[coords.length - 1][1]
            ? coords.slice(0, -1) 
            : coords;
        
        const n = cleanCoords.length;
        
        // Skip polygons with too many vertices (prevents memory issues)
        if (n > 500) {
            console.warn(`Skipping polygon with ${n} vertices (too complex)`);
            return;
        }
        
        const baseIndex = this.vertices.length;

        // Add vertical pairs (optimized to avoid large array operations)
        for (let i = 0; i < n; i++) {
            const [x, y] = cleanCoords[i];
            this.vertices.push([x, y, z0]);
            this.vertices.push([x, y, z1]);
        }

        // Side faces
        for (let i = 0; i < n; i++) {
            const iNext = (i + 1) % n;
            const b1 = baseIndex + 2 * i;
            const t1 = baseIndex + 2 * i + 1;
            const b2 = baseIndex + 2 * iNext;
            const t2 = baseIndex + 2 * iNext + 1;
            
            this.faces.push([b1, b2, t1]);
            this.faces.push([t1, b2, t2]);
        }

        // Top and bottom faces (optimized - build indices directly instead of Array.from)
        const topStart = baseIndex + 1;
        const bottomStart = baseIndex;
        
        // Fan triangulate directly without creating large intermediate arrays
        for (let i = 1; i < n - 1; i++) {
            // Bottom face (reverse winding)
            this.faces.push([bottomStart, bottomStart + 2 * (i + 1), bottomStart + 2 * i]);
            // Top face
            this.faces.push([topStart, topStart + 2 * i, topStart + 2 * (i + 1)]);
        }
    }

    triangulatePolygon(coords) {
        // Safety check
        if (!coords || coords.length < 3 || coords.length > 1000) {
            return [];
        }
        
        // Simplified fan triangulation - more reliable and avoids stack overflow
        // Remove duplicate last point if present
        const cleanCoords = coords.length > 0 && 
            coords[0][0] === coords[coords.length - 1][0] && 
            coords[0][1] === coords[coords.length - 1][1]
            ? coords.slice(0, -1) 
            : coords;
        
        if (cleanCoords.length < 3 || cleanCoords.length > 1000) {
            return [];
        }
        
        const triangles = [];
        const n = cleanCoords.length;
        
        // Simple fan triangulation from first vertex
        // This is guaranteed to work and won't cause stack overflow
        for (let i = 1; i < n - 1; i++) {
            triangles.push([0, i, i + 1]);
        }
        
        return triangles;
    }

    pointInTriangle(p, p0, p1, p2) {
        const dX = p[0] - p2[0];
        const dY = p[1] - p2[1];
        const dX21 = p2[0] - p1[0];
        const dY12 = p1[1] - p2[1];
        const D = dY12 * (p0[0] - p2[0]) + dX21 * (p0[1] - p2[1]);
        const s = dY12 * dX + dX21 * dY;
        const t = (p2[1] - p0[1]) * dX + (p0[0] - p2[0]) * dY;
        
        if (D < 0) return s <= 0 && t <= 0 && s + t >= D;
        return s >= 0 && t >= 0 && s + t <= D;
    }

    addPrismFromPolygonTriangulated(coords, z0, z1) {
        // Delegate to geometry processor
        this.geometryProcessor.vertices = this.vertices;
        this.geometryProcessor.faces = this.faces;
        this.geometryProcessor.addPrismFromPolygonTriangulated(coords, z0, z1);
        this.vertices = this.geometryProcessor.vertices;
        this.faces = this.geometryProcessor.faces;
    }

    addPrismFromPolygonTriangulated_OLD(coords, z0, z1) {
        // Safety check: skip if too many vertices (prevents stack overflow)
        if (!coords || coords.length < 3 || coords.length > 1000) {
            return; // Skip invalid or overly complex polygons
        }
        
        // Remove duplicate last point if present
        const cleanCoords = coords.length > 0 && 
            coords[0][0] === coords[coords.length - 1][0] && 
            coords[0][1] === coords[coords.length - 1][1]
            ? coords.slice(0, -1) 
            : coords;
        
        if (cleanCoords.length < 3 || cleanCoords.length > 1000) {
            return; // Skip invalid polygons
        }
        
        const n = cleanCoords.length;
        const baseIndex = this.vertices.length;
        
        // Triangulate the polygon (using simple fan triangulation)
        const triangles = this.triangulatePolygon(cleanCoords);
        
        if (triangles.length === 0) {
            return; // Skip if triangulation failed
        }
        
        // Add vertices for bottom and top
        const bottomStart = this.vertices.length;
        cleanCoords.forEach(([x, y]) => {
            this.vertices.push([x, y, z0]);
        });
        
        const topStart = this.vertices.length;
        cleanCoords.forEach(([x, y]) => {
            this.vertices.push([x, y, z1]);
        });
        
        // Add faces for triangulated top and bottom
        triangles.forEach(tri => {
            // Bottom face (reverse winding for correct normal)
            this.faces.push([bottomStart + tri[0], bottomStart + tri[2], bottomStart + tri[1]]);
            // Top face
            this.faces.push([topStart + tri[0], topStart + tri[1], topStart + tri[2]]);
        });
        
        // Outer vertical wall
        for (let i = 0; i < n; i++) {
            const j = (i + 1) % n;
            const b1 = bottomStart + i;
            const t1 = topStart + i;
            const b2 = bottomStart + j;
            const t2 = topStart + j;
            
            // Two triangles per wall segment
            this.faces.push([b1, b2, t1]);
            this.faces.push([t1, b2, t2]);
        }
    }

    bufferLineString(coords, width) {
        return this.geometryProcessor.bufferLineString(coords, width);
    }

    bufferLineString_OLD(coords, width) {
        // Buffer a line string by creating perpendicular offsets
        if (coords.length < 2) return [];
        
        const buffered = [];
        const halfWidth = width / 2;
        
        // Build left and right sides
        const left = [];
        const right = [];
        
        for (let i = 0; i < coords.length; i++) {
            let dx, dy, len;
            
            if (i === 0) {
                // First point: use next segment
                dx = coords[1][0] - coords[0][0];
                dy = coords[1][1] - coords[0][1];
            } else if (i === coords.length - 1) {
                // Last point: use previous segment
                dx = coords[i][0] - coords[i - 1][0];
                dy = coords[i][1] - coords[i - 1][1];
            } else {
                // Middle point: average of adjacent segments
                const dx1 = coords[i][0] - coords[i - 1][0];
                const dy1 = coords[i][1] - coords[i - 1][1];
                const dx2 = coords[i + 1][0] - coords[i][0];
                const dy2 = coords[i + 1][1] - coords[i][1];
                dx = (dx1 + dx2) / 2;
                dy = (dy1 + dy2) / 2;
            }
            
            len = Math.sqrt(dx * dx + dy * dy);
            if (len < 1e-10) continue;
            
            const perpX = -dy / len * halfWidth;
            const perpY = dx / len * halfWidth;
            
            left.push([coords[i][0] + perpX, coords[i][1] + perpY]);
            right.push([coords[i][0] - perpX, coords[i][1] - perpY]);
        }
        
        // Create quads from segments
        for (let i = 0; i < left.length - 1; i++) {
            buffered.push([
                left[i],
                right[i],
                right[i + 1],
                left[i + 1]
            ]);
        }
        
        return buffered;
    }

    async processLayer(features, bbox, config, layerType, progressStart = 0, progressRange = 20) {
        const [north, east, south, west] = bbox;
        const latRange = north - south;
        const lonRange = east - west;
        
        const targetSize = config.targetSize;
        const baseSize = targetSize * 1.2;
        const scaleX = targetSize / lonRange;
        const scaleY = targetSize / latRange;
        const centerOffsetX = (baseSize - (scaleX * lonRange)) / 2;
        const centerOffsetY = (baseSize - (scaleY * latRange)) / 2;
        
        const toModelXY = (lon, lat) => {
            const x = ((lon - west) * scaleX) + centerOffsetX;
            const y = ((lat - south) * scaleY) + centerOffsetY;
            return [x, y];
        };
        
        let vertices = [];
        let faces = [];
        const tempVertices = [];
        const tempFaces = [];
        
        // Save current state
        const oldVertices = this.vertices;
        const oldFaces = this.faces;
        this.vertices = tempVertices;
        this.faces = tempFaces;
        
        if (!features || features.length === 0) {
            this.vertices = oldVertices;
            this.faces = oldFaces;
            return { vertices, faces };
        }
        
        this.log(`Processing ${features.length} ${layerType} features...`);
        
        // Process in chunks to avoid blocking UI
        const CHUNK_SIZE = 50;
        const totalChunks = Math.ceil(features.length / CHUNK_SIZE);
        
        if (layerType === 'buildings') {
            // Find max building height
            let maxBuildingHeight = 0;
            features.forEach(feature => {
                const height = this.getBuildingHeight(feature, config.defaultHeight);
                maxBuildingHeight = Math.max(maxBuildingHeight, height);
            });
            
            const heightScale = maxBuildingHeight > 0 ? (config.maxHeight / maxBuildingHeight) : 1.0;
            
            for (let chunk = 0; chunk < totalChunks; chunk++) {
                const start = chunk * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, features.length);
                
                for (let i = start; i < end; i++) {
                    const feature = features[i];
                    if (feature.type === 'Polygon' && feature.coordinates) {
                        const exterior = feature.coordinates[0];
                        
                        // Safety check: skip buildings with too many vertices
                        if (exterior.length > 500) {
                            continue;
                        }
                        
                        const modelCoords = exterior.map(([lon, lat]) => toModelXY(lon, lat));
                        
                        if (modelCoords[0][0] !== modelCoords[modelCoords.length - 1][0] ||
                            modelCoords[0][1] !== modelCoords[modelCoords.length - 1][1]) {
                            modelCoords.push([...modelCoords[0]]);
                        }
                        
                        const height = this.getBuildingHeight(feature, config.defaultHeight) * heightScale;
                        this.addPrismFromPolygon(modelCoords, config.baseThickness, config.baseThickness + height);
                    }
                }
                
                // Yield to UI after each chunk to prevent stack overflow
                if (chunk < totalChunks - 1) {
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
                
                // Update progress and yield to UI
                if (chunk < totalChunks - 1) {
                    this.updateProgress(progressStart + ((chunk + 1) / totalChunks) * progressRange);
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
        } else if (layerType === 'roads') {
            const roadWidth = config.roadWidth;
            const z0 = config.baseThickness + 0.02;
            const z1 = z0 + config.roadHeight;
            const baseRect = { minX: 0, minY: 0, maxX: baseSize, maxY: baseSize };
            
            for (let chunk = 0; chunk < totalChunks; chunk++) {
                const start = chunk * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, features.length);
                
                for (let i = start; i < end; i++) {
                    const feature = features[i];
                    if (feature.type === 'LineString' && feature.coordinates && feature.coordinates.length >= 2) {
                        const modelCoords = feature.coordinates.map(([lon, lat]) => toModelXY(lon, lat));
                        const buffered = this.bufferLineString(modelCoords, roadWidth);
                        
                        buffered.forEach(quad => {
                            if (quad.length < 3) return;
                            const validQuad = quad.filter(([x, y]) => 
                                x >= baseRect.minX - roadWidth && x <= baseRect.maxX + roadWidth &&
                                y >= baseRect.minY - roadWidth && y <= baseRect.maxY + roadWidth
                            );
                            
                            if (validQuad.length >= 3) {
                                const first = validQuad[0];
                                const last = validQuad[validQuad.length - 1];
                                if (Math.abs(first[0] - last[0]) > 1e-6 || Math.abs(first[1] - last[1]) > 1e-6) {
                                    validQuad.push([...first]);
                                }
                                try {
                                    this.addPrismFromPolygonTriangulated(validQuad, z0, z1);
                                } catch (e) {
                                    console.warn('Skipping invalid geometry:', e);
                                }
                            }
                        });
                    }
                }
                
                if (chunk < totalChunks - 1) {
                    this.updateProgress(progressStart + ((chunk + 1) / totalChunks) * progressRange);
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
        } else if (layerType === 'greens' || layerType === 'water') {
            const z0 = config.baseThickness + 0.01;
            const z1 = z0 + 0.5;
            
            for (let chunk = 0; chunk < totalChunks; chunk++) {
                const start = chunk * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, features.length);
                
                for (let i = start; i < end; i++) {
                    const feature = features[i];
                    if (feature.type === 'Polygon' && feature.coordinates) {
                        const exterior = feature.coordinates[0];
                        const modelCoords = exterior.map(([lon, lat]) => toModelXY(lon, lat));
                        
                        if (modelCoords[0][0] !== modelCoords[modelCoords.length - 1][0] ||
                            modelCoords[0][1] !== modelCoords[modelCoords.length - 1][1]) {
                            modelCoords.push([...modelCoords[0]]);
                        }
                        
                        try {
                            this.addPrismFromPolygonTriangulated(modelCoords, z0, z1);
                        } catch (e) {
                            console.warn('Skipping invalid geometry:', e);
                        }
                    }
                }
                
                if (chunk < totalChunks - 1) {
                    this.updateProgress(progressStart + ((chunk + 1) / totalChunks) * progressRange);
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
        }
        
        // Restore state - avoid spread operator for large arrays to prevent stack overflow
        // Direct assignment is most efficient for large arrays
        vertices = tempVertices;
        faces = tempFaces;
        this.vertices = oldVertices;
        this.faces = oldFaces;
        
        this.log(`Processed ${features.length} ${layerType} features`);
        return { vertices, faces };
    }

    async scaleCoordinates(buildings, roads, greens, water, bbox, config) {
        const [north, east, south, west] = bbox;
        const latRange = north - south;
        const lonRange = east - west;
        
        const targetSize = config.targetSize;
        const baseSize = targetSize * 1.2;
        const scaleX = targetSize / lonRange;
        const scaleY = targetSize / latRange;
        const centerOffsetX = (baseSize - (scaleX * lonRange)) / 2;
        const centerOffsetY = (baseSize - (scaleY * latRange)) / 2;
        
        const toModelXY = (lon, lat) => {
            const x = ((lon - west) * scaleX) + centerOffsetX;
            const y = ((lat - south) * scaleY) + centerOffsetY;
            return [x, y];
        };
        
        this.vertices = [];
        this.faces = [];
        
        // 1) Base
        const { vertices: baseVerts, faces: baseFaces } = this.createSolidBase(baseSize, config.baseThickness);
        this.vertices.push(...baseVerts);
        this.faces.push(...baseFaces);
        
        // 2) Buildings
        if (buildings && buildings.length > 0) {
            this.log(`Processing ${buildings.length} buildings...`);
            
            let maxBuildingHeight = 0;
            buildings.forEach(feature => {
                const height = this.getBuildingHeight(feature, config.defaultHeight);
                maxBuildingHeight = Math.max(maxBuildingHeight, height);
            });
            
            const heightScale = maxBuildingHeight > 0 ? (config.maxHeight / maxBuildingHeight) : 1.0;
            
            // Process buildings in chunks to avoid blocking
            const BUILDING_CHUNK = 50; // Smaller chunks to prevent stack overflow
            for (let i = 0; i < buildings.length; i++) {
                const feature = buildings[i];
                if (feature.type === 'Polygon' && feature.coordinates) {
                    const exterior = feature.coordinates[0];
                    
                    // Safety check: skip buildings with too many vertices
                    if (exterior.length > 500) {
                        continue;
                    }
                    
                    const modelCoords = exterior.map(([lon, lat]) => toModelXY(lon, lat));
                    
                    if (modelCoords[0][0] !== modelCoords[modelCoords.length - 1][0] ||
                        modelCoords[0][1] !== modelCoords[modelCoords.length - 1][1]) {
                        modelCoords.push([...modelCoords[0]]);
                    }
                    
                    const height = this.getBuildingHeight(feature, config.defaultHeight) * heightScale;
                    this.addPrismFromPolygon(modelCoords, config.baseThickness, config.baseThickness + height);
                }
                
                if ((i + 1) % BUILDING_CHUNK === 0) {
                    this.updateProgress(10 + ((i + 1) / buildings.length * 20));
                    // Yield to UI every chunk to prevent stack overflow
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
            
            this.log(`Processed ${buildings.length} buildings`);
        }
        
        // 3) Roads
        if (config.includeRoads && roads && roads.length > 0) {
            this.log(`Processing ${roads.length} road segments...`);
            
            const roadWidth = config.roadWidth;
            const z0 = config.baseThickness + 0.02;
            const z1 = z0 + config.roadHeight;
            const baseRect = { minX: 0, minY: 0, maxX: baseSize, maxY: baseSize };
            
            let count = 0;
            const ROAD_CHUNK = 50;
            for (let idx = 0; idx < roads.length; idx++) {
                const feature = roads[idx];
                if (feature.type === 'LineString' && feature.coordinates && feature.coordinates.length >= 2) {
                    const modelCoords = feature.coordinates.map(([lon, lat]) => toModelXY(lon, lat));
                    const buffered = this.bufferLineString(modelCoords, roadWidth);
                    
                    buffered.forEach(quad => {
                        if (quad.length < 3) return;
                        const validQuad = quad.filter(([x, y]) => 
                            x >= baseRect.minX - roadWidth && x <= baseRect.maxX + roadWidth &&
                            y >= baseRect.minY - roadWidth && y <= baseRect.maxY + roadWidth
                        );
                        
                        if (validQuad.length >= 3) {
                            const first = validQuad[0];
                            const last = validQuad[validQuad.length - 1];
                            if (Math.abs(first[0] - last[0]) > 1e-6 || Math.abs(first[1] - last[1]) > 1e-6) {
                                validQuad.push([...first]);
                            }
                            try {
                                this.addPrismFromPolygonTriangulated(validQuad, z0, z1);
                                count++;
                            } catch (e) {
                                console.warn('Skipping invalid road geometry:', e);
                            }
                        }
                    });
                }
                
                if ((idx + 1) % ROAD_CHUNK === 0) {
                    this.updateProgress(30 + ((idx + 1) / roads.length * 20));
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
            
            this.log(`Processed ${count} road pieces`);
        }

        // 4) Greens
        if (config.includeGreens && greens && greens.length > 0) {
            this.log(`Processing ${greens.length} green spaces...`);
            const z0 = config.baseThickness + 0.01;
            const z1 = z0 + 0.5;
            
            const GREEN_CHUNK = 50;
            for (let idx = 0; idx < greens.length; idx++) {
                const feature = greens[idx];
                if (feature.type === 'Polygon' && feature.coordinates) {
                    const exterior = feature.coordinates[0];
                    const modelCoords = exterior.map(([lon, lat]) => toModelXY(lon, lat));
                    
                    if (modelCoords[0][0] !== modelCoords[modelCoords.length - 1][0] ||
                        modelCoords[0][1] !== modelCoords[modelCoords.length - 1][1]) {
                        modelCoords.push([...modelCoords[0]]);
                    }
                    
                    try {
                        this.addPrismFromPolygonTriangulated(modelCoords, z0, z1);
                    } catch (e) {
                        console.warn('Skipping invalid green geometry:', e);
                    }
                }
                
                if ((idx + 1) % GREEN_CHUNK === 0) {
                    this.updateProgress(50 + ((idx + 1) / greens.length * 10));
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
            
            this.log(`Processed ${greens.length} green spaces`);
        }

        // 5) Water
        if (config.includeWater && water && water.length > 0) {
            this.log(`Processing ${water.length} water bodies...`);
            const z0 = config.baseThickness + 0.01;
            const z1 = z0 + 0.5;
            
            const WATER_CHUNK = 50;
            for (let idx = 0; idx < water.length; idx++) {
                const feature = water[idx];
                if (feature.type === 'Polygon' && feature.coordinates) {
                    const exterior = feature.coordinates[0];
                    const modelCoords = exterior.map(([lon, lat]) => toModelXY(lon, lat));
                    
                    if (modelCoords[0][0] !== modelCoords[modelCoords.length - 1][0] ||
                        modelCoords[0][1] !== modelCoords[modelCoords.length - 1][1]) {
                        modelCoords.push([...modelCoords[0]]);
                    }
                    
                    try {
                        this.addPrismFromPolygonTriangulated(modelCoords, z0, z1);
                    } catch (e) {
                        console.warn('Skipping invalid water geometry:', e);
                    }
                }
                
                if ((idx + 1) % WATER_CHUNK === 0) {
                    this.updateProgress(60 + ((idx + 1) / water.length * 10));
                    await new Promise(resolve => setTimeout(resolve, 0));
                }
            }
            
            this.log(`Processed ${water.length} water bodies`);
        }
        
        return { vertices: this.vertices, faces: this.faces };
    }

    generateSTL(vertices, faces, filename) {
        // Validate mesh before generating
        const validation = this.stlGenerator.validateMesh(vertices, faces);
        if (!validation.valid) {
            console.warn('Mesh validation failed:', validation.errors);
            // Continue anyway, but log the issues
        }
        return this.stlGenerator.generateSTL(vertices, faces, filename);
    }

    downloadSTL(content, filename) {
        const blob = new Blob([content], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    downloadGeneratedSTL() {
        if (!this.generatedSTLContent || !this.generatedSTLFilename) {
            this.updateStatus('No STL file generated yet. Please generate first.', 'error');
            this.log('No STL file available for download', 'error');
            return;
        }
        
        this.downloadSTL(this.generatedSTLContent, this.generatedSTLFilename);
        this.updateStatus('STL file downloaded!', 'success');
        this.log('STL file downloaded successfully!', 'success');
    }

    async searchCity() {
        const cityInput = document.getElementById('city-search');
        const cityName = cityInput.value.trim();
        const resultsDiv = document.getElementById('city-search-results');
        
        if (!cityName) {
            resultsDiv.innerHTML = '<div class="search-error">Please enter a city name</div>';
            return;
        }
        
        resultsDiv.innerHTML = '<div class="search-loading">Searching...</div>';
        
        try {
            // Use Nominatim geocoding API
            const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(cityName)}&limit=5&addressdetails=1`;
            
            const response = await fetch(url, {
                headers: {
                    'User-Agent': 'OSM-to-3D-Print-WebApp/1.0'
                }
            });
            
            if (!response.ok) {
                throw new Error('Geocoding service unavailable');
            }
            
            const data = await response.json();
            
            if (data.length === 0) {
                resultsDiv.innerHTML = '<div class="search-error">No results found. Try a different city name.</div>';
                return;
            }
            
            // Show results
            let resultsHTML = '<div class="search-results-list">';
            data.forEach((result, idx) => {
                const displayName = result.display_name.split(',').slice(0, 3).join(',');
                resultsHTML += `
                    <div class="search-result-item" data-index="${idx}">
                        <strong>${displayName}</strong>
                        <small>${result.type}</small>
                    </div>
                `;
            });
            resultsHTML += '</div>';
            resultsDiv.innerHTML = resultsHTML;
            
            // Add click handlers
            data.forEach((result, idx) => {
                document.querySelector(`.search-result-item[data-index="${idx}"]`).addEventListener('click', () => {
                    this.selectCityResult(result);
                });
            });
            
        } catch (error) {
            this.log(`Error searching city: ${error.message}`, 'error');
            resultsDiv.innerHTML = `<div class="search-error">Error: ${error.message}</div>`;
        }
    }

    selectCityResult(result) {
        // Extract bounding box from result
        const bbox = result.boundingbox; // [south, north, west, east] as strings
        
        if (bbox && bbox.length === 4) {
            const south = parseFloat(bbox[0]);
            const north = parseFloat(bbox[1]);
            const west = parseFloat(bbox[2]);
            const east = parseFloat(bbox[3]);
            
            // Update input fields
            document.getElementById('bbox-north').value = north.toFixed(6);
            document.getElementById('bbox-south').value = south.toFixed(6);
            document.getElementById('bbox-east').value = east.toFixed(6);
            document.getElementById('bbox-west').value = west.toFixed(6);
            
            // Update city search field
            document.getElementById('city-search').value = result.display_name.split(',')[0];
            
            // Clear results
            document.getElementById('city-search-results').innerHTML = '';
            
            // Update map
            this.updateMapPreview();
            
            // Trigger parameter change (may auto-generate)
            this.onParameterChange();
            
            this.log(`Selected: ${result.display_name}`);
            this.updateStatus(`Location set: ${result.display_name.split(',')[0]}`, 'success');
        } else {
            // Fallback: use lat/lon with a default bounding box size
            const lat = parseFloat(result.lat);
            const lon = parseFloat(result.lon);
            const size = 0.02; // ~2km
            
            document.getElementById('bbox-north').value = (lat + size).toFixed(6);
            document.getElementById('bbox-south').value = (lat - size).toFixed(6);
            document.getElementById('bbox-east').value = (lon + size).toFixed(6);
            document.getElementById('bbox-west').value = (lon - size).toFixed(6);
            
            document.getElementById('city-search').value = result.display_name.split(',')[0];
            document.getElementById('city-search-results').innerHTML = '';
            
            this.updateMapPreview();
            this.onParameterChange();
            
            this.log(`Selected: ${result.display_name} (using default bounding box)`);
            this.updateStatus(`Location set: ${result.display_name.split(',')[0]}`, 'success');
        }
    }

    initMap() {
        const mapEl = document.getElementById('map-preview');
        if (!mapEl) return;

        // Initialize map centered on default location
        this.map = L.map(mapEl).setView([39.9525, -75.1635], 13);
        
        // Add OpenStreetMap tiles
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 19
        }).addTo(this.map);

        // Setup map event listeners for area selection
        this.setupMapSelection();

        // Initial map preview
        this.updateMapPreview();
    }

    setupMapSelection() {
        if (!this.map) return;

        // Mouse events for drawing selection rectangle
        this.map.on('mousedown', (e) => {
            if (this.isSelectingArea) {
                e.originalEvent.preventDefault();
                this.selectionStart = e.latlng;
                this.map.dragging.disable();
            }
        });

        this.map.on('mousemove', (e) => {
            if (this.isSelectingArea && this.selectionStart) {
                e.originalEvent.preventDefault();
                this.updateSelectionRectangle(this.selectionStart, e.latlng);
            }
        });

        this.map.on('mouseup', (e) => {
            if (this.isSelectingArea && this.selectionStart) {
                e.originalEvent.preventDefault();
                this.finishAreaSelection(this.selectionStart, e.latlng);
                this.map.dragging.enable();
            }
        });

        // Prevent map dragging when selecting
        this.map.on('dragstart', () => {
            if (this.isSelectingArea) {
                this.map.dragging.disable();
            }
        });
    }

    startAreaSelection() {
        this.isSelectingArea = true;
        this.map.getContainer().style.cursor = 'crosshair';
        document.getElementById('select-area-btn').textContent = 'Click and drag on map...';
        document.getElementById('select-area-btn').disabled = true;
        document.getElementById('clear-selection-btn').style.display = 'inline-block';
        
        // Clear any existing selection rectangle
        if (this.selectionRectangle) {
            this.map.removeLayer(this.selectionRectangle);
            this.selectionRectangle = null;
        }
        
        this.updateStatus('Click and drag on the map to select your area', 'loading');
    }

    updateSelectionRectangle(startLatLng, endLatLng) {
        // Remove existing rectangle
        if (this.selectionRectangle) {
            this.map.removeLayer(this.selectionRectangle);
        }

        // Create bounds from start and end points
        const bounds = L.latLngBounds(startLatLng, endLatLng);
        
        // Draw selection rectangle
        this.selectionRectangle = L.rectangle(bounds, {
            color: '#ff6b6b',
            fillColor: '#ff6b6b',
            fillOpacity: 0.3,
            weight: 2,
            dashArray: '5, 5'
        }).addTo(this.map);
    }

    finishAreaSelection(startLatLng, endLatLng) {
        if (!this.isSelectingArea) return;

        // Calculate bounding box
        const north = Math.max(startLatLng.lat, endLatLng.lat);
        const south = Math.min(startLatLng.lat, endLatLng.lat);
        const east = Math.max(startLatLng.lng, endLatLng.lng);
        const west = Math.min(startLatLng.lng, endLatLng.lng);

        // Update input fields
        document.getElementById('bbox-north').value = north.toFixed(6);
        document.getElementById('bbox-south').value = south.toFixed(6);
        document.getElementById('bbox-east').value = east.toFixed(6);
        document.getElementById('bbox-west').value = west.toFixed(6);

        // Update the display rectangle to match the bbox rectangle style
        if (this.mapRectangle) {
            this.map.removeLayer(this.mapRectangle);
        }
        
        const bounds = [[south, west], [north, east]];
        this.mapRectangle = L.rectangle(bounds, {
            color: '#667eea',
            fillColor: '#667eea',
            fillOpacity: 0.2,
            weight: 2
        }).addTo(this.map);

        // Convert selection rectangle to permanent display
        if (this.selectionRectangle) {
            this.map.removeLayer(this.selectionRectangle);
            this.selectionRectangle = null;
        }

        // Reset selection mode
        this.isSelectingArea = false;
        this.selectionStart = null;
        this.map.getContainer().style.cursor = '';
        document.getElementById('select-area-btn').textContent = 'Select Area on Map';
        document.getElementById('select-area-btn').disabled = false;

        // Fit map to bounds
        this.map.fitBounds(bounds);

        this.updateStatus('Area selected! Bounding box updated.', 'success');
        this.log(`Bounding box updated: N=${north.toFixed(6)}, E=${east.toFixed(6)}, S=${south.toFixed(6)}, W=${west.toFixed(6)}`);

        // Trigger parameter change (which may auto-generate)
        this.onParameterChange();
    }

    clearSelection() {
        this.isSelectingArea = false;
        this.selectionStart = null;
        this.map.getContainer().style.cursor = '';
        document.getElementById('select-area-btn').textContent = 'Select Area on Map';
        document.getElementById('select-area-btn').disabled = false;
        document.getElementById('clear-selection-btn').style.display = 'none';

        // Remove selection rectangle
        if (this.selectionRectangle) {
            this.map.removeLayer(this.selectionRectangle);
            this.selectionRectangle = null;
        }

        // Remove display rectangle
        if (this.mapRectangle) {
            this.map.removeLayer(this.mapRectangle);
            this.mapRectangle = null;
        }

        this.updateStatus('Selection cleared', '');
    }

    updateMapPreview() {
        if (!this.map) return;

        try {
            const bbox = [
                parseFloat(document.getElementById('bbox-north').value),
                parseFloat(document.getElementById('bbox-east').value),
                parseFloat(document.getElementById('bbox-south').value),
                parseFloat(document.getElementById('bbox-west').value)
            ];

            if (bbox.some(isNaN) || bbox[0] <= bbox[2] || bbox[1] <= bbox[3]) {
                return; // Invalid bbox
            }

            const [north, east, south, west] = bbox;
            const centerLat = (north + south) / 2;
            const centerLon = (east + west) / 2;

            // Update map view
            this.map.setView([centerLat, centerLon], 13);

            // Remove existing rectangle (but not if we're in selection mode)
            if (this.mapRectangle && !this.isSelectingArea) {
                this.map.removeLayer(this.mapRectangle);
            }

            // Add bounding box rectangle (only if not selecting)
            if (!this.isSelectingArea) {
                const bounds = [[south, west], [north, east]];
                this.mapRectangle = L.rectangle(bounds, {
                    color: '#667eea',
                    fillColor: '#667eea',
                    fillOpacity: 0.2,
                    weight: 2
                }).addTo(this.map);

                // Fit map to bounds
                this.map.fitBounds(bounds);
            }
        } catch (error) {
            console.error('Error updating map:', error);
        }
    }

    init3DPreview() {
        const container = document.getElementById('stl-preview');
        if (!container) return;

        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x1a1a1a);

        // Camera
        this.camera = new THREE.PerspectiveCamera(
            75,
            container.clientWidth / container.clientHeight,
            0.1,
            1000
        );
        // Initial camera position - view with Y (Z in model) pointing up
        this.camera.position.set(100, 120, 100);
        this.camera.lookAt(0, 0, 0);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(container.clientWidth, container.clientHeight);
        this.renderer.shadowMap.enabled = true;
        container.innerHTML = '';
        container.appendChild(this.renderer.domElement);

        // Controls - try OrbitControls, fallback to simple controls
        // Wait a bit for OrbitControls to load if needed
        const initControls = () => {
            let OrbitControlsClass = null;
            if (typeof THREE !== 'undefined' && THREE.OrbitControls) {
                OrbitControlsClass = THREE.OrbitControls;
            } else if (typeof OrbitControls !== 'undefined') {
                OrbitControlsClass = OrbitControls;
            }
            
            if (OrbitControlsClass) {
                this.controls = new OrbitControlsClass(this.camera, this.renderer.domElement);
                this.controls.enableDamping = true;
                this.controls.dampingFactor = 0.05;
                return true;
            }
            return false;
        };
        
        if (!initControls()) {
            // Fallback: simple mouse controls
            let isDragging = false;
            let previousMousePosition = { x: 0, y: 0 };
            
            container.addEventListener('mousedown', (e) => {
                isDragging = true;
                previousMousePosition = { x: e.clientX, y: e.clientY };
            });
            
            container.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                
                const deltaX = e.clientX - previousMousePosition.x;
                const deltaY = e.clientY - previousMousePosition.y;
                
                // Simple rotation
                const spherical = new THREE.Spherical();
                spherical.setFromVector3(this.camera.position);
                spherical.theta -= deltaX * 0.01;
                spherical.phi += deltaY * 0.01;
                spherical.phi = Math.max(0.1, Math.min(Math.PI - 0.1, spherical.phi));
                
                this.camera.position.setFromSpherical(spherical);
                this.camera.lookAt(0, 0, 0);
                
                previousMousePosition = { x: e.clientX, y: e.clientY };
            });
            
            container.addEventListener('mouseup', () => {
                isDragging = false;
            });
            
            container.addEventListener('wheel', (e) => {
                e.preventDefault();
                const scale = e.deltaY > 0 ? 1.1 : 0.9;
                this.camera.position.multiplyScalar(scale);
            });
            
            this.controls = { 
                update: () => {}, 
                reset: () => this.resetCamera(),
                target: new THREE.Vector3(0, 0, 0)
            };
        }

        // Lights
        const ambientLight = new THREE.AmbientLight(0x404040, 0.6);
        this.scene.add(ambientLight);

        const directionalLight1 = new THREE.DirectionalLight(0xffffff, 0.8);
        directionalLight1.position.set(50, 50, 50);
        directionalLight1.castShadow = true;
        this.scene.add(directionalLight1);

        const directionalLight2 = new THREE.DirectionalLight(0xffffff, 0.4);
        directionalLight2.position.set(-50, 50, -50);
        this.scene.add(directionalLight2);

        // Grid helper - show X-Z plane (Y is up, so grid is on X-Z plane)
        const gridHelper = new THREE.GridHelper(200, 20, 0x444444, 0x222222);
        this.scene.add(gridHelper);

        // Axes helper - Y is up (which represents Z/height in the model)
        // Red = X, Green = Y (up/height), Blue = Z
        const axesHelper = new THREE.AxesHelper(50);
        this.scene.add(axesHelper);

        // Handle window resize
        window.addEventListener('resize', () => this.onWindowResize());

        // Animation loop
        this.animate();
    }

    onWindowResize() {
        const container = document.getElementById('stl-preview');
        if (!container || !this.camera || !this.renderer) return;

        this.camera.aspect = container.clientWidth / container.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(container.clientWidth, container.clientHeight);
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        
        if (this.controls) {
            this.controls.update();
        }
        
        if (this.renderer && this.scene && this.camera) {
            this.renderer.render(this.scene, this.camera);
        }
    }

    resetCamera() {
        if (!this.camera) return;
        
        if (this.stlMesh && this.stlMesh.geometry) {
            const box = this.stlMesh.geometry.boundingBox;
            if (box) {
                const size = box.getSize(new THREE.Vector3());
                const center = box.getCenter(new THREE.Vector3());
                const maxDim = Math.max(size.x, size.y, size.z);
                const distance = maxDim * 2;
                this.camera.position.set(center.x + distance, center.y + distance, center.z + distance);
                this.camera.lookAt(center);
                if (this.controls && this.controls.target) {
                    this.controls.target.copy(center);
                }
            }
        } else {
            // Default position - view with Y (Z in model) pointing up
            this.camera.position.set(100, 120, 100);
            this.camera.lookAt(0, 0, 0);
        }
        
        if (this.controls && this.controls.update) {
            this.controls.update();
        }
    }

    loadSTLPreview(vertices, faces) {
        if (!this.scene) return;

        // Remove existing meshes
        this.clearPreviewMeshes();

        // Create geometry from vertices and faces
        const geometry = new THREE.BufferGeometry();
        
        const positions = [];
        const normals = [];
        const indices = [];

        // Calculate bounding box for centering
        let minX = Infinity, minY = Infinity, minZ = Infinity;
        let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

        vertices.forEach(v => {
            minX = Math.min(minX, v[0]);
            minY = Math.min(minY, v[1]);
            minZ = Math.min(minZ, v[2]);
            maxX = Math.max(maxX, v[0]);
            maxY = Math.max(maxY, v[1]);
            maxZ = Math.max(maxZ, v[2]);
        });

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const centerZ = (minZ + maxZ) / 2;

        // Add vertices (centered) - Transform for 3D printing: Z (height) -> Y (Three.js up)
        // Model coords: (x, y, z) where z is height
        // Three.js coords: (x, y, z) where y is up
        // Transform: (x, y, z) -> (x, z, -y)
        vertices.forEach(v => {
            const x = v[0] - centerX;
            const y = v[1] - centerY;
            const z = v[2] - centerZ;
            // Map model Z (height) to Three.js Y (up)
            positions.push(x, z, -y);
        });

        // Add faces
        faces.forEach(face => {
            if (face.length === 3) {
                indices.push(face[0], face[1], face[2]);
            }
        });

        geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        geometry.computeBoundingBox();

        // Get color from picker or use default
        const defaultColor = this.hexToInt(document.getElementById('color-buildings').value || '#8B4513');
        
        // Create material
        const material = new THREE.MeshPhongMaterial({
            color: defaultColor,
            shininess: 30,
            wireframe: document.getElementById('wireframe-toggle').checked
        });

        // Create mesh
        this.stlMesh = new THREE.Mesh(geometry, material);
        this.stlMesh.castShadow = true;
        this.stlMesh.receiveShadow = true;
        this.scene.add(this.stlMesh);

        // Update camera to fit model - position to view with Y (Z in model) pointing up
        const box = geometry.boundingBox;
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        
        const maxDim = Math.max(size.x, size.y, size.z);
        const distance = maxDim * 2.5;
        
        // Position camera at an angle to view the model with Y (height) pointing up
        // View from front-right-top angle
        this.camera.position.set(center.x + distance * 0.7, center.y + distance * 0.8, center.z + distance * 0.7);
        this.camera.lookAt(center);
        this.controls.target.copy(center);
        this.controls.update();

        // Hide placeholder
        const placeholder = document.querySelector('.preview-placeholder');
        if (placeholder) {
            placeholder.style.display = 'none';
        }
    }

    clearPreviewMeshes() {
        if (!this.scene) return;
        
        // Remove all layer meshes
        const meshesToRemove = [];
        this.scene.traverse((child) => {
            if (child instanceof THREE.Mesh && child.userData.isLayerMesh) {
                meshesToRemove.push(child);
            }
        });
        
        meshesToRemove.forEach(mesh => {
            this.scene.remove(mesh);
            if (mesh.geometry) mesh.geometry.dispose();
            if (mesh.material) mesh.material.dispose();
        });
        
        // Remove old single mesh
        if (this.stlMesh) {
            this.scene.remove(this.stlMesh);
            if (this.stlMesh.geometry) this.stlMesh.geometry.dispose();
            if (this.stlMesh.material) this.stlMesh.material.dispose();
            this.stlMesh = null;
        }
    }

    getLayerColors() {
        // Get colors from color pickers or use defaults
        return {
            buildings: this.hexToInt(document.getElementById('color-buildings').value),
            roads: this.hexToInt(document.getElementById('color-roads').value),
            greens: this.hexToInt(document.getElementById('color-greens').value),
            water: this.hexToInt(document.getElementById('color-water').value)
        };
    }

    hexToInt(hex) {
        // Convert #RRGGBB to 0xRRGGBB integer
        return parseInt(hex.replace('#', '0x'));
    }

    applyColors() {
        if (!this.scene) return;
        
        const layerColors = this.getLayerColors();
        
        // Update single mesh color if it exists
        if (this.stlMesh && this.stlMesh.material) {
            this.stlMesh.material.color.setHex(layerColors.buildings);
        }
        
        // Update layer meshes
        Object.keys(this.layerMeshes).forEach(layerType => {
            const mesh = this.layerMeshes[layerType];
            if (mesh && mesh.material) {
                mesh.material.color.setHex(layerColors[layerType]);
            }
        });
        
        // Also update any meshes in the scene
        if (this.scene) {
            this.scene.traverse((child) => {
                if (child instanceof THREE.Mesh && child.userData.isLayerMesh) {
                    const layerType = child.userData.layerType;
                    if (layerType && layerColors[layerType] !== undefined) {
                        child.material.color.setHex(layerColors[layerType]);
                    }
                }
            });
        }
    }

    loadMultiMaterialPreview(layers) {
        if (!this.scene) return;
        
        this.clearPreviewMeshes();
        this.layerMeshes = {}; // Reset layer meshes
        
        // Get colors from color pickers
        const layerColors = this.getLayerColors();
        
        // First pass: calculate combined bounding box from ALL layers
        let allBounds = null;
        const validLayers = [];
        
        Object.keys(layers).forEach(layerType => {
            const layer = layers[layerType];
            if (!layer || layer.vertices.length === 0) return;
            
            validLayers.push({ layerType, layer });
            
            // Calculate bounds for this layer
            let minX = Infinity, minY = Infinity, minZ = Infinity;
            let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
            
            layer.vertices.forEach(v => {
                minX = Math.min(minX, v[0]);
                minY = Math.min(minY, v[1]);
                minZ = Math.min(minZ, v[2]);
                maxX = Math.max(maxX, v[0]);
                maxY = Math.max(maxY, v[1]);
                maxZ = Math.max(maxZ, v[2]);
            });
            
            if (!allBounds) {
                allBounds = { minX, minY, minZ, maxX, maxY, maxZ };
            } else {
                allBounds.minX = Math.min(allBounds.minX, minX);
                allBounds.minY = Math.min(allBounds.minY, minY);
                allBounds.minZ = Math.min(allBounds.minZ, minZ);
                allBounds.maxX = Math.max(allBounds.maxX, maxX);
                allBounds.maxY = Math.max(allBounds.maxY, maxY);
                allBounds.maxZ = Math.max(allBounds.maxZ, maxZ);
            }
        });
        
        // Calculate common center point for ALL layers (so they overlap correctly)
        const commonCenterX = allBounds ? (allBounds.minX + allBounds.maxX) / 2 : 0;
        const commonCenterY = allBounds ? (allBounds.minY + allBounds.maxY) / 2 : 0;
        const commonCenterZ = allBounds ? (allBounds.minZ + allBounds.maxZ) / 2 : 0;
        
        const meshes = [];
        
        // Second pass: create meshes using the common center point
        validLayers.forEach(({ layerType, layer }) => {
            const geometry = new THREE.BufferGeometry();
            const positions = [];
            const indices = [];
            
            // Use the common center for all layers so they overlap correctly
            // Transform for 3D printing: Z (height) -> Y (Three.js up)
            // Transform: (x, y, z) -> (x, z, -y)
            layer.vertices.forEach(v => {
                const x = v[0] - commonCenterX;
                const y = v[1] - commonCenterY;
                const z = v[2] - commonCenterZ;
                // Map model Z (height) to Three.js Y (up)
                positions.push(x, z, -y);
            });
            
            layer.faces.forEach(face => {
                if (face.length === 3) {
                    indices.push(face[0], face[1], face[2]);
                }
            });
            
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geometry.setIndex(indices);
            geometry.computeVertexNormals();
            geometry.computeBoundingBox();
            
            const material = new THREE.MeshPhongMaterial({
                color: layerColors[layerType],
                shininess: 30,
                wireframe: document.getElementById('wireframe-toggle').checked
            });
            
            const mesh = new THREE.Mesh(geometry, material);
            mesh.userData.isLayerMesh = true;
            mesh.userData.layerType = layerType;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            this.scene.add(mesh);
            meshes.push(mesh);
            
            // Store mesh for color updates
            this.layerMeshes[layerType] = mesh;
        });
        
        // Update camera to fit all layers (all centered at origin now)
        if (allBounds && meshes.length > 0) {
            const size = {
                x: allBounds.maxX - allBounds.minX,
                y: allBounds.maxY - allBounds.minY,
                z: allBounds.maxZ - allBounds.minZ
            };
            
            const maxDim = Math.max(size.x, size.y, size.z);
            const distance = maxDim * 2.5;
            
            // All layers are now centered at origin (0,0,0) so they overlap correctly
            // Position camera to view with Y (Z in model, height) pointing up
            // View from front-right-top angle
            this.camera.position.set(distance * 0.7, distance * 0.8, distance * 0.7);
            this.camera.lookAt(0, 0, 0);
            if (this.controls && this.controls.target) {
                this.controls.target.set(0, 0, 0);
            }
        }
        
        // Hide placeholder
        const placeholder = document.querySelector('.preview-placeholder');
        if (placeholder) {
            placeholder.style.display = 'none';
        }
    }

    getLocationName(bbox) {
        // Try to get city name from search field, otherwise use coordinates
        const cityInput = document.getElementById('city-search');
        if (cityInput && cityInput.value.trim()) {
            const cityName = cityInput.value.trim().split(',')[0];
            // Sanitize filename
            return cityName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase() || 'location';
        }
        
        // Fallback to coordinates
        const [north, east, south, west] = bbox;
        const centerLat = ((north + south) / 2).toFixed(4);
        const centerLon = ((east + west) / 2).toFixed(4);
        return `lat${centerLat}_lon${centerLon}`;
    }

    displaySTLFilesList(files, layers) {
        const container = document.getElementById('stl-files-container');
        const listDiv = document.getElementById('stl-files-list');
        
        if (!container || !listDiv) return;
        
        container.innerHTML = '';
        
        files.forEach(file => {
            const fileCard = document.createElement('div');
            fileCard.className = 'stl-file-card';
            
            // Create thumbnail canvas
            const thumbnail = this.createThumbnail(layers[file.type], file.color);
            
            fileCard.innerHTML = `
                <div class="stl-file-thumbnail"></div>
                <div class="stl-file-info">
                    <div class="stl-file-name">${file.filename}</div>
                    <div class="stl-file-meta">
                        <span>${file.name}</span>
                        <span>${file.vertices.toLocaleString()} vertices</span>
                        <span>${file.faces.toLocaleString()} faces</span>
                    </div>
                </div>
                <button class="btn-download-file" data-layer="${file.type}">
                    Download
                </button>
            `;
            
            // Add thumbnail to the card
            const thumbnailDiv = fileCard.querySelector('.stl-file-thumbnail');
            thumbnailDiv.appendChild(thumbnail);
            
            // Add download handler
            const downloadBtn = fileCard.querySelector('.btn-download-file');
            downloadBtn.addEventListener('click', () => {
                this.downloadSTL(this.generatedLayers[file.type], file.filename);
                this.log(`Downloaded ${file.filename}`, 'success');
            });
            
            container.appendChild(fileCard);
        });
        
        listDiv.style.display = 'block';
    }

    createThumbnail(layer, color) {
        // Create a simple canvas thumbnail
        const canvas = document.createElement('canvas');
        canvas.width = 120;
        canvas.height = 120;
        const ctx = canvas.getContext('2d');
        
        // Draw a simple representation with the layer color
        const hexColor = `#${color.toString(16).padStart(6, '0')}`;
        ctx.fillStyle = hexColor;
        ctx.fillRect(10, 10, 100, 100);
        
        // Add border
        ctx.strokeStyle = '#333';
        ctx.lineWidth = 2;
        ctx.strokeRect(10, 10, 100, 100);
        
        // Return canvas element (not outerHTML) for proper DOM insertion
        return canvas;
    }

    async generate() {
        const generateBtn = document.getElementById('generate-btn');
        
        try {
            // Disable buttons and clear previous state
            generateBtn.disabled = true;
            generateBtn.textContent = 'Generating...';
            this.vertices = [];
            this.faces = [];
            this.generatedSTLContent = null;
            this.generatedSTLFilename = null;
            this.generatedLayers = { buildings: null, roads: null, greens: null, water: null };
            
            // Hide file list
            document.getElementById('stl-files-list').style.display = 'none';
            
            document.getElementById('log').innerHTML = '';
            document.getElementById('progress').style.display = 'none';
            
            // Get configuration
            const bbox = [
                parseFloat(document.getElementById('bbox-north').value),
                parseFloat(document.getElementById('bbox-east').value),
                parseFloat(document.getElementById('bbox-south').value),
                parseFloat(document.getElementById('bbox-west').value)
            ];
            
            const config = {
                targetSize: parseFloat(document.getElementById('target-size').value),
                maxHeight: parseFloat(document.getElementById('max-height').value),
                defaultHeight: parseFloat(document.getElementById('default-height').value),
                baseThickness: parseFloat(document.getElementById('base-thickness').value),
                includeRoads: document.getElementById('include-roads').checked,
                includeGreens: document.getElementById('include-greens').checked,
                includeWater: document.getElementById('include-water').checked,
                roadWidth: parseFloat(document.getElementById('road-width').value),
                roadHeight: parseFloat(document.getElementById('road-height').value)
            };
            
            // Validate bbox
            if (bbox.some(isNaN) || bbox[0] <= bbox[2] || bbox[1] <= bbox[3]) {
                throw new Error('Invalid bounding box coordinates. North must be > South, East must be > West.');
            }
            
            // Validate config values
            if (config.targetSize <= 0 || config.maxHeight <= 0 || config.baseThickness <= 0) {
                throw new Error('Invalid configuration values. All size parameters must be positive.');
            }
            
            if (config.includeRoads && (config.roadWidth <= 0 || config.roadHeight <= 0)) {
                throw new Error('Invalid road configuration. Road width and height must be positive.');
            }
            
            this.updateStatus('Fetching OSM data...', 'loading');
            this.updateProgress(5);
            
            // Fetch OSM data
            const { buildings, roads, greens, water } = await this.fetchOSMData(bbox);
            
            this.log(`Found ${buildings.length} buildings`);
            if (config.includeRoads) {
                this.log(`Found ${roads.length} road segments`);
            }
            if (config.includeGreens) {
                this.log(`Found ${greens.length} green spaces`);
            }
            if (config.includeWater) {
                this.log(`Found ${water.length} water bodies`);
            }
            
            this.updateStatus('Processing geometry...', 'loading');
            this.updateProgress(10);
            
            const multiMaterial = document.getElementById('multi-material').checked;
            
            if (multiMaterial) {
                // Process layers separately
                this.log('Processing layers separately for multi-material export...');
                
                const layers = {};
                
                // Process buildings
                if (buildings && buildings.length > 0) {
                    layers.buildings = await this.processLayer(buildings, bbox, config, 'buildings', 20, 20);
                    this.log(`Buildings layer: ${layers.buildings.vertices.length} vertices, ${layers.buildings.faces.length} faces`);
                }
                
                // Process roads
                if (config.includeRoads && roads && roads.length > 0) {
                    layers.roads = await this.processLayer(roads, bbox, config, 'roads', 40, 20);
                    this.log(`Roads layer: ${layers.roads.vertices.length} vertices, ${layers.roads.faces.length} faces`);
                }
                
                // Process greens
                if (config.includeGreens && greens && greens.length > 0) {
                    layers.greens = await this.processLayer(greens, bbox, config, 'greens', 60, 10);
                    this.log(`Greens layer: ${layers.greens.vertices.length} vertices, ${layers.greens.faces.length} faces`);
                }
                
                // Process water
                if (config.includeWater && water && water.length > 0) {
                    layers.water = await this.processLayer(water, bbox, config, 'water', 70, 10);
                    this.log(`Water layer: ${layers.water.vertices.length} vertices, ${layers.water.faces.length} faces`);
                }
                
                // Generate STL files for each layer
                this.updateStatus('Generating STL files...', 'loading');
                this.updateProgress(90);
                
                // Get location name for filename
                const locationName = this.getLocationName(bbox);
                
                this.generatedLayers = {};
                const generatedFiles = [];
                
                if (layers.buildings) {
                    const filename = `${locationName}-buildings.stl`;
                    this.generatedLayers.buildings = this.generateSTL(layers.buildings.vertices, layers.buildings.faces, filename);
                    generatedFiles.push({
                        type: 'buildings',
                        name: 'Buildings',
                        filename: filename,
                        vertices: layers.buildings.vertices.length,
                        faces: layers.buildings.faces.length,
                        color: this.hexToInt(document.getElementById('color-buildings').value)
                    });
                }
                if (layers.roads) {
                    const filename = `${locationName}-roads.stl`;
                    this.generatedLayers.roads = this.generateSTL(layers.roads.vertices, layers.roads.faces, filename);
                    generatedFiles.push({
                        type: 'roads',
                        name: 'Roads',
                        filename: filename,
                        vertices: layers.roads.vertices.length,
                        faces: layers.roads.faces.length,
                        color: this.hexToInt(document.getElementById('color-roads').value)
                    });
                }
                if (layers.greens) {
                    const filename = `${locationName}-greens.stl`;
                    this.generatedLayers.greens = this.generateSTL(layers.greens.vertices, layers.greens.faces, filename);
                    generatedFiles.push({
                        type: 'greens',
                        name: 'Green Spaces',
                        filename: filename,
                        vertices: layers.greens.vertices.length,
                        faces: layers.greens.faces.length,
                        color: this.hexToInt(document.getElementById('color-greens').value)
                    });
                }
                if (layers.water) {
                    const filename = `${locationName}-water.stl`;
                    this.generatedLayers.water = this.generateSTL(layers.water.vertices, layers.water.faces, filename);
                    generatedFiles.push({
                        type: 'water',
                        name: 'Water Bodies',
                        filename: filename,
                        vertices: layers.water.vertices.length,
                        faces: layers.water.faces.length,
                        color: this.hexToInt(document.getElementById('color-water').value)
                    });
                }
                
                // Display file list
                if (generatedFiles.length > 0) {
                    this.displaySTLFilesList(generatedFiles, layers);
                }
                
                // Load colored 3D preview
                this.updateStatus('Loading 3D preview...', 'loading');
                this.loadMultiMaterialPreview(layers);
                
                this.updateProgress(100);
                this.updateStatus('Multi-material STL files generated!', 'success');
                this.log('Multi-material STL files generated successfully!', 'success');
                
            } else {
                // Process combined geometry
                const { vertices, faces } = await this.scaleCoordinates(buildings, roads, greens, water, bbox, config);
                
                this.log(`Generated mesh: ${vertices.length} vertices, ${faces.length} faces`);
                
                this.updateStatus('Generating STL file...', 'loading');
                this.updateProgress(95);
                
                // Generate STL
                const locationName = this.getLocationName(bbox);
                const combinedFilename = `${locationName}-combined.stl`;
                const stlContent = this.generateSTL(vertices, faces, combinedFilename);
                
                // Store generated STL for download
                this.generatedSTLContent = stlContent;
                this.generatedSTLFilename = combinedFilename;
                
                this.updateProgress(100);
                
                // Load 3D preview
                this.updateStatus('Loading 3D preview...', 'loading');
                this.loadSTLPreview(vertices, faces);
                
                // Display single file in list
                this.displaySTLFilesList([{
                    type: 'combined',
                    name: 'Combined Model',
                    filename: combinedFilename,
                    vertices: vertices.length,
                    faces: faces.length,
                    color: this.hexToInt(document.getElementById('color-buildings').value || '#8B4513')
                }], { combined: { vertices, faces } });
                
                this.updateStatus('STL file generated!', 'success');
                this.log('STL file generated successfully!', 'success');
            }
            
        } catch (error) {
            this.updateStatus(`Error: ${error.message}`, 'error');
            this.log(`Error: ${error.message}`, 'error');
            console.error(error);
        } finally {
            // Re-enable generate button
            const generateBtn = document.getElementById('generate-btn');
            generateBtn.disabled = false;
            generateBtn.textContent = 'Generate STL';
        }
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    new OSMToSTL();
});

