#!/usr/bin/env python3
"""
전세계 DEM 원본에서 해안선 타일만 생성하는 배치 파이프라인.

기본 사용:
  python3 generate_world_tiles.py
  python3 generate_world_tiles.py --classify-only
  python3 generate_world_tiles.py --tile 71,13
  python3 generate_world_tiles.py --verify
"""
from __future__ import annotations

import argparse
import json
import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image


SOURCE_WIDTH = 86400
SOURCE_HEIGHT = 43200
TILE_SIZE = 512
BUFFER_RADIUS = 2  # 5x5 neighborhood around strict coast
BORDER = 1
GRID_COLS = (SOURCE_WIDTH + TILE_SIZE - 1) // TILE_SIZE
GRID_ROWS = (SOURCE_HEIGHT + TILE_SIZE - 1) // TILE_SIZE
PIXEL_DEG = 1.0 / 240.0
DEG_PER_TILE = TILE_SIZE * PIXEL_DEG
FULL_TILE_COLS = SOURCE_WIDTH // TILE_SIZE
WRAP_WIDTH = GRID_COLS * TILE_SIZE - SOURCE_WIDTH
SEA = 64

SEGMENTS = [
    (-8000, -200, 0, 24),
    (-200, -10, 24, 48),
    (-10, 0, 48, 64),
    (0, 20, 64, 112),
    (20, 200, 112, 160),
    (200, 1000, 160, 208),
    (1000, 5000, 208, 255),
]

DEFAULT_SOURCE = Path(
    "/Users/joey51/works/heightmap/final_heightmap.raw"
)
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parent / "tiles"
CACHE_VERSION = 3
CACHE_FILE = "classification.json"
INDEX_FILE = "tile_index.json"
VERIFY_WINDOW = (73060, 13084)
VERIFY_REFERENCE_SIZE = 1024
LOCAL_JEJU_RAW = Path(__file__).resolve().parent / "jeju_hires_1024.raw"
LOCAL_JEJU_HEIGHT = Path(__file__).resolve().parent / "jeju_hires_1024.png"
LOCAL_JEJU_COLOR = Path(__file__).resolve().parent / "jeju_colormap_1024.png"


def build_piecewise_lut_from_meters(values: np.ndarray) -> np.ndarray:
    values = values.astype(np.float32)
    out = np.empty(values.shape, dtype=np.float32)
    remaining = np.ones(values.shape, dtype=bool)
    for idx, (m_lo, m_hi, o_lo, o_hi) in enumerate(SEGMENTS):
        mask = remaining if idx == len(SEGMENTS) - 1 else (values <= m_hi) & remaining
        if not np.any(mask):
            continue
        t = np.clip((values[mask] - m_lo) / (m_hi - m_lo), 0.0, 1.0)
        out[mask] = o_lo + t * (o_hi - o_lo)
        remaining[mask] = False
    return np.rint(np.clip(out, 0, 255)).astype(np.uint8)


INT16_TO_U8_LUT = build_piecewise_lut_from_meters(
    np.arange(-32768, 32768, dtype=np.int32)
)
SCALED_UINT16_TO_U8_LUT = build_piecewise_lut_from_meters(
    np.linspace(-8000, 8000, 65536, dtype=np.float32)
)
WRAPPED_X_TILE = [
    (np.arange(tx * TILE_SIZE, tx * TILE_SIZE + TILE_SIZE, dtype=np.int32) % SOURCE_WIDTH)
    for tx in range(GRID_COLS)
]
WRAPPED_X_WITH_BORDER = [
    (
        np.arange(
            tx * TILE_SIZE - BORDER,
            tx * TILE_SIZE + TILE_SIZE + BORDER,
            dtype=np.int32,
        )
        % SOURCE_WIDTH
    )
    for tx in range(GRID_COLS)
]


@dataclass
class ClassificationResult:
    strict_coast: np.ndarray
    targets: np.ndarray
    stats: dict[str, int]


def meters_to_u8(meters: np.ndarray) -> np.ndarray:
    indices = meters.astype(np.int32) + 32768
    return INT16_TO_U8_LUT[indices]


