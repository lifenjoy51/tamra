// input.ts — 키보드 + 포인터 핸들러.
// 러더(A/D) / 돛(W/S) / 노(R) / 스텝 조절([/]/,/.) / 미니맵 축척(-/=) / 시간속도(T/Y) /
// 하늘보기(K) / 음소거(M). hold 시 브라우저 auto-repeat 로 연속 효과.
// A/D 는 즉시 각도를 바꾸지 않고 boat.rudder 만 조정 — 실제 회전은 UpdateCamera 에서
// rudder × waterMS × RUDDER_POWER × dt 로 서서히 적용.
import { TIME_SPEED_MIN, TIME_SPEED_MAX } from './config';
import { boat, timeRef, uiFlags, RUDDER_STEP } from './state';
import { mmState, MM_STRIDE_MIN, MM_STRIDE_MAX } from './render/minimap';
import { audio, resumeAudio, setMuted, uiBlip } from './audio';

// 회전/이동 스텝 (UI 토글로 변경, UpdateDebug 에서 읽어 Step 라인에 표시).
export const inputState = {
    rotStep: Math.PI / 180,  // 초기 1°, [ / ] 로 절반/두배
    moveStep: 1,             // 초기 1 world unit, , / . 로 절반/두배
};

const ROT_STEP_MIN = Math.PI / 1440, ROT_STEP_MAX = Math.PI / 4;   // 0.125° ~ 45°
const MOVE_STEP_MIN = 0.0625, MOVE_STEP_MAX = 64;                   // 1/16 ~ 64 unit

export function initInput() {
    document.onkeydown = function(e) {
        resumeAudio();
        switch (e.keyCode) {
            case 87: case 38: // W, Up: 돛 한 단계 펼침 (DOWN→HALF→FULL)
                if (boat.sail < 1) {
                    boat.sail = Math.min(1, boat.sail + 0.5);
                    uiBlip(520);
                }
                break;
            case 83: case 40: // S, Down: 돛 한 단계 접음 (FULL→HALF→DOWN)
                if (boat.sail > 0) {
                    boat.sail = Math.max(0, boat.sail - 0.5);
                    uiBlip(340);
                }
                break;
            case 82: // R: 노 젓기 토글
                boat.row = boat.row ? 0 : 1;
                uiBlip(boat.row ? 480 : 300);
                break;
            case 65: case 37: // A, Left: 키를 왼쪽으로 (음수). 회전은 점진적.
                boat.rudder = Math.max(-1, boat.rudder - RUDDER_STEP);
                break;
            case 68: case 39: // D, Right: 키를 오른쪽으로 (양수).
                boat.rudder = Math.min( 1, boat.rudder + RUDDER_STEP);
                break;
            case 187: // '=' / '+' : 미니맵 확대
                mmState.stride = Math.max(MM_STRIDE_MIN, mmState.stride / 1.5);
                break;
            case 189: // '-' : 미니맵 축소
                mmState.stride = Math.min(MM_STRIDE_MAX, mmState.stride * 1.5);
                break;
            case 188: // ',' : 이동 속도 ÷2
                inputState.moveStep = Math.max(MOVE_STEP_MIN, inputState.moveStep / 2);
                break;
            case 190: // '.' : 이동 속도 ×2
                inputState.moveStep = Math.min(MOVE_STEP_MAX, inputState.moveStep * 2);
                break;
            case 219: // '[' : 회전 속도 ÷2
                inputState.rotStep = Math.max(ROT_STEP_MIN, inputState.rotStep / 2);
                break;
            case 221: // ']' : 회전 속도 ×2
                inputState.rotStep = Math.min(ROT_STEP_MAX, inputState.rotStep * 2);
                break;
            case 84: // 'T' : 시간 감속 ÷2
                timeRef.TIME_SPEED = Math.max(TIME_SPEED_MIN, timeRef.TIME_SPEED / 2);
                uiBlip(440);
                break;
            case 89: // 'Y' : 시간 가속 ×2
                timeRef.TIME_SPEED = Math.min(TIME_SPEED_MAX, timeRef.TIME_SPEED * 2);
                uiBlip(660);
                break;
            case 75: // 'K' : 별자리 전체 뷰 토글
                uiFlags.skyMapOn = !uiFlags.skyMapOn;
                break;
            case 77: // 'M' : 음소거 토글
                setMuted(!audio.muted);
                break;
        }
        e.preventDefault();
        return false;
    };

    document.onkeyup = function() {
        return false;
    };
    // 첫 포인터 제스처에서도 AudioContext resume (iOS Safari 대응)
    document.addEventListener('pointerdown', resumeAudio, { once: false });
}
