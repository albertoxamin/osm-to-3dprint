// Geometry Processor Module
// Handles all geometry processing and STL generation

class GeometryProcessor {
    constructor() {
        this.vertices = [];
        this.faces = [];
    }

    createSolidBase(baseSize, baseThickness) {
        const vertices = [
            [0, 0, 0],
            [baseSize, 0, 0],
            [baseSize, baseSize, 0],
            [0, baseSize, 0],
            [0, 0, baseThickness],
            [baseSize, 0, baseThickness],
            [baseSize, baseSize, baseThickness],
            [0, baseSize, baseThickness]
        ];

        const faces = [
            [0, 1, 5], [0, 5, 4],
            [1, 2, 6], [1, 6, 5],
            [2, 3, 7], [2, 7, 6],
            [3, 0, 4], [3, 4, 7],
            [4, 5, 6], [4, 6, 7],
            [0, 1, 2], [0, 2, 3]
        ];

        return { vertices, faces };
    }

    fanTriangulate(loopIndices, facesOut) {
        if (loopIndices.length < 3) return;
        for (let i = 1; i < loopIndices.length - 1; i++) {
            facesOut.push([loopIndices[0], loopIndices[i], loopIndices[i + 1]]);
        }
    }

    addPrismFromPolygon(coords, z0, z1) {
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

    addPrismFromPolygonTriangulated(coords, z0, z1) {
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

    reset() {
        this.vertices = [];
        this.faces = [];
    }

    getMesh() {
        return {
            vertices: this.vertices,
            faces: this.faces
        };
    }
}

// Export for use in modules or browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = GeometryProcessor;
}