def scaled_uint16_to_u8(raw: np.ndarray) -> np.ndarray:
    return SCALED_UINT16_TO_U8_LUT[raw]


def compute_hillshade(heightmap_u8: np.ndarray) -> np.ndarray:
    hf = heightmap_u8.astype(np.float32)
    dx = np.zeros_like(hf)
    dy = np.zeros_like(hf)
    dx[:, 1:-1] = hf[:, 2:] - hf[:, :-2]
    dy[1:-1, :] = hf[2:, :] - hf[:-2, :]

    azimuth = np.radians(315.0)
    altitude = np.radians(45.0)
    lx = np.cos(altitude) * np.sin(azimuth)
    ly = np.cos(altitude) * np.cos(azimuth)
    lz = np.sin(altitude)

    scale = 2.0
    shade = (-dx * scale * lx - dy * scale * ly + lz)
    shade /= np.sqrt(dx * dx * scale * scale + dy * dy * scale * scale + 1.0)
    return np.clip(shade, 0.0, 1.0)


def generate_colormap(
    heightmap_u8: np.ndarray,
    shade: np.ndarray | None = None,
    global_x: np.ndarray | None = None,
    global_y: np.ndarray | None = None,
) -> np.ndarray:
    rows, cols = heightmap_u8.shape
    hi = heightmap_u8.astype(np.int32)
    shade = compute_hillshade(heightmap_u8) if shade is None else shade.astype(np.float32)

    if global_x is None:
        global_x = np.arange(cols, dtype=np.int32)
    else:
        global_x = np.asarray(global_x, dtype=np.int32)
    if global_y is None:
        global_y = np.arange(rows, dtype=np.int32)
    else:
        global_y = np.asarray(global_y, dtype=np.int32)

    gx = global_x[np.newaxis, :]
    gy = global_y[:, np.newaxis]
    noise = ((((gx * 7 + gy * 13) ^ (gx + gy * 3)) & 15) - 7).astype(np.float32)

    r = np.zeros((rows, cols), dtype=np.float32)
    g = np.zeros((rows, cols), dtype=np.float32)
    b = np.zeros((rows, cols), dtype=np.float32)

    d = SEA - hi
    a = hi - SEA

    sea = hi <= SEA
    land = ~sea

    m = sea & (d < 5)
    r[m] = 70
    g[m] = 140 - d[m] * 4
    b[m] = 170 - d[m] * 2

    m = sea & (d >= 5) & (d < 15)
    r[m] = 45
    g[m] = 100 - d[m]
    b[m] = 160 - d[m]

    m = sea & (d >= 15) & (d < 40)
    r[m] = 30
    g[m] = 65 - d[m] * 0.4
    b[m] = 140 - d[m] * 0.5

    m = sea & (d >= 40)
    r[m] = 18
    g[m] = 35
    b[m] = 90

    r[sea] += noise[sea] * 0.3
    g[sea] += noise[sea] * 0.3
    b[sea] += noise[sea] * 0.3

    m = land & (a < 6)
    r[m] = 194
    g[m] = 178
    b[m] = 130

    m = land & (a >= 6) & (a < 48)
    t = (a[m].astype(np.float32) - 6.0) / 42.0
    r[m] = 50 + t * 25
    g[m] = 100 + t * 30
    b[m] = 30 + t * 10

    m = land & (a >= 48) & (a < 96)
    t = (a[m].astype(np.float32) - 48.0) / 48.0
    r[m] = 75 + t * 35
    g[m] = 130 - t * 15
    b[m] = 40 + t * 15

    m = land & (a >= 96) & (a < 130)
    t = (a[m].astype(np.float32) - 96.0) / 34.0
    r[m] = 110 + t * 30
    g[m] = 105 - t * 15
    b[m] = 55 + t * 10

    m = land & (a >= 130) & (a < 155)
    t = (a[m].astype(np.float32) - 130.0) / 25.0
    r[m] = 140 - t * 15
    g[m] = 90 - t * 10
    b[m] = 65 + t * 15

    m = land & (a >= 155)
    t = np.clip((a[m].astype(np.float32) - 155.0) / 36.0, 0.0, 1.0)
    r[m] = 125 + t * 30
    g[m] = 80 + t * 30
    b[m] = 80 + t * 30

    r[land] += noise[land] * 0.5
    g[land] += noise[land] * 0.5
    b[land] += noise[land] * 0.4

    light = np.where(land, 0.35 + 0.65 * shade, 1.0)
    r *= light
    g *= light
    b *= light

    return np.stack(
        [
            np.clip(r, 0, 255).astype(np.uint8),
            np.clip(g, 0, 255).astype(np.uint8),
            np.clip(b, 0, 255).astype(np.uint8),
        ],
        axis=-1,
    )


