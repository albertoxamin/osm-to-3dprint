# osm-to-3dprint

Export OpenStreetMap (OSM) features to **STL** for 3D printing.  
Now supports **streets** (buffered & extruded roadbeds) in addition to buildings.

- **License:** MIT (free for commercial use)
- **Why this over CadMapper?** No 1 km cap; export much larger areas.
- **Printer-friendly:** Models are watertight and tuned for slicers.
- **Fast:** Typical city tiles generate in under a minute.

Support the project by grabbing a 3D print from **[Etsy.com](https://www.etsy.com/listing/1760573334/3d-printed-city-map)**!

---

## What’s new (Roads!)

- Roads are pulled from OSM **edges** (e.g., `highway=residential`, `primary`, …).
- Each edge is buffered **per-edge (no global union)**, triangulated, and extruded slightly **above** the base to avoid being fused by slicers.
- You can choose a single uniform width (simplest) or turn on **per-type widths** for realism (motorway > residential).
- Tunable parameters:
  - `UNIFORM_WIDTH_MM` (or per-type map) – model-space road width
  - `road_height_mm` – relief above the base (e.g., 1.4–1.8 mm)
  - `EPS` – tiny Z-offset (e.g., 0.02 mm) to prevent coplanar merging

> Tip: At ~2 km mapped to ~180–200 mm, **1 mm ≈ 9–11 m**. Start with **0.6–1.0 mm** for residential roads.

---

<img width="1635" height="1267" alt="image" src="https://github.com/user-attachments/assets/1903c350-e4db-41e5-9776-46dc2d1f0305" />
Downtown Philly ^^

## Installation

We recommend **OSMnx v2** and recent geospatial libs.

```bash
# (optional) new virtual environment
# python -m venv .venv && . .venv/Scripts/activate   # Windows PowerShell
# source .venv/bin/activate                          # macOS/Linux

pip install "osmnx>=2.0.2" "shapely>=2.0.4" "geopandas>=0.14" "pyproj>=3.6" "networkx>=3.2" "numpy-stl"
```

> On Windows, using Conda can be even smoother:  
> `conda create -n osm2stl -c conda-forge python=3.11 osmnx shapely geopandas pyproj networkx numpy-stl -y`

---

## Usage

### 1) Pick a bounding box
This repo uses the internal convention:

```python
# our code: (north, east, south, west)
bbox = (N, E, S, W)
```

OSMnx v2 calls that as **`bbox=(west, south, east, north)`** when fetching features/graphs, and the code already converts for you.

**Center City Philadelphia (Broad & Market as center, ~2 km square):**
```python
bbox = (39.9615, -75.1520, 39.9435, -75.1750)  # (north, east, south, west)
```

### 2) Run
```bash
python main.py
```

This produces e.g. `city_with_roads_and_buildings.stl`.

---

## Key script knobs (in `main.py`)

### Buildings
- `target_size` (mm): width of the modeled area on your print bed (the base is slightly larger to frame).
- `max_height_mm`: tallest building height in mm after scaling.
- `default_height` & `building:levels`:  
  The code checks `['height', 'building:height', 'building:levels']` (levels × ~3 m) if explicit heights are missing.

### Roads (per-edge buffering & extrusion)
Inside `scale_coordinates(...)` the **roads block**:

- Uses **per-edge** buffering (no global dissolve/union), then triangulates/extrudes each piece.
- Keeps a tiny `EPS` Z-offset so slicers don’t merge roads into the base.
- Logs a diagnostic line so you can tune widths:
  ```
  [roads-per-edge] pieces = 1234, summed_coverage = 0.064
  ```
  Aim for **~0.04–0.10** coverage at city scale; if you see ~0.20, your roads are too wide (they’ll look like a second base slab).

**Tuning:**
- Start with `UNIFORM_WIDTH_MM = 0.8` and `road_height_mm = 1.6`.
- If roads look too faint in slice, bump width to 1.0–1.2; if they “blanket” blocks, drop to 0.6–0.7.
- Once you like it, turn on **per-type widths** (motorways bigger; residentials smaller).

---

## Example: Philly quick start

In `main()`:

```python
# bbox = (north, east, south, west)
bbox = (39.9615, -75.1520, 39.9435, -75.1750)

buildings = fetch_building_data(bbox)          # OSMnx v2: features_from_bbox under the hood
roads     = fetch_road_data(bbox, 'drive')     # OSMnx v2: graph_from_bbox(bbox=(W,S,E,N))

vertices, faces = scale_coordinates(
    gdf_buildings=buildings,
    bbox=bbox,
    target_size=180,
    max_height_mm=40,
    default_height=40,
    base_thickness=1.8,
    roads_gdf=roads,
    road_height_mm=1.6
)

save_to_stl(vertices, faces, 'city_with_roads_and_buildings.stl')
```

The roads section (already in the file) is configured for **per-edge extrusion** and prints a coverage diagnostic.

---

## Troubleshooting

### “I don’t see roads in the slicer.”
- Ensure **per-edge** block is enabled (no global `unary_union`).
- Keep `EPS = 0.02` (or 0.03) so roads start slightly above the base.
- Set `road_height_mm ≥ 1.4` so the terrace is visible across a few layers.
- Check the coverage log:
  - `summed_coverage > 0.15` → widths too large; reduce to 0.6–0.8 mm.
  - `summed_coverage < 0.02` → widths too small; raise to 1.0–1.2 mm.

### “Diagonal ‘rays’ from a corner.”
That’s fan-triangulation on concave polygons. The script now uses **Shapely triangulation** for roads to prevent this.

### “OSMnx function signature errors / bbox order.”
You’re likely mixing OSMnx v1 and v2 docs. This repo assumes **OSMnx ≥ 2.0**.  
- Use `features.features_from_bbox(bbox=(W, S, E, N), tags=...)`.
- Use `graph_from_bbox(bbox=(W, S, E, N), network_type='drive', simplify=True)`.

---

## Road width realism (optional)

Once the geometry looks good, switch to per-type widths (still **per-edge**, no union):

```python
USE_PER_TYPE = True
width_map = {
    "motorway": 3.2, "trunk": 2.8, "primary": 2.6,
    "secondary": 2.2, "tertiary": 1.8, "residential": 1.2,
    "service": 1.0, "living_street": 1.0, "unclassified": 1.2,
    "cycleway": 0.9, "footway": 0.8, "path": 0.8
}
# clamp to [0.6, 3.2] in model mm; 1 mm ~ 9–11 m at this scale
```

---

## Example outputs

<img width="1568" height="1126" alt="image" src="https://github.com/user-attachments/assets/94556dd6-c717-49a0-b02d-5f8fadb54c7f" />

---

## Acknowledgments

- Building height attributes may be missing in some regions; the code checks multiple tags and falls back to defaults.  
- Special thanks to **ChatGPT** by OpenAI for pairing on design and debugging.

---

## Roadmap

- Optional separate STLs: export **roads** and **buildings** as distinct files for dual-color prints or per-part slicing.
- Optional sidewalks, water polygons, and parks for additional detail.
- CLI & presets per city scale (auto width/height suggestions).

---

**Happy printing!** 🗺️🧱🛣️
