// terrain-mesh.ts — lowpoly 지형 청크 매니저.
// altitude 링버퍼를 STRIDE 간격으로 샘플해 CHUNK×CHUNK(world px) 청크 메시를 만든다.
// 배 주변 camera.distance(2D 렌더 거리와 동일) 안의 청크만 유지하고, 매 프레임 가까운 것부터
// BUILD_PER_FRAME 개씩 증분 생성 — 통째 재생성(프레임 끊김 + 재중심 시 원경 팝인)을 피한다.
// 정점 공유(indexed) 격자 + 스무스 셰이딩 + 고도별 색 보간.
import * as THREE from 'three';
import { SEA, MASK, SHIFT, TILE_SIZE, BUF_TILES } from '../config';
import { camera as gcam } from '../state';
import { altitude, slotTiles } from '../tiles';
import { heightMeters } from '../terrain';
import { worldToScene, metersToSceneY, applyCurvature } from './coords';

const STRIDE = 4;          // 원경 월드 px 샘플 간격 (1.6km)
// 근경 LOD: 배 근처 청크는 1 px(400m) 간격 — 원경 간격이면 해안선이 km 단위로 어긋나
// 배가 "보이지 않는 해안"에 막히거나 모래 비탈이 코앞에 벽처럼 선다.
const STRIDE_NEAR = 1;
const NEAR_DIST = 40;      // 배 ↔ 청크 최근접점 거리(world px, ~16km) 이내면 근경 LOD
const NEAR_HYST = 8;       // 경계에서 LOD 가 깜박이지 않게 해제는 NEAR_DIST + NEAR_HYST 에서
const CHUNK = 64;          // 청크 한 변 (world px). TILE_SIZE(512) 약수 → 청크는 항상 타일 1개 안에 들어간다.
const BUILD_PER_FRAME = 8;

// 바다 정점 높이(m). altitude 는 바다를 SEA 로 평탄화해 수심 정보가 없다.
// 0m 로 두면 물 평면(파고 ±1.25m)과 같은 높이라 지형이 바다를 덮는다 — 물 아래로 내려
// 해안선을 가로지르는 삼각형만 수면과 교차하게 한다.
const SEA_FLOOR_M = -5;
const SEA_FLOOR_Y = metersToSceneY(SEA_FLOOR_M);

// 팔레트 값은 sRGB 기준 — vertex color 는 linear 로 해석되므로 미리 변환해 둔다.
function srgb(r: number, g: number, b: number): [number, number, number] {
    var c = new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
    return [c.r, c.g, c.b];
}
const COL_SAND = srgb(0.86, 0.80, 0.60);
const COL_LOW  = srgb(0.36, 0.58, 0.30);
const COL_HILL = srgb(0.27, 0.47, 0.24);
const COL_ROCK = srgb(0.42, 0.36, 0.28);
const COL_PEAK = srgb(0.55, 0.55, 0.56);

// 육지 고도(m, 해수면 위)별 양식화 팔레트 — 사진톤 colormap 미사용, 단순 lowpoly 톤.
// 바다 정점도 모래색: 수면 아래라 직접 보이진 않고, 해안 삼각형에서 육지색과 보간돼 모래 해안띠가 된다.
// (포말색을 쓰면 셀 하나(1.6km) 폭으로 번져 눈 덮인 것처럼 보였다)
function paletteFor(hM: number): [number, number, number] {
    if (hM <= 4)    return COL_SAND;   // 모래(해안)
    if (hM < 40)    return COL_LOW;    // 저지대 초록
    if (hM < 150)   return COL_HILL;   // 산지 초록(짙게)
    if (hM < 500)   return COL_ROCK;   // 암갈색
    return COL_PEAK;                   // 회색 봉우리
}

const material = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: false, // 스무스 셰이딩 — 고도 색 밴드만으로 스타일라이즈, 표면은 매끈하게
    roughness: 1.0,
    metalness: 0.0,
});
applyCurvature(material);

interface Chunk {
    mesh: THREE.Mesh | null; // 전부 바다면 null (그릴 삼각형 없음)
    tileKey: string | null;  // 생성 시점의 slotTiles 값 — 바뀌면(타일 늦게 로드/교체) 재생성
    stride: number;          // 생성 LOD — 원하는 LOD 와 다르면 재생성
    seen: number;            // 마지막으로 범위 안에 있던 프레임
}
const chunks = new Map<string, Chunk>();
let frameNo = 0;