def parse_tile(value: str) -> tuple[int, int]:
    try:
        tx_text, ty_text = value.split(",", 1)
        tx = int(tx_text)
        ty = int(ty_text)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("--tile 형식은 X,Y 여야 합니다.") from exc
    if not (0 <= tx < GRID_COLS and 0 <= ty < GRID_ROWS):
        raise argparse.ArgumentTypeError(
            f"타일 좌표는 0<=x<{GRID_COLS}, 0<=y<{GRID_ROWS} 범위여야 합니다."
        )
    return tx, ty


def tile_key(tx: int, ty: int) -> str:
    return f"{tx:02d}_{ty:02d}"


def mask_to_keys(mask: np.ndarray) -> list[str]:
    keys: list[str] = []
    for ty in range(mask.shape[0]):
        for tx in range(mask.shape[1]):
            if mask[ty, tx]:
                keys.append(tile_key(tx, ty))
    return keys


def keys_to_mask(keys: list[str]) -> np.ndarray:
    mask = np.zeros((GRID_ROWS, GRID_COLS), dtype=bool)
    for key in keys:
        tx_text, ty_text = key.split("_", 1)
        mask[int(ty_text), int(tx_text)] = True
    return mask


def source_signature(source_path: Path) -> dict[str, int | str]:
    stat = source_path.stat()
    return {
        "path": str(source_path),
        "size": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
    }


def load_source(source_path: Path) -> np.memmap:
    return np.memmap(
        source_path,
        dtype=np.int16,
        mode="r",
        shape=(SOURCE_HEIGHT, SOURCE_WIDTH),
    )


