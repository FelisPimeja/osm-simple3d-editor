/**
 * Общий бюджет кадра для фоновой работы (сборка тайлов, показ тайлов): у каждой сборки был свой бюджет,
 * и при зуме, когда в кадр входят сразу несколько тайлов, кадр растягивался на их сумму (50–90 мс).
 * Все продолжения одного кадра получают от requestAnimationFrame одну метку времени — по ней и делим.
 */
const FRAME_BUDGET_MS = 8;
let frameAt = -1;
let deadline = 0;

/** Срок фоновой работы в кадре t (метка из requestAnimationFrame): первый вызов в кадре открывает бюджет. */
export function frameDeadline(t: number): number {
  if (t !== frameAt) { frameAt = t; deadline = performance.now() + FRAME_BUDGET_MS; }
  return deadline;
}

/** Дождаться кадра, в котором ещё есть бюджет; возвращает его срок. */
export async function nextFrameSlot(): Promise<number> {
  for (;;) {
    const t = await new Promise<number>(requestAnimationFrame);
    const d = frameDeadline(t);
    if (performance.now() < d) return d;
  }
}
