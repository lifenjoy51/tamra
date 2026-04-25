#!/usr/bin/env python3
"""
[Legacy] 제주 1024×1024 단일 윈도우 PNG 생성기.
프로덕션 파이프라인은 generate_world_tiles.py (전세계 176×88 타일).
이 스크립트는 타일 결과 검증(--verify) 비교용으로만 유지된다.

jeju_hires_1024.raw (UInt16, 1024x1024) →
  jeju_hires_1024.png    (8-bit grayscale heightmap)
  jeju_colormap_1024.png (RGB colormap)

사용법:
  python3 generate_maps.py
"""
import numpy as np
from PIL import Image
import os

SIZE = 1024
SEA = 64

RAW_PATH = os.path.join(os.path.dirname(__file__), 'jeju_hires_1024.raw')
HEIGHT_PNG = os.path.join(os.path.dirname(__file__), 'jeju_hires_1024.png')
COLOR_PNG = os.path.join(os.path.dirname(__file__), 'jeju_colormap_1024.png')

# 구간별 선형 매핑 (piecewise linear)
# [미터 하한, 미터 상한, 출력 하한, 출력 상한]
SEGMENTS = [
    (-8000, -200,   0,  24),
    ( -200,  -10,  24,  48),
    (  -10,    0,  48,  64),
    (    0,   20,  64, 112),
    (   20,  200, 112, 160),
    (  200, 1000, 160, 208),
    ( 1000, 5000, 208, 255),
]


def generate_heightmap():
    """UInt16 raw → 8-bit grayscale PNG (구간별 선형 매핑 적용)"""
    raw = np.fromfile(RAW_PATH, dtype=np.uint16).reshape(SIZE, SIZE)

    # UInt16 → meters → Uint8 LUT
    lut = np.zeros(65536, dtype=np.uint8)
    for v in range(65536):
        m = (v / 65535.0) * 16000 - 8000
        for m_lo, m_hi, o_lo, o_hi in SEGMENTS:
            if m <= m_hi or (m_lo, m_hi) == (1000, 5000):
                t = max(0.0, min(1.0, (m - m_lo) / (m_hi - m_lo)))
                lut[v] = int(round(max(0, min(255, o_lo + t * (o_hi - o_lo)))))
                break

    out8 = lut[raw]
    Image.fromarray(out8, mode='L').save(HEIGHT_PNG)
    print(f'heightmap: {os.path.getsize(HEIGHT_PNG):,} bytes')
    return out8


def compute_hillshade(h):
    """heightmap에서 hillshading 계산 (북서쪽 광원)"""
    hf = h.astype(np.float32)
    # Sobel gradient (지형 경사)
    dx = np.zeros_like(hf)
    dy = np.zeros_like(hf)
    dx[:, 1:-1] = hf[:, 2:] - hf[:, :-2]
    dy[1:-1, :] = hf[2:, :] - hf[:-2, :]

    # 광원 방향: 북서쪽 위 (azimuth=315°, altitude=45°)
    az = np.radians(315)
    alt = np.radians(45)
    lx = np.cos(alt) * np.sin(az)
    ly = np.cos(alt) * np.cos(az)
    lz = np.sin(alt)

    # 법선 벡터 · 광원 벡터
    scale = 2.0  # 경사 과장 (입체감 강화)
    shade = (-dx * scale * lx - dy * scale * ly + lz)
    shade /= np.sqrt(dx * dx * scale * scale + dy * dy * scale * scale + 1.0)
    return np.clip(shade, 0, 1)


