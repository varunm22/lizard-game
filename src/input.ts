/** One frame of player intent, already merged from keyboard, mouse and gamepad. */
export interface InputState {
  /** Steering: x turns (right +), y moves along the lizard's facing (forward +), each -1..1. */
  move: { x: number; y: number };
  run: boolean;
  /** Jump is held this frame. */
  jump: boolean;
  /** Bite was pressed since the last read. */
  bite?: boolean;
  /** Camera orbit since the last read (radians): yaw right, pitch up. */
  look: { yaw: number; pitch: number };
  /** Camera zoom since the last read; positive pulls out. */
  zoom: number;
}

const DEADZONE = 0.2;
const MOUSE_RAD_PER_PX = 0.006;
const STICK_RAD_PER_S = 2.5;

/**
 * Keyboard (WASD or arrows, Shift run, Space jump, F bite, Q/E orbit), mouse (drag to orbit, wheel to zoom)
 * and the first connected gamepad (left stick turns and moves, right stick orbit, A jump, X bite, any
 * shoulder or a full stick push to run).
 */
export class Input {
  private keys = new Set<string>();
  private lookYaw = 0;
  private lookPitch = 0;
  private wheel = 0;
  private dragging = false;
  private bitePressed = false;
  private padBite = false;

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (e.code === 'KeyF' && !e.repeat) this.bitePressed = true;
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    target.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      target.setPointerCapture(e.pointerId);
      window.focus();
    });
    target.addEventListener('pointerup', () => (this.dragging = false));
    target.addEventListener('pointercancel', () => (this.dragging = false));
    target.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.lookYaw += e.movementX * MOUSE_RAD_PER_PX;
      this.lookPitch -= e.movementY * MOUSE_RAD_PER_PX;
    });
    target.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.wheel += Math.sign(e.deltaY);
      },
      { passive: false },
    );
  }

  /** Read and reset this frame's input. `dt` scales the gamepad's camera stick. */
  read(dt: number): InputState {
    const k = (...codes: string[]) => codes.some((c) => this.keys.has(c));
    let x = (k('KeyD', 'ArrowRight') ? 1 : 0) - (k('KeyA', 'ArrowLeft') ? 1 : 0);
    let y = (k('KeyW', 'ArrowUp') ? 1 : 0) - (k('KeyS', 'ArrowDown') ? 1 : 0);
    let run = k('ShiftLeft', 'ShiftRight');
    let jump = k('Space');
    let bite = this.bitePressed;
    let yaw = this.lookYaw + ((k('KeyE') ? 1 : 0) - (k('KeyQ') ? 1 : 0)) * STICK_RAD_PER_S * dt;
    let pitch = this.lookPitch;

    const pad = navigator.getGamepads?.().find((p) => p?.connected);
    if (pad) {
      const [lx, ly, rx, ry] = [0, 1, 2, 3].map((i) => deadzone(pad.axes[i] ?? 0));
      if (lx || ly) {
        x = lx;
        y = -ly;
      }
      yaw += rx * STICK_RAD_PER_S * dt;
      pitch -= ry * STICK_RAD_PER_S * dt;
      const pressed = (i: number) => pad.buttons[i]?.pressed ?? false;
      jump ||= pressed(0);
      bite ||= pressed(2) && !this.padBite;
      this.padBite = pressed(2);
      run ||= pressed(4) || pressed(5) || pressed(6) || pressed(7) || Math.hypot(lx, ly) > 0.95;
    }

    const zoom = this.wheel;
    this.lookYaw = this.lookPitch = this.wheel = 0;
    this.bitePressed = false;
    return { move: { x, y }, run, jump, bite, look: { yaw, pitch }, zoom };
  }
}

function deadzone(v: number): number {
  const a = Math.abs(v);
  return a < DEADZONE ? 0 : (Math.sign(v) * (a - DEADZONE)) / (1 - DEADZONE);
}
