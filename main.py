# main.py
import osmnx as ox
import shapely
from shapely.geometry import Polygon, MultiPolygon, LineString, MultiLineString, box
import numpy as np
from stl import mesh
import osmnx, shapely, geopandas, pyproj, networkx
print("osmnx", osmnx.__version__)
print("shapely", shapely.__version__)
from shapely.ops import unary_union
from shapely.geometry import box as shapely_box
from shapely.geometry import GeometryCollection
from shapely.ops import triangulate
from shapely.geometry import GeometryCollection, MultiPolygon, Polygon

# recommended
# pip install -U "osmnx>=2.0.2" "shapely>=2.0.4" "geopandas>=0.14" "pyproj>=3.6" "networkx>=3.2"


# top of file
import warnings
warnings.filterwarnings("ignore", category=FutureWarning)  # optionally hide OSMnx v2 deprecations

import osmnx as ox

from shapely.geometry import box
import osmnx as ox

def fetch_building_data(bbox):
    """
    bbox = (north, east, south, west)  # your code’s convention
    OSMnx v2 wants bbox=(left, bottom, right, top) i.e. (west, south, east, north)
    """
    north, east, south, west = bbox
    return ox.features.features_from_bbox(
        bbox=(west, south, east, north),
        tags={"building": True}
    )

def fetch_road_data(bbox, network_type='drive'):
    north, east, south, west = bbox
    # OSMnx v2 expects bbox=(west, south, east, north)
    bbox_osmnx = (west, south, east, north)
    G = ox.graph_from_bbox(bbox=bbox_osmnx, network_type=network_type, simplify=True)
    _, edges = ox.graph_to_gdfs(G)
    return edges[edges.geometry.type.isin(['LineString', 'MultiLineString'])].copy()

def get_building_height(row, default_height=10):
    height_attrs = ['height', 'building:height', 'building:levels']
    for attr in height_attrs:
        if attr in row:
            height = row[attr]
            if isinstance(height, (int, float)) and not np.isnan(height):
                if attr == 'building:levels':
                    return height * 3  # meters per level assumption
                return height
            elif isinstance(height, str):
                try:
                    height_value = float(height.replace('m', '').strip())
                    return height_value
                except ValueError:
                    continue
    return default_height

def create_solid_base(base_size, base_thickness=2):
    base_vertices = [
        (0, 0, 0),  # bottom rectangle
        (base_size, 0, 0),
        (base_size, base_size, 0),
        (0, base_size, 0),
        (0, 0, base_thickness),  # top rectangle
        (base_size, 0, base_thickness),
        (base_size, base_size, base_thickness),
        (0, base_size, base_thickness)
    ]
    base_faces = [
        [0, 1, 5], [0, 5, 4],
        [1, 2, 6], [1, 6, 5],
        [2, 3, 7], [2, 7, 6],
        [3, 0, 4], [3, 4, 7],
        [4, 5, 6], [4, 6, 7],  # top
        [0, 1, 2], [0, 2, 3]   # bottom
    ]
    return base_vertices, base_faces

def _fan_triangulate(loop_indices, faces_out):
    """
    Fan-triangulate a simple polygon ring given a list of vertex indices.
    """
    if len(loop_indices) < 3:
        return
    for i in range(1, len(loop_indices) - 1):
        faces_out.append([loop_indices[0], loop_indices[i], loop_indices[i + 1]])

def _add_prism_from_polygon(coords, z0, z1, vertices_out, faces_out):
    """
    Given a simple polygon (no holes) as a list of (x,y), add vertical prism between z0 and z1.
    """
    base_index = len(vertices_out)
    # Add vertical pairs
    for (x, y) in coords[:-1]:  # last point repeats first in shapely; skip duplicate
        vertices_out.extend([(x, y, z0), (x, y, z1)])

    n = (len(coords) - 1)  # number of unique vertices
    # Side faces
    for i in range(n):
        i_next = (i + 1) % n
        b1 = base_index + 2 * i
        t1 = base_index + 2 * i + 1
        b2 = base_index + 2 * i_next
        t2 = base_index + 2 * i_next + 1
        faces_out.append([b1, b2, t1])
        faces_out.append([t1, b2, t2])

    # Top and bottom faces (fan)
    top_indices = [base_index + 2 * i + 1 for i in range(n)]
    bottom_indices = [base_index + 2 * i for i in range(n)]
    _fan_triangulate(top_indices, faces_out)
    _fan_triangulate(bottom_indices, faces_out)

