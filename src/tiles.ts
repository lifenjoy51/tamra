// tiles.ts — 타일 시스템 (글로벌 좌표 + 8x8 링 버퍼).
// tile (tx, ty) → slot (tx%8, ty%8). 글로벌 좌표 & MASK = 버퍼 위치.
// tile_index.json 이 source of truth: 없는 타일은 순수 바다로 flat fill.

import {
    SEA, TILE_SIZE, WORLD_TILES_X, WORLD_TILES_Y, BUF_TILES, SIZE,
} from './config';
import { boat } from './state';
import { generateColormap } from './terrain';

// 4096x4096 링 버퍼. 기본값 바다로 초기화.
export const altitude = new Uint8Array(SIZE * SIZE);
export const colormap = new Uint32Array(SIZE * SIZE);
altitude.fill(SEA);

// 슬롯별 현재 로드된 tile key (tx_ty) — 중복 로드 방지
export const slotTiles: (string | null)[] = new Array(BUF_TILES * BUF_TILES).fill(null);
const loadingTiles: { [key: string]: Promise<void> } = {};
let tileIndex: any = null;

// PNG 디코딩용 임시 캔버스
let tmpC: HTMLCanvasElement;
let tmpCtx: CanvasRenderingContext2D;

export function loadImage(src: string): Promise<HTMLImageElement> {
    return new Promise(function(resolve, reject) {
        var img = new Image();
        img.onload = function() { resolve(img); };
        img.onerror = reject;
        img.src = src;
    });
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

// 타일 하나를 슬롯에 로드 (async). 이미 로드 중/완료면 스킵.
export async function loadTile(tx: number, ty: number): Promise<void> {
    // 경도 wrap, 위도 clamp
    tx = ((tx % WORLD_TILES_X) + WORLD_TILES_X) % WORLD_TILES_X;
    if (ty < 0 || ty >= WORLD_TILES_Y) return;

    var key = tx + '_' + ty;
    var slotI = tx % BUF_TILES;
    var slotJ = ty % BUF_TILES;
    var slotIdx = slotJ * BUF_TILES + slotI;

    if (slotTiles[slotIdx] === key) return;       // 이미 로드됨
    if (loadingTiles[key]) return loadingTiles[key]; // 로딩 중

    var promise = (async function() {
        var heightRaw = new Uint8Array(TILE_SIZE * TILE_SIZE);
        var hasFile = tileIndex && tileIndex.tiles && tileIndex.tiles[key];

        if (hasFile) {
            try {
                var img = await loadImage('tiles/h_' + pad2(tx) + '_' + pad2(ty) + '.png');
                tmpCtx.clearRect(0, 0, TILE_SIZE, TILE_SIZE);
                tmpCtx.drawImage(img, 0, 0);
                var data = tmpCtx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
                for (var i = 0; i < TILE_SIZE * TILE_SIZE; i++) heightRaw[i] = data[i * 4];
            } catch (e) {
                heightRaw.fill(SEA); // 로드 실패 시 바다
            }
        } else {
            heightRaw.fill(SEA); // 인덱스에 없음 = 순수 바다
        }

        // 슬롯에 쓰기 (altitude + colormap)
        var tileCmap = generateColormap(heightRaw, TILE_SIZE, TILE_SIZE, tx, ty);
        var bx0 = slotI * TILE_SIZE;
        var by0 = slotJ * TILE_SIZE;
        for (var ly = 0; ly < TILE_SIZE; ly++) {
            var src = ly * TILE_SIZE;
            var dst = (by0 + ly) * SIZE + bx0;
            for (var lx = 0; lx < TILE_SIZE; lx++) {
                var h = heightRaw[src + lx];
                altitude[dst + lx] = h <= SEA ? SEA : h;
                colormap[dst + lx] = tileCmap[src + lx];
            }
        }
        slotTiles[slotIdx] = key;
        delete loadingTiles[key];
    })();

    loadingTiles[key] = promise;
    return promise;
}

// 현재 보트 위치 기준 5x5 타일 로드 (렌더 거리 800 커버)
export function ensureTilesLoaded() {
    var ctx = Math.floor(boat.gx / TILE_SIZE);
    var cty = Math.floor(boat.gy / TILE_SIZE);
    for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
            loadTile(ctx + dx, cty + dy);
        }
    }
}

// 초기화: tile_index.json + 임시 캔버스 준비 + 시작 위치 주변 5x5 동기 로드.
// 반환: { startGx, startGy } (main.ts 에서 boat/camera 초기 위치로 사용)
export async function initTiles(): Promise<{ startGx: number; startGy: number }> {
    var idxRes = await fetch('tiles/tile_index.json');
    tileIndex = await idxRes.json();

    tmpC = document.createElement('canvas');
    tmpC.width = TILE_SIZE;
    tmpC.height = TILE_SIZE;
    tmpCtx = tmpC.getContext('2d')!;

    // 시작 위치: 북위 24°, 경도 126.55°E (하지 태양이 천정 지나는 위도 근처)
    //   gy = (ORIGIN_LAT - 24) / DEG_PER_PIXEL = 66 * 240 = 15840
    var startGx = 73572, startGy = 15840;

    var startTx = Math.floor(startGx / TILE_SIZE);
    var startTy = Math.floor(startGy / TILE_SIZE);
    var initPromises: Promise<void>[] = [];
    for (var dy = -2; dy <= 2; dy++) {
        for (var dx = -2; dx <= 2; dx++) {
            initPromises.push(loadTile(startTx + dx, startTy + dy) as Promise<void>);
        }
    }
    await Promise.all(initPromises);

    return { startGx, startGy };
}
