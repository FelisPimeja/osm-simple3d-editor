/**
 * Автоматические отчёты об ошибках отправки: сервер отклонил пакет (или он не прошёл нашу проверку перед
 * отправкой) — заводим issue на GitHub с ответом сервера и osmChange. С ником участника OSM (если вошёл) — чтобы
 * сообщить ему об исправлении; токенов в отчёте нет.
 *
 * Токен — fine-grained PAT только с правом Issues: write на один репозиторий (VITE_REPORT_TOKEN, секрет Actions).
 * Он попадает в собранный JS: злоупотребят — отзываем и переходим на прокси (Cloudflare Worker).
 * Пользователь может отключить отчёты в личных настройках.
 */
import { lang } from '../i18n';

const TOKEN = import.meta.env.VITE_REPORT_TOKEN as string | undefined;
const REPO = (import.meta.env.VITE_REPORT_REPO as string | undefined) || 'FelisPimeja/osm-simple3d-editor';
const BUILD = (import.meta.env.VITE_GIT_SHA as string | undefined)?.slice(0, 7) || 'dev';
const OFF_KEY = 'osm3d.error-reports';
const SENT_KEY = 'osm3d.error-reports.sent';
/** Не больше стольких отчётов из браузера за сутки. */
const PER_DAY = 3;
/** Предел тела issue у GitHub — 65536 символов; длиннее osmChange уходит сжатым (gzip + base64). */
const BODY_MAX = 60000;

export const reportsAvailable = () => !!TOKEN;

export function reportsEnabled(): boolean {
  try { return localStorage.getItem(OFF_KEY) !== 'off'; } catch { return true; }
}
export function setReportsEnabled(on: boolean) {
  try { if (on) localStorage.removeItem(OFF_KEY); else localStorage.setItem(OFF_KEY, 'off'); } catch { /* до перезагрузки */ }
}

export interface UploadFailure {
  /** Что не так: ответ сервера («OSM API 409: …») или список проблем нашей проверки. */
  error: string;
  status?: number;
  osmChange: string;
  /** Адрес API (какой сервер). */
  api: string;
  changeset?: number;
  /** Ник участника OSM и ссылка на профиль (если вошёл). */
  user?: { name: string; url?: string };
}

async function hash(s: string): Promise<string> {
  const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 8).map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function gzipBase64(s: string): Promise<string> {
  const stream = new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

type Sent = { h: string; at: number }[];
function sentLog(): Sent {
  try { return (JSON.parse(localStorage.getItem(SENT_KEY) ?? '[]') as Sent).filter((s) => Date.now() - s.at < 864e5); } catch { return []; }
}

/** Отчёты, которые сейчас отправляются: повторный вызов до ответа GitHub не должен завести второй issue. */
const inFlight = new Set<string>();

/** Отправить отчёт (если включены и такой ещё не уходил). Ошибки отправки самого отчёта — только в консоль. */
export async function reportUploadFailure(f: UploadFailure): Promise<'sent' | 'skipped'> {
  if (!TOKEN || !reportsEnabled()) return 'skipped';
  let h = '', mine = false;
  try {
    // Одинаковые ошибки (тот же ответ сервера на тот же пакет без номера changeset) — один раз
    h = await hash(f.error.replace(/\d{6,}/g, '#') + '\n' + f.osmChange.replace(/changeset="\d+"/g, ''));
    const log = sentLog();
    if (inFlight.has(h) || log.some((s) => s.h === h) || log.length + inFlight.size >= PER_DAY) return 'skipped';
    inFlight.add(h); mine = true;
    const head = [
      `**Error:** \`${f.error.replace(/`/g, "'").slice(0, 2000)}\``,
      '',
      `- Build: ${BUILD}`,
      `- API: ${f.api}`,
      `- User: ${f.user ? (f.user.url ? `[${f.user.name.replace(/[[\]`]/g, '')}](${f.user.url})` : f.user.name.replace(/`/g, '')) : 'not logged in'}`,
      f.changeset ? `- Changeset (left empty): ${f.changeset}` : '',
      `- UI language: ${lang}`,
      `- Browser: ${navigator.userAgent}`,
      `- Report id: ${h}`,
      '',
    ].filter((l, i, a) => l || a[i - 1]).join('\n');
    let dump = `<details><summary>osmChange (${f.osmChange.length} chars)</summary>\n\n\`\`\`xml\n${f.osmChange}\n\`\`\`\n</details>`;
    if (head.length + dump.length > BODY_MAX) {
      const z = await gzipBase64(f.osmChange);
      dump = head.length + z.length + 300 < BODY_MAX
        ? `<details><summary>osmChange, gzip + base64 (${f.osmChange.length} chars before compression)</summary>\n\n\`\`\`\n${z}\n\`\`\`\n</details>\n\nDecode: \`base64 -d dump.txt | gunzip\``
        : `osmChange too large to attach (${f.osmChange.length} chars, ${z.length} compressed).`;
    }
    const title = `Upload failed: ${f.error.replace(/\s+/g, ' ').slice(0, 120)}`;
    const res = await fetch(`https://api.github.com/repos/${REPO}/issues`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body: `${head}\n${dump}`, labels: ['upload-error'] }),
    });
    if (!res.ok) { console.warn('[report]', res.status, await res.text()); return 'skipped'; }
    try { localStorage.setItem(SENT_KEY, JSON.stringify([...sentLog(), { h, at: Date.now() }])); } catch { /* без хранилища */ }
    return 'sent';
  } catch (err) {
    console.warn('[report]', err);
    return 'skipped';
  } finally {
    if (mine) inFlight.delete(h);
  }
}