def classify_tiles(source: np.memmap) -> ClassificationResult:
    print(
        f"classifying {GRID_COLS}x{GRID_ROWS} tiles from {SOURCE_WIDTH}x{SOURCE_HEIGHT} source..."
    )
    has_land = np.zeros((GRID_ROWS, GRID_COLS), dtype=bool)
    has_water = np.zeros((GRID_ROWS, GRID_COLS), dtype=bool)
    north_water = np.zeros((GRID_ROWS, GRID_COLS, TILE_SIZE), dtype=bool)
    south_water = np.zeros((GRID_ROWS, GRID_COLS, TILE_SIZE), dtype=bool)
    west_water = np.zeros((GRID_ROWS, GRID_COLS, TILE_SIZE), dtype=bool)
    east_water = np.zeros((GRID_ROWS, GRID_COLS, TILE_SIZE), dtype=bool)
    start_time = time.time()

    for ty in range(GRID_ROWS):
        y0 = ty * TILE_SIZE
        y1 = min(y0 + TILE_SIZE, SOURCE_HEIGHT)
        block = np.asarray(source[y0:y1], dtype=np.int16)
        tile_h = block.shape[0]

        main = block[:, : FULL_TILE_COLS * TILE_SIZE].reshape(
            tile_h, FULL_TILE_COLS, TILE_SIZE
        )
        has_land[ty, :FULL_TILE_COLS] = main.max(axis=(0, 2)) > 0
        has_water[ty, :FULL_TILE_COLS] = main.min(axis=(0, 2)) <= 0
        north_water[ty, :FULL_TILE_COLS] = main[0] <= 0
        south_water[ty, :FULL_TILE_COLS] = main[-1] <= 0
        west_water[ty, :FULL_TILE_COLS, :tile_h] = np.swapaxes(main[:, :, 0] <= 0, 0, 1)
        east_water[ty, :FULL_TILE_COLS, :tile_h] = np.swapaxes(main[:, :, -1] <= 0, 0, 1)

        east = block[:, FULL_TILE_COLS * TILE_SIZE :]
        west = block[:, :WRAP_WIDTH]
        wrapped = np.concatenate([east, west], axis=1)
        has_land[ty, FULL_TILE_COLS] = wrapped.max() > 0
        has_water[ty, FULL_TILE_COLS] = wrapped.min() <= 0
        north_water[ty, FULL_TILE_COLS] = wrapped[0] <= 0
        south_water[ty, FULL_TILE_COLS] = wrapped[-1] <= 0
        west_water[ty, FULL_TILE_COLS, :tile_h] = wrapped[:, 0] <= 0
        east_water[ty, FULL_TILE_COLS, :tile_h] = wrapped[:, -1] <= 0

    ocean = mark_ocean_connected_tiles(
        north_water=north_water,
        south_water=south_water,
        west_water=west_water,
        east_water=east_water,
    )
    strict = has_land & ocean
    targets = expand_strict_coast(strict)

    dry_land_only = has_land & ~has_water
    inland_water_mixed = has_land & has_water & ~ocean
    inland_water_only = ~has_land & has_water & ~ocean
    ocean_only = ~has_land & ocean

    for ty in range(GRID_ROWS):
        print(
            f"  row {ty + 1:02d}/{GRID_ROWS}: strict coast {int(np.count_nonzero(strict[ty])):02d}",
            flush=True,
        )
    elapsed = time.time() - start_time
    stats = {
        "dry_land_only": int(np.count_nonzero(dry_land_only)),
        "inland_water_mixed": int(np.count_nonzero(inland_water_mixed)),
        "inland_water_only": int(np.count_nonzero(inland_water_only)),
        "ocean_only": int(np.count_nonzero(ocean_only)),
        "strict_coast": int(np.count_nonzero(strict)),
        "expanded_targets": int(np.count_nonzero(targets)),
        "elapsed_sec": round(elapsed, 2),
    }
    return ClassificationResult(strict_coast=strict, targets=targets, stats=stats)


def mark_ocean_connected_tiles(
    north_water: np.ndarray,
    south_water: np.ndarray,
    west_water: np.ndarray,
    east_water: np.ndarray,
) -> np.ndarray:
    # ocean-connected water includes any channel that stays open to the sea,
    # such as river mouths, estuaries, and narrow coastal inlets.
    ocean = np.zeros((GRID_ROWS, GRID_COLS), dtype=bool)
    queue: list[tuple[int, int]] = []

    for tx in range(GRID_COLS):
        if np.any(north_water[0, tx]):
            ocean[0, tx] = True
            queue.append((0, tx))
        last_row = GRID_ROWS - 1
        if np.any(south_water[last_row, tx]) and not ocean[last_row, tx]:
            ocean[last_row, tx] = True
            queue.append((last_row, tx))

    head = 0
    while head < len(queue):
        ty, tx = queue[head]
        head += 1

        west_tx = (tx - 1) % GRID_COLS
        if not ocean[ty, west_tx] and np.any(west_water[ty, tx] & east_water[ty, west_tx]):
            ocean[ty, west_tx] = True
            queue.append((ty, west_tx))

        east_tx = (tx + 1) % GRID_COLS
        if not ocean[ty, east_tx] and np.any(east_water[ty, tx] & west_water[ty, east_tx]):
            ocean[ty, east_tx] = True
            queue.append((ty, east_tx))

        if ty > 0 and not ocean[ty - 1, tx] and np.any(north_water[ty, tx] & south_water[ty - 1, tx]):
            ocean[ty - 1, tx] = True
            queue.append((ty - 1, tx))

        if ty + 1 < GRID_ROWS and not ocean[ty + 1, tx] and np.any(south_water[ty, tx] & north_water[ty + 1, tx]):
            ocean[ty + 1, tx] = True
            queue.append((ty + 1, tx))

    return ocean


