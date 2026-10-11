import { CLIENT_ID_ENV, apiFetch, server, type OsmServer } from './servers';
import { tr } from '../i18n';

/**
 * OAuth 2.0 Authorization Code + PKCE без бэкенда.
 * Авторизация открывается во всплывающем окне, страница oauth.html возвращает code через BroadcastChannel —
 * так основная страница с несохранёнными правками не перезагружается.
 * Токен хранится в localStorage отдельно для каждого сервера.
 */

/** write_prefs — настройки пользователя в профиле (src/settings.ts). */
const SCOPES = 'read_prefs write_prefs write_api';
/** Без write_prefs: приложение OAuth на сервере зарегистрировано без права «изменять настройки». */
const SCOPES_NO_PREFS = 'read_prefs write_api';
const OAUTH_CHANNEL = 'osm3d-oauth';
const tokenKey = (s: OsmServer) => `osm3d.token.${s.id}`;
/** Права, выданные токену (из ответа /oauth2/token); у токенов, полученных до появления записи, — нет. */
const scopeKey = (s: OsmServer) => `osm3d.scope.${s.id}`;
/** Сервер отказал в write_prefs (invalid_scope) — дальше входим без него. */
const noPrefsKey = (s: OsmServer) => `osm3d.noPrefsScope.${s.id}`;

export interface OsmUser { id: number; name: string }

export function redirectUri(): string {
  return new URL('oauth.html', location.href).href;
}

export function getToken(s: OsmServer = server()): string | undefined {
  try { return localStorage.getItem(tokenKey(s)) ?? undefined; } catch { return undefined; }
}

export function logout(s: OsmServer = server()) {
  try { localStorage.removeItem(tokenKey(s)); localStorage.removeItem(scopeKey(s)); } catch { /* не критично */ }
}

/** Снова просить write_prefs при входе (после того как на сервере разрешили это приложению). */
export function allowPrefsScope(s: OsmServer = server()) {
  try { localStorage.removeItem(noPrefsKey(s)); } catch { /* не критично */ }
}

/** Токен даёт право записывать настройки в профиль (write_prefs). */
export function canWritePrefs(s: OsmServer = server()): boolean {
  try { return !!getToken(s) && (localStorage.getItem(scopeKey(s)) ?? '').split(/\s+/).includes('write_prefs'); } catch { return false; }
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function randomString(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function login(s: OsmServer = server()): Promise<string> {
  if (!s.clientId) {
    throw new Error(tr('Не задан client_id для сервера «{server}» ({env} в .env.local).', { server: s.label, env: CLIENT_ID_ENV[s.id] }));
  }
  const verifier = randomString();
  const state = randomString();
  let noPrefs = false;
  try { noPrefs = !!localStorage.getItem(noPrefsKey(s)); } catch { /* без хранилища */ }
  const scope = noPrefs ? SCOPES_NO_PREFS : SCOPES;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: s.clientId,
    redirect_uri: redirectUri(),
    scope,
    state,
    code_challenge: await challenge(verifier),
    code_challenge_method: 'S256',
  });
  const popup = window.open(`${s.web}/oauth2/authorize?${params}`, 'osm-oauth', 'width=600,height=700');
  if (!popup) throw new Error(tr('Браузер заблокировал окно входа — разрешите всплывающие окна для этого сайта.'));

  // Сайт OSM отдаёт Cross-Origin-Opener-Policy: после перехода на него связь с окном рвётся
  // (window.opener пуст, popup.closed сразу true). Поэтому code приходит через BroadcastChannel —
  // он работает между любыми окнами одного origin, а закрытие окна не отслеживаем.
  const code = await new Promise<string>((resolve, reject) => {
    const channel = new BroadcastChannel(OAUTH_CHANNEL);
    const timer = setTimeout(() => { channel.close(); reject(new Error(tr('Вход не завершён за 5 минут — попробуйте ещё раз.'))); }, 5 * 60_000);
    channel.onmessage = (e: MessageEvent) => {
      if (e.data?.type !== 'osm-oauth' || e.data.state !== state) return; // ответ на другую попытку входа
      clearTimeout(timer);
      channel.close();
      if (e.data.errorCode === 'invalid_scope' && !noPrefs) {
        // Приложению на сервере не разрешено изменять настройки — следующий вход без этого права
        try { localStorage.setItem(noPrefsKey(s), '1'); } catch { /* без хранилища */ }
        reject(new Error(tr('Приложение OAuth на {server} не разрешает изменять настройки пользователя. Нажмите «Войти» ещё раз — вход будет без сохранения настроек в профиле.', { server: s.short })));
      } else if (e.data.error) reject(new Error(`OAuth: ${e.data.error}`));
      else resolve(e.data.code);
    };
  });

  const res = await apiFetch(`${s.web}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      client_id: s.clientId,
      code_verifier: verifier,
    }),
  });
  if (!res.ok) throw new Error(tr('Не удалось получить токен: {status} {text}', { status: res.status, text: await res.text() }));
  const data = (await res.json()) as { access_token: string; scope?: string };
  const token = data.access_token;
  try {
    localStorage.setItem(tokenKey(s), token);
    localStorage.setItem(scopeKey(s), data.scope ?? scope);
  } catch { /* живём без сохранения */ }
  return token;
}

/** Текущий пользователь; undefined — токена нет или он отозван (тогда он удаляется). */
export async function fetchUser(s: OsmServer = server()): Promise<OsmUser | undefined> {
  const token = getToken(s);
  if (!token) return;
  const res = await apiFetch(`${s.api}/user/details.json`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) { logout(s); return; }
  if (!res.ok) throw new Error(`OSM API ${res.status}`);
  const { user } = (await res.json()) as { user: { id: number; display_name: string } };
  return { id: user.id, name: user.display_name };
}
