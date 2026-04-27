// toggle.ts — 우상단 + 우하단 아이콘 버튼.
//   ★: 하늘보기 (uiFlags.skyMapOn) — K 키와 동기화.
//   音: 음소거 토글 (audio.muted) — M 키와 동기화. localStorage 영속은 setMuted 가 처리.
//   i: 디버그 패널 show/hide — localStorage 에 상태 저장(새로고침 후 복원).
import { uiFlags } from '../state';
import { audio, setMuted } from '../audio';

const LS_KEY_DEBUG = 'tamra_debug_visible';

let btnSky: HTMLButtonElement | null = null;
let btnMute: HTMLButtonElement | null = null;
let btnDebug: HTMLButtonElement | null = null;
let debugEl: HTMLElement | null = null;

function applyDebug() {
    if (debugEl) debugEl.style.display = uiFlags.debugVisible ? 'block' : 'none';
    if (btnDebug) btnDebug.classList.toggle('active', uiFlags.debugVisible);
    // 디버그 열림일 때만 toggle-ui 에 debug-on 클래스 → Time/Map 인라인 컨트롤 노출
    const togglePanel = document.getElementById('toggle-ui');
    if (togglePanel) togglePanel.classList.toggle('debug-on', uiFlags.debugVisible);
}

export function initToggleUI() {
    // ★ (하늘보기) 와 i (디버그) 는 별도 컨테이너 — 각각 ready 클래스 부여.
    document.getElementById('toggle-ui')?.classList.add('ready');
    document.getElementById('sky-ui')?.classList.add('ready');
    btnSky = document.getElementById('btn-sky') as HTMLButtonElement | null;
    btnMute = document.getElementById('btn-mute') as HTMLButtonElement | null;
    btnDebug = document.getElementById('btn-debug') as HTMLButtonElement | null;
    debugEl = document.getElementById('debug');

    // 디버그 패널 이전 상태 복원 — 저장된 값 없으면 기본 visible.
    const saved = localStorage.getItem(LS_KEY_DEBUG);
    if (saved !== null) uiFlags.debugVisible = saved === '1';
    applyDebug();

    if (btnSky) {
        btnSky.addEventListener('click', () => {
            uiFlags.skyMapOn = !uiFlags.skyMapOn;
            btnSky!.blur(); // 후속 Space/Enter 가 버튼 재발동하지 않도록 포커스 해제
        });
    }
    if (btnMute) {
        btnMute.addEventListener('click', () => {
            setMuted(!audio.muted);
            btnMute!.blur();
        });
    }
    if (btnDebug) {
        btnDebug.addEventListener('click', () => {
            uiFlags.debugVisible = !uiFlags.debugVisible;
            localStorage.setItem(LS_KEY_DEBUG, uiFlags.debugVisible ? '1' : '0');
            applyDebug();
            btnDebug!.blur();
        });
    }
}

// 매 프레임 — K/M 키로도 상태가 변할 수 있으므로 버튼 .active 동기화.
// 디버그 active 는 버튼 자체 클릭에서만 변하므로 applyDebug() 에서 갱신 → 여기선 불필요.
export function updateToggleUI() {
    if (btnSky) btnSky.classList.toggle('active', uiFlags.skyMapOn);
    if (btnMute) {
        btnMute.classList.toggle('active', audio.muted);
        btnMute.title = audio.muted ? '음소거 해제' : '음소거';
    }
}
