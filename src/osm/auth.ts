import { server, type OsmServer } from './servers';

/**
 * OAuth 2.0 Authorization Code + PKCE без бэкенда.
 * Авторизация открывается во всплывающем окне, страница oauth.html возвращает code через BroadcastChannel —
 * так основная страница с несохранёнными правками не перезагружается.
 * Токен хранится в localStorage отдельно для каждого сервера.
 */

const SCOPES = 'read_prefs write_api';
const OAUTH_CHANNEL = 'osm3d-oauth';
const tokenKey = (s: OsmServer) => `osm3d.token.${s.id}`;

export interface OsmUser { id: number; name: string }

export function redirectUri(): string {
  return new URL('oauth.html', location.href).href;
}

export function getToken(s: OsmServer = server()): string | undefined {
  try { return localStorage.getItem(tokenKey(s)) ?? undefined; } catch { return undefined; }
}

export function logout(s: OsmServer = server()) {
  try { localStorage.removeItem(tokenKey(s)); } catch { /* не критично */ }
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
    throw new Error(`Не задан client_id для сервера «${s.label}» (VITE_OSM${s.id === 'dev' ? '_DEV' : ''}_CLIENT_ID в .env.local).`);
  }
  const verifier = randomString();
  const state = randomString();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: s.clientId,
    redirect_uri: redirectUri(),
    scope: SCOPES,
    state,
    code_challenge: await challenge(verifier),
    code_challenge_method: 'S256',
  });
  const popup = window.open(`${s.web}/oauth2/authorize?${params}`, 'osm-oauth', 'width=600,height=700');
  if (!popup) throw new Error('Браузер заблокировал окно входа — разрешите всплывающие окна для этого сайта.');

  // Сайт OSM отдаёт Cross-Origin-Opener-Policy: после перехода на него связь с окном рвётся
  // (window.opener пуст, popup.closed сразу true). Поэтому code приходит через BroadcastChannel —
  // он работает между любыми окнами одного origin, а закрытие окна не отслеживаем.
  const code = await new Promise<string>((resolve, reject) => {
    const channel = new BroadcastChannel(OAUTH_CHANNEL);
    const timer = setTimeout(() => { channel.close(); reject(new Error('Вход не завершён за 5 минут — попробуйте ещё раз.')); }, 5 * 60_000);
    channel.onmessage = (e: MessageEvent) => {
      if (e.data?.type !== 'osm-oauth' || e.data.state !== state) return; // ответ на другую попытку входа
      clearTimeout(timer);
      channel.close();
      if (e.data.error) reject(new Error(`OAuth: ${e.data.error}`));
      else resolve(e.data.code);
    };
  });

  const res = await fetch(`${s.web}/oauth2/token`, {
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
  if (!res.ok) throw new Error(`Не удалось получить токен: ${res.status} ${await res.text()}`);
  const token = ((await res.json()) as { access_token: string }).access_token;
  try { localStorage.setItem(tokenKey(s), token); } catch { /* живём без сохранения */ }
  return token;
}

/** Текущий пользователь; undefined — токена нет или он отозван (тогда он удаляется). */
export async function fetchUser(s: OsmServer = server()): Promise<OsmUser | undefined> {
  const token = getToken(s);
  if (!token) return;
  const res = await fetch(`${s.api}/user/details.json`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401 || res.status === 403) { logout(s); return; }
  if (!res.ok) throw new Error(`OSM API ${res.status}`);
  const { user } = (await res.json()) as { user: { id: number; display_name: string } };
  return { id: user.id, name: user.display_name };
}
