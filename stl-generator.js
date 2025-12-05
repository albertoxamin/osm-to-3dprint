// STL Generator Module
// Handles STL file generation from geometry data

class STLGenerator {
    generateSTL(vertices, faces, filename) {
        // Convert to STL format (ASCII)
        let stlContent = `solid ${filename.replace('.stl', '')}\n`;
        
        faces.forEach(face => {
            if (face.length !== 3) return;
            
            const v0 = vertices[face[0]];
            const v1 = vertices[face[1]];
            const v2 = vertices[face[2]];
            
            // Calculate normal (cross product)
            const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]];
            const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]];
            const normal = [
                e1[1] * e2[2] - e1[2] * e2[1],
                e1[2] * e2[0] - e1[0] * e2[2],
                e1[0] * e2[1] - e1[1] * e2[0]
            ];
            const len = Math.sqrt(normal[0] * normal[0] + normal[1] * normal[1] + normal[2] * normal[2]);
            if (len > 1e-10) {
                normal[0] /= len;
                normal[1] /= len;
                normal[2] /= len;
            } else {
                normal[0] = 0;
                normal[1] = 0;
                normal[2] = 1;
            }
            
            // Format numbers with sufficient precision
            const formatNum = (n) => n.toFixed(6);
            
            stlContent += `  facet normal ${formatNum(normal[0])} ${formatNum(normal[1])} ${formatNum(normal[2])}\n`;
            stlContent += `    outer loop\n`;
            stlContent += `      vertex ${formatNum(v0[0])} ${formatNum(v0[1])} ${formatNum(v0[2])}\n`;
            stlContent += `      vertex ${formatNum(v1[0])} ${formatNum(v1[1])} ${formatNum(v1[2])}\n`;
            stlContent += `      vertex ${formatNum(v2[0])} ${formatNum(v2[1])} ${formatNum(v2[2])}\n`;
            stlContent += `    endloop\n`;
            stlContent += `  endfacet\n`;
        });
        
        stlContent += `endsolid ${filename.replace('.stl', '')}\n`;
        
        return stlContent;
    }

    validateMesh(vertices, faces) {
        const errors = [];
        
        if (!vertices || vertices.length === 0) {
            errors.push('No vertices in mesh');
        }
        
        if (!faces || faces.length === 0) {
            errors.push('No faces in mesh');
        }
        
        // Check face indices are valid
        if (faces && vertices) {
            faces.forEach((face, idx) => {
                if (face.length !== 3) {
                    errors.push(`Face ${idx} has ${face.length} vertices (expected 3)`);
                } else {
                    face.forEach(vertexIdx => {
                        if (vertexIdx < 0 || vertexIdx >= vertices.length) {
                            errors.push(`Face ${idx} references invalid vertex index ${vertexIdx}`);
                        }
                    });
                }
            });
        }
        
        return {
            valid: errors.length === 0,
            errors
        };
    }
}

// Export for use in modules or browser
if (typeof module !== 'undefined' && module.exports) {
    module.exports = STLGenerator;
}