def generate_colormap(h):
    """8-bit heightmap → RGB colormap PNG (hillshading 적용)"""
    hf = h.astype(np.float32)
    hi = h.astype(np.int32)
    shade = compute_hillshade(hf)

    # 디더링 노이즈
    mx, my = np.meshgrid(np.arange(SIZE), np.arange(SIZE))
    n = ((((mx * 7 + my * 13) ^ (mx + my * 3)) & 15) - 7).astype(np.float32)

    r = np.zeros((SIZE, SIZE), dtype=np.float32)
    g = np.zeros((SIZE, SIZE), dtype=np.float32)
    b = np.zeros((SIZE, SIZE), dtype=np.float32)

    d = SEA - hi    # 바다 깊이
    a = hi - SEA    # 육지 고도

    # === 바다 ===
    sea = hi <= SEA
    # 연안 (d < 5)
    m = sea & (d < 5)
    r[m] = 70;  g[m] = 140 - d[m]*4; b[m] = 170 - d[m]*2
    # 얕은 바다 (5~15)
    m = sea & (d >= 5) & (d < 15)
    r[m] = 45;  g[m] = 100 - d[m]; b[m] = 160 - d[m]
    # 중간 바다 (15~40)
    m = sea & (d >= 15) & (d < 40)
    r[m] = 30;  g[m] = 65 - d[m]*0.4; b[m] = 140 - d[m]*0.5
    # 심해 (40+)
    m = sea & (d >= 40)
    r[m] = 18;  g[m] = 35;  b[m] = 90

    # 바다에 약한 노이즈
    r[sea] += n[sea] * 0.3
    g[sea] += n[sea] * 0.3
    b[sea] += n[sea] * 0.3

    # === 육지 ===
    # 실제 a값 분포: 해변20m→a48, 저지대200m→a96, 중산500m→a114, 한라산1950m→a155
    land = hi > SEA

    # 해변/모래 (a < 6, ~2.5m)
    m = land & (a < 6)
    r[m] = 194; g[m] = 178; b[m] = 130

    # 해안 초록 (a 6~48, ~2.5~20m)
    m = land & (a >= 6) & (a < 48)
    t = (a[m] - 6).astype(np.float32) / 42.0
    r[m] = 50 + t * 25;   g[m] = 100 + t * 30;  b[m] = 30 + t * 10

    # 저지대 짙은 초록 (a 48~96, 20~200m)
    m = land & (a >= 48) & (a < 96)
    t = (a[m] - 48).astype(np.float32) / 48.0
    r[m] = 75 + t * 35;   g[m] = 130 - t * 15;  b[m] = 40 + t * 15

    # 중산지 갈색 (a 96~130, 200~700m)
    m = land & (a >= 96) & (a < 130)
    t = (a[m] - 96).astype(np.float32) / 34.0
    r[m] = 110 + t * 30;  g[m] = 105 - t * 15;  b[m] = 55 + t * 10

    # 고산 어두운 갈색/바위 (a 130~155, 700~1950m)
    m = land & (a >= 130) & (a < 155)
    t = (a[m] - 130).astype(np.float32) / 25.0
    r[m] = 140 - t * 15;  g[m] = 90 - t * 10;   b[m] = 65 + t * 15

    # 정상 바위 (a 155+, 1950m+)
    m = land & (a >= 155)
    t = np.clip((a[m] - 155).astype(np.float32) / 36.0, 0, 1)
    r[m] = 125 + t * 30;  g[m] = 80 + t * 30;   b[m] = 80 + t * 30

    # 육지 노이즈
    r[land] += n[land] * 0.5
    g[land] += n[land] * 0.5
    b[land] += n[land] * 0.4

    # === Hillshading 적용 (육지만) ===
    # shade 0.0(그림자) ~ 1.0(밝음), ambient 0.35 + diffuse 0.65
    light = np.where(land, 0.35 + 0.65 * shade, 1.0)
    r *= light
    g *= light
    b *= light

    rgb = np.stack([
        np.clip(r, 0, 255).astype(np.uint8),
        np.clip(g, 0, 255).astype(np.uint8),
        np.clip(b, 0, 255).astype(np.uint8),
    ], axis=-1)
    Image.fromarray(rgb).save(COLOR_PNG)
    print(f'colormap:  {os.path.getsize(COLOR_PNG):,} bytes')


if __name__ == '__main__':
    h = generate_heightmap()
    generate_colormap(h)
    print('done')
