// debug-panel.ts — 디버그 패널 내 컨트롤 (Time / Map) 버튼 이벤트.
// 값 갱신은 main.ts 의 UpdateDebug() 에서. 여기선 click 조작만.
import { mmState, MM_STRIDE_MIN, MM_STRIDE_MAX } from '../render/minimap';
import { timeRef } from '../state';
import { TIME_SPEED_MIN, TIME_SPEED_MAX } from '../config';
import { uiBlip } from '../audio';

export function initDebugPanel() {
    // 인라인 컨트롤은 이제 #toggle-ui 안에 있음 (i 버튼 우측). 이벤트 위임 대상 전환.
    const panel = document.getElementById('toggle-ui');
    if (!panel) return;
    // data-act 있는 버튼만 매치 (i 버튼은 data-act 없어서 자동 제외 — toggle.ts 가 처리).
    panel.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        if (!t || t.tagName !== 'BUTTON') return;
        const act = t.dataset.act;
        switch (act) {
            case 'time-down':
                timeRef.TIME_SPEED = Math.max(TIME_SPEED_MIN, timeRef.TIME_SPEED / 2);
                uiBlip(440);
                break;
            case 'time-up':
                timeRef.TIME_SPEED = Math.min(TIME_SPEED_MAX, timeRef.TIME_SPEED * 2);
                uiBlip(660);
                break;
            case 'map-out':
                mmState.stride = Math.min(MM_STRIDE_MAX, mmState.stride * 1.5);
                break;
            case 'map-in':
                mmState.stride = Math.max(MM_STRIDE_MIN, mmState.stride / 1.5);
                break;
        }
        (t as HTMLButtonElement).blur();
    });
}
