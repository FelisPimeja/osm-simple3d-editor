/**
 * Экранная клавиатура поля на таче (атрибут inputmode). Задаётся у описания поля (keyboard); без него — по типу поля.
 * numeric — только цифры (номера, этажи без минуса); decimal — цифры с точкой/запятой (метры, размеры);
 * text — обычная (где бывают буквы, минус, дефис, «;»: этаж -1, направление SE, даты, диапазоны).
 * В цифровых раскладках iOS нет ни минуса, ни дефиса — поля с ними оставляем text.
 */
export type Keyboard = 'numeric' | 'decimal' | 'text';

export function inputMode(k: Keyboard | undefined): string {
  return k && k !== 'text' ? `inputmode="${k}"` : '';
}
