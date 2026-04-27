// start-menu.ts — 로딩 직후 노출되는 시작 메뉴.
// "항해 시작" 버튼 또는 화면 어디든 클릭/탭으로 게임 진입.
// 이 시점이 첫 사용자 제스처이므로 audio resume 도 여기서 트리거 (iOS Safari 대응).
import { resumeAudio } from '../audio';

export function showStartMenu(): Promise<void> {
    return new Promise((resolve) => {
        const menu = document.getElementById('start-menu')!;
        menu.style.display = 'flex';

        let started = false;
        const start = () => {
            if (started) return;
            started = true;
            menu.removeEventListener('pointerdown', onPointer);
            menu.style.display = 'none';
            resumeAudio();
            resolve();
        };

        // 메뉴 배경 어디든 탭/클릭하면 시작 — "항해 시작" 버튼은 자연스럽게 같은 핸들러로 처리.
        const onPointer = () => start();
        menu.addEventListener('pointerdown', onPointer);
    });
}
