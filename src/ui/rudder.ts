// rudder.ts — 러더 UI (슬라이더). source of truth: boat.rudder (-1..+1).
// 마우스/터치 드래그로 값 조정 가능. A/D 키 입력은 input.ts 에서 별도 처리 — UI 는 값을 반영만.
import { boat } from '../state';

let handle: HTMLElement | null = null;
let track: HTMLElement | null = null;
let dragging = false;

function setFromEvent(e: PointerEvent) {
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;  // 0..1
    boat.rudder = Math.max(-1, Math.min(1, (rel - 0.5) * 2));
}

export function initRudderUI() {
    const ui = document.getElementById('rudder-ui');
    if (!ui) return;
    ui.style.display = 'block';
    track = ui.querySelector('.rudder-track') as HTMLElement;
    handle = ui.querySelector('.rudder-handle') as HTMLElement;
    if (!track || !handle) return;

    track.addEventListener('pointerdown', (e) => {
        dragging = true;
        setFromEvent(e);
        try { track!.setPointerCapture(e.pointerId); } catch {}
    });
    track.addEventListener('pointermove', (e) => {
        if (dragging) setFromEvent(e);
    });
    const endDrag = (e: PointerEvent) => {
        dragging = false;
        try { track!.releasePointerCapture(e.pointerId); } catch {}
    };
    track.addEventListener('pointerup', endDrag);
    track.addEventListener('pointercancel', endDrag);
}

// 매 프레임 — boat.rudder 값을 handle 위치에 반영.
// rudder=-1 → left:0%, rudder=0 → 50%, rudder=+1 → 100%. handle 중심 translateX(-50%) 정렬.
export function updateRudderUI() {
    if (!handle) return;
    handle.style.left = (50 + boat.rudder * 50) + '%';
}