def expand_strict_coast(strict: np.ndarray) -> np.ndarray:
    targets = strict.copy()
    coast_tiles = np.argwhere(strict)
    for ty, tx in coast_tiles:
        for dy in range(-BUFFER_RADIUS, BUFFER_RADIUS + 1):
            ny = ty + dy
            if not (0 <= ny < GRID_ROWS):
                continue
            for dx in range(-BUFFER_RADIUS, BUFFER_RADIUS + 1):
                nx = (tx + dx) % GRID_COLS
                targets[ny, nx] = True
    return targets


def classification_cache_path(output_dir: Path) -> Path:
    return output_dir / CACHE_FILE


def write_classification_cache(
    output_dir: Path,
    source_path: Path,
    result: ClassificationResult,
) -> None:
    cache_path = classification_cache_path(output_dir)
    payload = {
        "cache_version": CACHE_VERSION,
        "grid": {
            "cols": GRID_COLS,
            "rows": GRID_ROWS,
            "tile_size": TILE_SIZE,
            "buffer_radius": BUFFER_RADIUS,
        },
        "source": source_signature(source_path),
        "stats": result.stats,
        "strict_coast": mask_to_keys(result.strict_coast),
        "targets": mask_to_keys(result.targets),
    }
    cache_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def load_classification_cache(
    output_dir: Path,
    source_path: Path,
) -> ClassificationResult | None:
    cache_path = classification_cache_path(output_dir)
    if not cache_path.exists():
        return None
    payload = json.loads(cache_path.read_text(encoding="utf-8"))
    if payload.get("cache_version") != CACHE_VERSION:
        return None
    if payload.get("source") != source_signature(source_path):
        return None
    return ClassificationResult(
        strict_coast=keys_to_mask(payload["strict_coast"]),
        targets=keys_to_mask(payload["targets"]),
        stats=payload["stats"],
    )


def get_or_create_classification(
    source: np.memmap,
    source_path: Path,
    output_dir: Path,
    reclassify: bool,
) -> ClassificationResult:
    if not reclassify:
        cached = load_classification_cache(output_dir, source_path)
        if cached is not None:
            print("using cached classification")
            return cached
    result = classify_tiles(source)
    write_classification_cache(output_dir, source_path, result)
    return result


def read_row_band(source: np.memmap, ty: int) -> np.ndarray:
    y0 = ty * TILE_SIZE - BORDER
    total_rows = TILE_SIZE + BORDER * 2
    band = np.empty((total_rows, SOURCE_WIDTH), dtype=np.int16)

    src_start = max(y0, 0)
    src_stop = min(y0 + total_rows, SOURCE_HEIGHT)
    out_start = src_start - y0
    out_stop = out_start + (src_stop - src_start)

    band[out_start:out_stop] = source[src_start:src_stop]
    if out_start:
        band[:out_start] = band[out_start]
    if out_stop < total_rows:
        band[out_stop:] = band[out_stop - 1]
    return band


def extract_tile_with_border(row_band: np.ndarray, tx: int) -> np.ndarray:
    start = tx * TILE_SIZE - BORDER
    stop = tx * TILE_SIZE + TILE_SIZE + BORDER
    if 0 <= start and stop <= SOURCE_WIDTH:
        return row_band[:, start:stop]
    return row_band[:, WRAPPED_X_WITH_BORDER[tx]]


def tile_y_coords(ty: int) -> np.ndarray:
    start = ty * TILE_SIZE
    stop = start + TILE_SIZE
    return np.clip(np.arange(start, stop, dtype=np.int32), 0, SOURCE_HEIGHT - 1)


def render_tile_from_band(row_band: np.ndarray, tx: int, ty: int) -> tuple[np.ndarray, np.ndarray]:
    tile_meters = extract_tile_with_border(row_band, tx)
    height_with_border = meters_to_u8(tile_meters)
    shade = compute_hillshade(height_with_border)[1:-1, 1:-1]
    height_tile = height_with_border[1:-1, 1:-1]
    color_tile = generate_colormap(
        height_tile,
        shade=shade,
        global_x=WRAPPED_X_TILE[tx],
        global_y=tile_y_coords(ty),
    )
    return height_tile, color_tile