def _add_prism_from_polygon_TRIANGULATED(poly, z0, z1, vertices_out, faces_out):
    """
    Robustly extrude a (possibly concave) shapely Polygon by triangulating its face.
    - Triangulates the 2D area (no holes handled for simplicity/robustness).
    - Adds top/bottom triangles and a single outer wall.
    """
    # --- Top/Bottom via triangulation (safe for concave shapes) ---
    tris = triangulate(poly)  # list of triangular Polygons covering 'poly'
    for tri in tris:
        # each tri has 3 unique points; close ring repeats the first -> skip last
        tri_coords = list(tri.exterior.coords)[:-1]
        base_idx = len(vertices_out)
        # add bottom and top vertices for the triangle
        for (x, y) in tri_coords:
            vertices_out.append((x, y, z0))
        for (x, y) in tri_coords:
            vertices_out.append((x, y, z1))
        # bottom face (triangle)
        faces_out.append([base_idx + 0, base_idx + 1, base_idx + 2])
        # top face (triangle) - same winding but on the top
        faces_out.append([base_idx + 3, base_idx + 4, base_idx + 5])

    # --- Outer vertical wall along the exterior ring only ---
    ext = list(poly.exterior.coords)
    n = len(ext) - 1
    wall_base = len(vertices_out)
    for (x, y) in ext[:-1]:
        vertices_out.extend([(x, y, z0), (x, y, z1)])
    for i in range(n):
        j = (i + 1) % n
        b1 = wall_base + 2*i
        t1 = wall_base + 2*i + 1
        b2 = wall_base + 2*j
        t2 = wall_base + 2*j + 1
        faces_out.append([b1, b2, t1])
        faces_out.append([t1, b2, t2])