function slotIdxOf(cx: number, cy: number): number {
    var tx = Math.floor(cx * CHUNK / TILE_SIZE), ty = Math.floor(cy * CHUNK / TILE_SIZE);
    // WORLD_TILES_X/Y 가 BUF_TILES 배수라 wrap 전/후 slot 동일 — 음수만 보정.
    var si = ((tx % BUF_TILES) + BUF_TILES) % BUF_TILES;
    var sj = ((ty % BUF_TILES) + BUF_TILES) % BUF_TILES;
    return sj * BUF_TILES + si;
}

function altAt(gx: number, gy: number): number {
    return altitude[((gy & MASK) << SHIFT) + (gx & MASK)];
}

function hAt(alt: number): number {
    return alt <= SEA ? SEA_FLOOR_Y : metersToSceneY(heightMeters[alt]);
}

// 청크 정점 + 테두리 1칸(법선 중앙차분용) 높이 샘플. 바다 = SEA_FLOOR_Y.
// stride < STRIDE 인 근경 청크는 테두리 정점을 원경 격자 높이의 선형보간으로 맞춘다 —
// 이웃 원경 청크의 모서리와 정확히 같은 선이 되어 LOD 경계에 틈이 생기지 않는다.
function buildChunkMesh(cx: number, cy: number, stride: number): THREE.Mesh | null {
    var CELLS = CHUNK / stride, VERTS = CELLS + 1, H_N = VERTS + 2;
    var hBuf = new Float32Array(H_N * H_N);
    var seaBuf = new Uint8Array(H_N * H_N);
    var gx0 = cx * CHUNK, gy0 = cy * CHUNK;
    var anyLand = false;
    for (var j = 0; j < H_N; j++) {
        var gy = gy0 + (j - 1) * stride;
        for (var i = 0; i < H_N; i++) {
            var alt = altAt(gx0 + (i - 1) * stride, gy);
            var k = j * H_N + i;
            seaBuf[k] = alt <= SEA ? 1 : 0;
            hBuf[k] = hAt(alt);
            if (!seaBuf[k]) anyLand = true;
        }
    }
    if (!anyLand) return null;
    if (stride < STRIDE) {
        for (var e = 0; e < VERTS; e++) {
            var off = e * stride, a = off - off % STRIDE, t = (off - a) / STRIDE;
            if (t === 0) continue;
            // 네 변: (e, 0) 위 / (e, CELLS) 아래 / (0, e) 왼 / (CELLS, e) 오른
            for (var side = 0; side < 4; side++) {
                var horiz = side < 2, fixed = (side & 1) ? CHUNK : 0;
                var ax = horiz ? gx0 + a : gx0 + fixed, ay = horiz ? gy0 + fixed : gy0 + a;
                var bx = horiz ? ax + STRIDE : ax, by = horiz ? ay : ay + STRIDE;
                var altA = altAt(ax, ay), altB = altAt(bx, by);
                var vxi = horiz ? e : (fixed / stride), vzi = horiz ? (fixed / stride) : e;
                var kk = (vzi + 1) * H_N + (vxi + 1);
                hBuf[kk] = hAt(altA) + (hAt(altB) - hAt(altA)) * t;
                seaBuf[kk] = (altA <= SEA && altB <= SEA) ? 1 : 0;
            }
        }
    }

    var positions = new Float32Array(VERTS * VERTS * 3);
    var normals = new Float32Array(VERTS * VERTS * 3);
    var colors = new Float32Array(VERTS * VERTS * 3);
    var p0 = worldToScene(gx0, gy0);
    for (var vz = 0; vz < VERTS; vz++) {
        for (var vx = 0; vx < VERTS; vx++) {
            var hk = (vz + 1) * H_N + (vx + 1);
            var vi = (vz * VERTS + vx) * 3;
            positions[vi]     = p0.x + vx * stride;
            positions[vi + 1] = hBuf[hk];
            positions[vi + 2] = p0.z + vz * stride;
            // 높이장 y=f(x,z) 의 위쪽 법선 = (-fx, 1, -fz). 청크 밖 테두리 샘플을 써서 경계 이음매 없음.
            var nx = -(hBuf[hk + 1] - hBuf[hk - 1]) / (2 * stride);
            var nz = -(hBuf[hk + H_N] - hBuf[hk - H_N]) / (2 * stride);
            var inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
            normals[vi] = nx * inv; normals[vi + 1] = inv; normals[vi + 2] = nz * inv;
            var col = seaBuf[hk] ? COL_SAND : paletteFor(heightMeters[altAt(gx0 + vx * stride, gy0 + vz * stride)]);
            colors[vi] = col[0]; colors[vi + 1] = col[1]; colors[vi + 2] = col[2];
        }
    }

    var indices: number[] = [];
    for (var jz = 0; jz < CELLS; jz++) {
        for (var jx = 0; jx < CELLS; jx++) {
            var i00 = jz * VERTS + jx;
            var i10 = i00 + 1;
            var i01 = i00 + VERTS;
            var i11 = i01 + 1;
            // 네 꼭짓점이 모두 바다면 전부 수면 아래 — 그릴 필요 없음(삼각형 수 대폭 감소).
            var s = (jz + 1) * H_N + (jx + 1);
            if (seaBuf[s] & seaBuf[s + 1] & seaBuf[s + H_N] & seaBuf[s + H_N + 1]) continue;
            // 감기 순서: 위(+Y)에서 볼 때 CCW — (i00,i10,i01) 이면 (+x)×(+z) = -Y 로 법선이 아래를 향해
            // 앞면 컬링으로 가까운 사면이 빠지고 조명이 뒤집힌다.
            indices.push(i00, i01, i10, i10, i01, i11);
        }
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeBoundingSphere();
    return new THREE.Mesh(geo, material);
}

function disposeChunk(scene: THREE.Scene, c: Chunk) {
    if (!c.mesh) return;
    scene.remove(c.mesh);
    c.mesh.geometry.dispose();
    c.mesh = null;
}

// 매 프레임 호출. budget = 이번 프레임 최대 생성 청크 수 (init 시 Infinity 로 전부 생성).
export function updateTerrainChunks(scene: THREE.Scene, gx: number, gy: number, budget = BUILD_PER_FRAME) {
    frameNo++;
    var radius = gcam.distance;
    var reach = radius + CHUNK * 0.71; // 청크 중심 기준 반경 (대각 반폭 여유)
    var ccx = Math.floor(gx / CHUNK), ccy = Math.floor(gy / CHUNK);
    var r = Math.ceil(reach / CHUNK);
    var todo: { cx: number; cy: number; d2: number; key: string; slot: string | null; stride: number }[] = [];

    for (var cy = ccy - r; cy <= ccy + r; cy++) {
        for (var cx = ccx - r; cx <= ccx + r; cx++) {
            var dx = (cx + 0.5) * CHUNK - gx, dy = (cy + 0.5) * CHUNK - gy;
            var d2 = dx * dx + dy * dy;
            if (d2 > reach * reach) continue;
            var key = cx + '_' + cy;
            var slot = slotTiles[slotIdxOf(cx, cy)];
            var c = chunks.get(key);
            // 배 ↔ 청크 사각형 최근접점 거리로 LOD 결정 (이미 근경이면 히스테리시스만큼 더 유지)
            var nxd = Math.max(0, Math.abs(dx) - CHUNK / 2), nyd = Math.max(0, Math.abs(dy) - CHUNK / 2);
            var nearR = NEAR_DIST + (c && c.stride === STRIDE_NEAR ? NEAR_HYST : 0);
            var stride = nxd * nxd + nyd * nyd < nearR * nearR ? STRIDE_NEAR : STRIDE;
            if (c) {
                c.seen = frameNo;
                if (c.tileKey === slot && c.stride === stride) continue;
            }
            todo.push({ cx, cy, d2, key, slot, stride });
        }
    }

    // 범위를 벗어난 청크 제거 (범위 안 청크는 위 루프에서 seen 갱신됨 — 재생성 대기 중인 것 포함)
    chunks.forEach(function (c, key) {
        if (c.seen !== frameNo) {
            disposeChunk(scene, c);
            chunks.delete(key);
        }
    });

    todo.sort(function (a, b) { return a.d2 - b.d2; });
    var n = Math.min(budget, todo.length);
    for (var ti = 0; ti < n; ti++) {
        var t = todo[ti];
        var old = chunks.get(t.key);
        if (old) disposeChunk(scene, old);
        var mesh = buildChunkMesh(t.cx, t.cy, t.stride);
        if (mesh) scene.add(mesh);
        chunks.set(t.key, { mesh: mesh, tileKey: t.slot, stride: t.stride, seen: frameNo });
    }
}
