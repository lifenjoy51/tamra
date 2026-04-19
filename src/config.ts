// --- Config ---
// 불변 상수만 포함. PX_SCALE(fitCanvas 재할당)와 TIME_SPEED(T/Y 재할당)는 main.ts/state.ts 에 유지.

export const SCR_W = 640;
export const SCR_H = 360;   // 16:9 internal
export const SEA = 64;      // 해수면 (0m = 출력값 64)

// 타일 시스템
export const TILE_SIZE = 512;
export const TILE_SHIFT = 9;                     // 2^9 = 512
export const WORLD_TILES_X = 169;                // tile_index.json grid.cols
export const WORLD_TILES_Y = 85;
export const WORLD_W = WORLD_TILES_X * TILE_SIZE; // 86528
export const WORLD_H = WORLD_TILES_Y * TILE_SIZE;

// 8x8 슬롯 버퍼 (4096x4096). 각 타일 (tx, ty) → 슬롯 (tx%8, ty%8)
// 5x5 로드 범위(2.5 타일 = 1280)가 렌더 거리(800)보다 커야 뒤쪽 오래된 타일이 안 보임
export const BUF_TILES = 8;
export const SHIFT = 12;                         // 2^12 = 4096
export const SIZE = 1 << SHIFT;
export const MASK = SIZE - 1;

// Geo 메타 (tile_index.json 일치) — 월드 픽셀 → 위/경도 변환용
export const ORIGIN_LON = -180;
export const ORIGIN_LAT = 90;
export const DEG_PER_PIXEL = 2.1333333333333333 / 512;  // deg_per_tile / tile_size

// 시간 가속 한계
export const TIME_SPEED_MIN = 1;
export const TIME_SPEED_MAX = 7200;