def write_tile(output_dir: Path, tx: int, ty: int, height: np.ndarray, color: np.ndarray) -> None:
    key = tile_key(tx, ty)
    Image.fromarray(height, mode="L").save(output_dir / f"h_{key}.png")
    Image.fromarray(color, mode="RGB").save(output_dir / f"c_{key}.png")


def tile_files_exist(output_dir: Path, tx: int, ty: int) -> bool:
    key = tile_key(tx, ty)
    return (
        (output_dir / f"h_{key}.png").exists()
        and (output_dir / f"c_{key}.png").exists()
    )


def tile_bounds(tx: int, ty: int) -> tuple[float, float, float, float]:
    lon0 = -180.0 + tx * DEG_PER_TILE
    lon1 = lon0 + DEG_PER_TILE
    lat0 = 90.0 - ty * DEG_PER_TILE
    lat1 = lat0 - DEG_PER_TILE
    return lon0, lat0, lon1, lat1


def print_stats(stats: dict[str, int]) -> None:
    print("classification summary")
    print(f"  ocean only:       {stats['ocean_only']}")
    print(f"  dry land only:    {stats['dry_land_only']}")
    print(f"  inland water mix: {stats['inland_water_mixed']}")
    print(f"  inland water only:{stats['inland_water_only']}")
    print(f"  strict coast:     {stats['strict_coast']}")
    print(f"  expanded targets: {stats['expanded_targets']}")
    if "elapsed_sec" in stats:
        print(f"  elapsed:          {stats['elapsed_sec']}s")


def generate_target_tiles(
    source: np.memmap,
    output_dir: Path,
    targets: np.ndarray,
    force: bool,
) -> tuple[int, int]:
    generated = 0
    skipped = 0
    total_targets = int(np.count_nonzero(targets))
    print(f"generating {total_targets} target tiles into {output_dir}...")

    for ty in range(GRID_ROWS):
        row_targets = np.flatnonzero(targets[ty])
        if row_targets.size == 0:
            continue
        row_band = read_row_band(source, ty)
        print(f"  render row {ty + 1:02d}/{GRID_ROWS}: {len(row_targets)} tiles", flush=True)
        for tx in row_targets.tolist():
            if not force and tile_files_exist(output_dir, tx, ty):
                skipped += 1
                continue
            height, color = render_tile_from_band(row_band, tx, ty)
            write_tile(output_dir, tx, ty, height, color)
            generated += 1
    return generated, skipped


def write_tile_index(output_dir: Path, targets: np.ndarray) -> Path:
    tiles: dict[str, str] = {}
    for ty in range(GRID_ROWS):
        for tx in range(GRID_COLS):
            if not targets[ty, tx]:
                continue
            if tile_files_exist(output_dir, tx, ty):
                tiles[f"{tx}_{ty}"] = "generated"

    payload = {
        "grid": {
            "cols": GRID_COLS,
            "rows": GRID_ROWS,
            "tile_size": TILE_SIZE,
            "buffer_radius": BUFFER_RADIUS,
        },
        "geo": {
            "origin_lon": -180.0,
            "origin_lat": 90.0,
            "deg_per_tile": DEG_PER_TILE,
            "pixel_deg": PIXEL_DEG,
        },
        "tiles": tiles,
    }
    index_path = output_dir / INDEX_FILE
    index_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True),
        encoding="utf-8",
    )
    return index_path


