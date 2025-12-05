// Test file for geometry processing logic
// Run with: node test-geometry.js

const GeometryProcessor = require('./geometry-processor.js');
const STLGenerator = require('./stl-generator.js');

function testBasicPolygon() {
    console.log('Test 1: Basic polygon prism');
    const processor = new GeometryProcessor();
    
    // Simple square polygon
    const coords = [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0] // Closed
    ];
    
    processor.addPrismFromPolygon(coords, 0, 5);
    const mesh = processor.getMesh();
    
    console.log(`  Vertices: ${mesh.vertices.length} (expected: 8)`);
    console.log(`  Faces: ${mesh.faces.length} (expected: 12)`);
    
    const expectedVertices = 8; // 4 bottom + 4 top
    const expectedFaces = 12; // 4 sides (2 triangles each) + 2 top/bottom (2 triangles each)
    
    if (mesh.vertices.length === expectedVertices && mesh.faces.length === expectedFaces) {
        console.log('  ✓ PASSED\n');
        return true;
    } else {
        console.log('  ✗ FAILED\n');
        return false;
    }
}

function testTriangulation() {
    console.log('Test 2: Polygon triangulation');
    const processor = new GeometryProcessor();
    
    // Pentagon
    const coords = [
        [0, 0],
        [5, 0],
        [6, 3],
        [3, 5],
        [0, 3],
        [0, 0]
    ];
    
    const triangles = processor.triangulatePolygon(coords);
    console.log(`  Triangles: ${triangles.length} (expected: 3)`);
    
    if (triangles.length === 3) {
        console.log('  ✓ PASSED\n');
        return true;
    } else {
        console.log('  ✗ FAILED\n');
        return false;
    }
}

function testSTLGeneration() {
    console.log('Test 3: STL generation');
    const generator = new STLGenerator();
    
    // Simple cube
    const vertices = [
        [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], // bottom
        [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]  // top
    ];
    
    const faces = [
        [0, 1, 2], [0, 2, 3], // bottom
        [4, 7, 6], [4, 6, 5], // top
        [0, 4, 5], [0, 5, 1], // front
        [2, 6, 7], [2, 7, 3], // back
        [0, 3, 7], [0, 7, 4], // left
        [1, 5, 6], [1, 6, 2]  // right
    ];
    
    const validation = generator.validateMesh(vertices, faces);
    if (!validation.valid) {
        console.log(`  Validation errors: ${validation.errors.join(', ')}`);
        console.log('  ✗ FAILED\n');
        return false;
    }
    
    const stl = generator.generateSTL(vertices, faces, 'test.stl');
    const hasSolid = stl.includes('solid test');
    const hasEndSolid = stl.includes('endsolid test');
    const facetCount = (stl.match(/facet normal/g) || []).length;
    
    console.log(`  STL contains solid: ${hasSolid}`);
    console.log(`  STL contains endsolid: ${hasEndSolid}`);
    console.log(`  Facet count: ${facetCount} (expected: 12)`);
    
    if (hasSolid && hasEndSolid && facetCount === 12) {
        console.log('  ✓ PASSED\n');
        return true;
    } else {
        console.log('  ✗ FAILED\n');
        return false;
    }
}

function testComplexPolygon() {
    console.log('Test 4: Complex polygon handling');
    const processor = new GeometryProcessor();
    
    // Large polygon (should be skipped)
    const largeCoords = Array.from({ length: 600 }, (_, i) => [i, i]);
    processor.addPrismFromPolygon(largeCoords, 0, 1);
    const mesh1 = processor.getMesh();
    
    console.log(`  Large polygon (600 vertices): ${mesh1.vertices.length} vertices (should be 0 - skipped)`);
    
    // Normal polygon
    processor.reset();
    const normalCoords = [
        [0, 0], [10, 0], [10, 10], [0, 10], [0, 0]
    ];
    processor.addPrismFromPolygon(normalCoords, 0, 1);
    const mesh2 = processor.getMesh();
    
    console.log(`  Normal polygon (4 vertices): ${mesh2.vertices.length} vertices (expected: 8)`);
    
    if (mesh1.vertices.length === 0 && mesh2.vertices.length === 8) {
        console.log('  ✓ PASSED\n');
        return true;
    } else {
        console.log('  ✗ FAILED\n');
        return false;
    }
}

function testBaseGeneration() {
    console.log('Test 5: Base generation');
    const processor = new GeometryProcessor();
    
    const base = processor.createSolidBase(100, 2);
    
    console.log(`  Base vertices: ${base.vertices.length} (expected: 8)`);
    console.log(`  Base faces: ${base.faces.length} (expected: 12)`);
    
    if (base.vertices.length === 8 && base.faces.length === 12) {
        console.log('  ✓ PASSED\n');
        return true;
    } else {
        console.log('  ✗ FAILED\n');
        return false;
    }
}

// Run all tests
console.log('Running Geometry Processor Tests\n');
console.log('='.repeat(50) + '\n');

const results = [
    testBasicPolygon(),
    testTriangulation(),
    testSTLGeneration(),
    testComplexPolygon(),
    testBaseGeneration()
];

const passed = results.filter(r => r).length;
const total = results.length;

console.log('='.repeat(50));
console.log(`Tests passed: ${passed}/${total}`);

if (passed === total) {
    console.log('All tests passed! ✓');
    process.exit(0);
} else {
    console.log('Some tests failed ✗');
    process.exit(1);
}

