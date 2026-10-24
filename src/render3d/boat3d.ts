// boat3d.ts — 간단 lowpoly 보트(선체 박스 + 삼각 돛). 카메라가 배에 snap 이므로
// 현재 3D PoC 는 1인칭 시점 — 보트 메시는 만들되 기본 비가시(자기 시점에서 안 보임).
// 3인칭 디버그 확인용으로 남겨둔다.
import * as THREE from 'three';

export function buildBoat3D(): THREE.Group {
    var g = new THREE.Group();
    var hullGeo = new THREE.BoxGeometry(3, 1.2, 8);
    var hullMat = new THREE.MeshStandardMaterial({ color: 0x6b4a30, flatShading: true });
    var hull = new THREE.Mesh(hullGeo, hullMat);
    hull.position.y = 0.6;
    g.add(hull);

    var sailGeo = new THREE.ConeGeometry(2.2, 5, 3);
    var sailMat = new THREE.MeshStandardMaterial({ color: 0xe8dcc0, flatShading: true, side: THREE.DoubleSide });
    var sail = new THREE.Mesh(sailGeo, sailMat);
    sail.rotation.z = Math.PI / 2;
    sail.rotation.y = Math.PI / 2;
    sail.position.y = 3.5;
    g.add(sail);

    return g;
}