def render_single_tile(
    source: np.memmap,
    output_dir: Path,
    tx: int,
    ty: int,
    force: bool,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    if tile_files_exist(output_dir, tx, ty) and not force:
        print(f"tile {tile_key(tx, ty)} already exists, use --force to overwrite")
        return

    row_band = read_row_band(source, ty)
    height, color = render_tile_from_band(row_band, tx, ty)
    write_tile(output_dir, tx, ty, height, color)
    lon0, lat0, lon1, lat1 = tile_bounds(tx, ty)
    print(
        f"generated tile {tile_key(tx, ty)} "
        f"lon {lon0:.3f}..{lon1:.3f}, lat {lat0:.3f}..{lat1:.3f}"
    )


def compare_arrays(label: str, actual: np.ndarray, expected: np.ndarray) -> None:
    diff = actual.astype(np.int16) - expected.astype(np.int16)
    mismatches = int(np.count_nonzero(diff))
    max_abs = int(np.max(np.abs(diff))) if mismatches else 0
    print(f"{label}: mismatches={mismatches}, max_abs_diff={max_abs}")


def verify_against_local_reference(source: np.memmap) -> None:
    if not (LOCAL_JEJU_RAW.exists() and LOCAL_JEJU_HEIGHT.exists() and LOCAL_JEJU_COLOR.exists()):
        raise FileNotFoundError("로컬 제주 참고 파일이 없습니다.")

    scaled_raw = np.fromfile(LOCAL_JEJU_RAW, dtype=np.uint16).reshape(
        VERIFY_REFERENCE_SIZE,
        VERIFY_REFERENCE_SIZE,
    )
    expected_height = np.array(Image.open(LOCAL_JEJU_HEIGHT))
    expected_color = np.array(Image.open(LOCAL_JEJU_COLOR))

    rebuilt_height = scaled_uint16_to_u8(scaled_raw)
    rebuilt_color = generate_colormap(rebuilt_height)
    print("verify: local jeju raw -> current PNG outputs")
    compare_arrays("  height", rebuilt_height, expected_height)
    compare_arrays("  color", rebuilt_color, expected_color)

    x0, y0 = VERIFY_WINDOW
    source_window = np.asarray(
        source[y0 : y0 + VERIFY_REFERENCE_SIZE, x0 : x0 + VERIFY_REFERENCE_SIZE],
        dtype=np.int16,
    )
    source_height = meters_to_u8(source_window)
    source_color = generate_colormap(source_height)
    print("verify: source DEM window -> current PNG outputs")
    compare_arrays("  height", source_height, expected_height)
    compare_arrays("  color", source_color, expected_color)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=DEFAULT_SOURCE,
        help=f"원본 DEM RAW 경로 (기본값: {DEFAULT_SOURCE})",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help=f"출력 폴더 (기본값: {DEFAULT_OUTPUT_DIR})",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="기존 PNG가 있어도 덮어쓴다.",
    )
    parser.add_argument(
        "--reclassify",
        action="store_true",
        help="classification cache를 무시하고 다시 분류한다.",
    )

    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--classify-only",
        action="store_true",
        help="분류/통계만 수행하고 PNG는 만들지 않는다.",
    )
    mode.add_argument(
        "--tile",
        type=parse_tile,
        help="단일 타일만 생성한다. 형식: X,Y",
    )
    mode.add_argument(
        "--verify",
        action="store_true",
        help="제주 참고 PNG와 매핑 결과를 비교한다.",
    )
    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()

    source_path: Path = args.source
    output_dir: Path = args.output_dir

    if not source_path.exists():
        raise FileNotFoundError(f"source DEM not found: {source_path}")

    output_dir.mkdir(parents=True, exist_ok=True)
    source = load_source(source_path)

    if args.verify:
        verify_against_local_reference(source)
        return

    if args.tile is not None:
        tx, ty = args.tile
        render_single_tile(source, output_dir, tx, ty, force=args.force)
        return

    classification = get_or_create_classification(
        source,
        source_path=source_path,
        output_dir=output_dir,
        reclassify=args.reclassify,
    )
    print_stats(classification.stats)

    if args.classify_only:
        print(f"cache written: {classification_cache_path(output_dir)}")
        return

    generated, skipped = generate_target_tiles(
        source,
        output_dir=output_dir,
        targets=classification.targets,
        force=args.force,
    )
    index_path = write_tile_index(output_dir, classification.targets)
    print(f"generated tiles: {generated}")
    print(f"skipped existing: {skipped}")
    print(f"tile index: {index_path}")


if __name__ == "__main__":
    main()