def scale_coordinates(
    gdf_buildings,
    bbox,
    target_size=180,
    max_height_mm=40,
    default_height=40,
    base_thickness=2,
    roads_gdf=None,
    road_width_mm=14.0,
    road_height_mm=2.0,
    EPS= 0.02
):
    """
    Scale buildings and (optionally) roads into model space and build a single mesh.
    bbox = (north, east, south, west)
    """
    north, east, south, west = bbox
    lat_range = north - south
    lon_range = east - west

    # Base is a bit larger than model target to frame the city
    base_size = target_size * 1.2
    scale_x = target_size / lon_range
    scale_y = target_size / lat_range
    center_offset_x = (base_size - (scale_x * lon_range)) / 2
    center_offset_y = (base_size - (scale_y * lat_range)) / 2

    def to_model_xy(lon, lat):
        x = ((lon - west) * scale_x) + center_offset_x
        y = ((lat - south) * scale_y) + center_offset_y
        return (x, y)

    vertices, faces = [], []

    # 1) Base
    base_vertices, base_faces = create_solid_base(base_size, base_thickness)
    vertices.extend(base_vertices)
    faces.extend(base_faces)

    # 2) Buildings
    if len(gdf_buildings) > 0:
        max_building_height_m = gdf_buildings.apply(
            lambda row: get_building_height(row, default_height), axis=1
        ).max()
        height_scale = (max_height_mm / max_building_height_m) if max_building_height_m > 0 else 1.0
    else:
        height_scale = 1.0

    for _, row in gdf_buildings.iterrows():
        geom = row['geometry']
        if isinstance(geom, shapely.geometry.Polygon):
            exterior = list(geom.exterior.coords)
            model_coords = [to_model_xy(lon, lat) for (lon, lat) in exterior]
            height = get_building_height(row, default_height) * height_scale
            _add_prism_from_polygon(model_coords, base_thickness, base_thickness + height, vertices, faces)
        elif isinstance(geom, shapely.geometry.MultiPolygon):
            for poly in geom.geoms:
                exterior = list(poly.exterior.coords)
                model_coords = [to_model_xy(lon, lat) for (lon, lat) in exterior]
                height = get_building_height(row, default_height) * height_scale
                _add_prism_from_polygon(model_coords, base_thickness, base_thickness + height, vertices, faces)

    # model-space base rect for clipping
    base_rect = shapely_box(0, 0, base_size, base_size)

    # 3) Roads (optional) — per-edge buffering/extrusion (no union)
    if roads_gdf is not None and len(roads_gdf) > 0:
        from shapely.geometry import GeometryCollection, MultiPolygon, Polygon

        # model-space base rect for clipping (if not already defined above)
        base_rect = shapely_box(0, 0, base_size, base_size)
        base_area = base_size * base_size

        def line_to_model_linestring(line):
            if isinstance(line, LineString):
                return LineString([to_model_xy(lon, lat) for (lon, lat) in line.coords])
            elif isinstance(line, MultiLineString):
                return MultiLineString([
                    LineString([to_model_xy(lon, lat) for (lon, lat) in seg.coords])
                    for seg in line.geoms
                ])
            return None

        # ---- tuning knobs ----
        UNIFORM_WIDTH_MM = 0.8      # start ~0.6–1.0 mm at your scale
        z0 = base_thickness + EPS   # EPS ~ 0.02 keeps roads from fusing with base
        z1 = z0 + road_height_mm    # e.g., 1.4–1.8 mm looks nice
        MIN_AREA = 0.012            # ignore dust polygons (mm^2)
        SIMPLIFY = 0.03             # shave micro-spikes (mm)
        # ----------------------

        def iter_polys(g):
            if g.is_empty:
                return
            if isinstance(g, Polygon):
                yield g
            elif isinstance(g, MultiPolygon):
                for p in g.geoms:
                    yield p
            elif isinstance(g, GeometryCollection):
                for p in g.geoms:
                    yield from iter_polys(p)

        total_area = 0.0
        count = 0

        for _, erow in roads_gdf.iterrows():
            mg = line_to_model_linestring(erow.geometry)
            if mg is None or mg.is_empty:
                continue

            # buffer this ONE edge (half-width)
            buf = mg.buffer(UNIFORM_WIDTH_MM / 2.0, cap_style=2, join_style=2)
            if buf.is_empty:
                continue

            # clip to base; clean tiny self-intersections; simplify a hair
            buf = buf.intersection(base_rect)
            if buf.is_empty:
                continue
            buf = buf.buffer(0)
            if SIMPLIFY > 0:
                buf = buf.simplify(SIMPLIFY)

            # extrude ONLY polygon parts (no union!)
            for poly in iter_polys(buf):
                if poly.is_empty:
                    continue
                a = poly.area
                if a < MIN_AREA:
                    continue
                total_area += a
                count += 1
                _add_prism_from_polygon_TRIANGULATED(poly, z0, z1, vertices, faces)

        # diagnostics (non-union coverage)
        try:
            print(f"[roads-per-edge] pieces = {count}, summed_coverage = {total_area/base_area:.3f}")
        except Exception:
            pass

    return np.array(vertices), np.array(faces)

def save_to_stl(vertices, faces, filename):
    mesh_data = mesh.Mesh(np.zeros(faces.shape[0], dtype=mesh.Mesh.dtype))
    for i, face in enumerate(faces):
        for j in range(3):
            mesh_data.vectors[i][j] = vertices[face[j], :]
    mesh_data.save(filename)

def main():
    # bbox = (north, east, south, west)
    bbox = (39.9615, -75.1520, 39.9435, -75.1750)  # Center City Philadelphia ~2km box

    buildings = fetch_building_data(bbox)
    roads = fetch_road_data(bbox, network_type='drive')

    vertices, faces = scale_coordinates(
        buildings,
        bbox,
        target_size=180,
        max_height_mm=40,
        default_height=40,
        base_thickness=1.8,
        roads_gdf=roads,
        road_width_mm=3.0,     # tweak to taste
        road_height_mm=1.6     # shallow relief
    )

    save_to_stl(vertices, faces, 'city_with_roads_and_buildings.stl')

if __name__ == "__main__":
    main()
