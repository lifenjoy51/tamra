#!/usr/bin/env python3
"""원본 height map 을 512 배수 해상도로 업스케일 (1회성).

입력:  ~/works/heightmap/final_heightmap.raw        (86400×43200 int16, 7.46GB)
출력:  ~/works/heightmap/final_heightmap_176x88.raw (90112×45056 int16, 8.12GB)

dtype 주의: 원본은 int16 (해저 음수, 예: -5319m). uint16 으로 읽으면 음수가 거대
양수로 해석돼 bilinear 결과가 깨진다. generate_world_tiles.py 도 int16 으로 읽음.

목적: 가로 176 × 세로 88 타일(512px) 그리드로 정렬 → 링버퍼(BUF_TILES=8) wrap 자연 지원.
      176 % 8 = 0, 88 % 8 = 0. 비율 2:1 유지(equirectangular 정합).

chunked bilinear: 출력 세로 band 512행씩 처리 → 피크 메모리 ~500MB.
"""
import numpy as np
from pathlib import Path
import time
import sys

SRC_W, SRC_H = 86400, 43200
DST_W, DST_H = 90112, 45056
BAND_H = 512

SRC = Path.home() / "works" / "heightmap" / "final_heightmap.raw"
DST = Path.home() / "works" / "heightmap" / "final_heightmap_176x88.raw"


def main():
    if not SRC.exists():
        sys.exit(f"원본 없음: {SRC}")
    expected = SRC_W * SRC_H * 2
    actual = SRC.stat().st_size
    if actual != expected:
        sys.exit(f"원본 크기 불일치: {actual:,} != {expected:,}")

    if DST.exists():
        print(f"WARN: 기존 출력 파일 덮어씀: {DST}")

    src = np.memmap(SRC, dtype=np.int16, mode="r", shape=(SRC_H, SRC_W))
    dst = np.memmap(DST, dtype=np.int16, mode="w+", shape=(DST_H, DST_W))

    # 가로 보간용 인덱스/weight (출력 열당 1회 계산)
    x_src = np.linspace(0, SRC_W - 1, DST_W, dtype=np.float64)
    x0 = np.floor(x_src).astype(np.int64)
    x1 = np.clip(x0 + 1, 0, SRC_W - 1)
    wx = (x_src - x0).astype(np.float32)  # (DST_W,)

    # 세로 보간용 (출력 행당 정밀도)
    y_src = np.linspace(0, SRC_H - 1, DST_H, dtype=np.float64)

    print(f"업스케일 시작: {SRC_W}×{SRC_H} → {DST_W}×{DST_H}")
    print(f"  band={BAND_H} rows, iterations={DST_H // BAND_H}")
    t0 = time.time()

    for by0 in range(0, DST_H, BAND_H):
        by1 = min(by0 + BAND_H, DST_H)
        y_band = y_src[by0:by1]
        y0 = np.floor(y_band).astype(np.int64)
        y1 = np.clip(y0 + 1, 0, SRC_H - 1)
        wy = (y_band - y0).astype(np.float32)  # (band_h,)

        ymin = int(y0.min())
        ymax = int(y1.max()) + 1
        # 필요한 입력 행 범위만 RAM 으로
        src_band = np.asarray(src[ymin:ymax, :], dtype=np.float32)

        # 1) 가로 보간: (rows, SRC_W) → (rows, DST_W)
        a = src_band[:, x0] * (1.0 - wx) + src_band[:, x1] * wx

        # 2) 세로 보간: 출력 행 각각 y0/y1 가중
        y0r = y0 - ymin
        y1r = y1 - ymin
        top = a[y0r, :]
        bot = a[y1r, :]
        out = top * (1.0 - wy[:, None]) + bot * wy[:, None]

        dst[by0:by1, :] = np.clip(out, -32768, 32767).astype(np.int16)

        elapsed = time.time() - t0
        pct = by1 / DST_H * 100
        eta = elapsed / pct * (100 - pct) if pct > 0 else 0
        print(
            f"  {by1:>6}/{DST_H} ({pct:5.1f}%)  elapsed {elapsed:6.1f}s  ETA {eta:6.1f}s"
        )

    dst.flush()
    del dst
    print(f"done. {DST} ({DST.stat().st_size:,} bytes)")
    print(f"total {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()
