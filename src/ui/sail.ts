// sail.ts — 돛 3단 세그먼트 UI. source of truth: boat.sail (0 / 0.5 / 1).
// W/S 키 (input.ts) 또는 세그먼트 클릭으로 조정. 매 프레임 active seg 하이라이트.
import { boat } from '../state';
import { uiBlip } from '../audio';

let segs: HTMLButtonElement[] = [];

function pickSail(v: number) {
    if (v === boat.sail) return;
    const rising = v > boat.sail;
    boat.sail = v;
    uiBlip(rising ? 520 : 340);
}

export function initSailUI() {
    const ui = document.getElementById('sail-ui');
    if (!ui) return;
    ui.classList.add('ready');
    segs = Array.from(ui.querySelectorAll('.sail-seg')) as HTMLButtonElement[];
    for (const seg of segs) {
        seg.addEventListener('click', () => {
            const v = parseFloat(seg.dataset.v || '1');
            pickSail(v);
            seg.blur(); // Space/Enter 재발동 방지 (후속 W/S 키와 충돌 방지)
        });
    }
    updateSailUI();
}

// 매 프레임 — boat.sail 값에 맞는 세그먼트를 active 로 표시.
export function updateSailUI() {
    for (const seg of segs) {
        const v = parseFloat(seg.dataset.v || '1');
        seg.classList.toggle('active', v === boat.sail);
    }
}
