/* Radiolingo — service worker веб-версии (офлайн-режим). Регистрирует src/lib/pwa.ts; в APK его нет.
 *
 * Версия — параметр регистрации ?v=<коммит>-<время сборки>: у каждой сборки свой кеш. При установке
 * новая версия кладёт в кеш оболочку (index.html и всё, на что она ссылается), сразу берёт управление
 * вкладками и удаляет кеши прежних версий.
 *  - index.html — сначала сеть (ждём недолго), без сети — сохранённая копия. Если свежая оболочка
 *    оказалась другой, вкладкам уходит «rl-update-ready» → подсказка «Доступна новая версия».
 *  - Остальные свои файлы — из кеша с обновлением в фоне (stale-while-revalidate); файлы с хешем
 *    в имени (assets/имя-хеш.js) не меняются никогда — их не перепроверяем.
 *  - Страница присылает «rl-cache» со списком файлов, скачанных до установки, — докладываем их в кеш.
 * Файл не проходит через сборку: синтаксис — не новее Chrome 80 и Safari 14. */
'use strict';

const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev';
const PREFIX = 'radiolingo-';
const CACHE = PREFIX + VERSION;
const SCOPE = self.registration.scope;
const SCOPE_PATH = new URL(SCOPE).pathname;
/** index.html хранится под адресом папки приложения. */
const SHELL = SCOPE;
/** Значки из манифеста: в index.html их нет, а для установки на телефон они нужны и без сети. */
const EXTRA = ['icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-192.png', 'icons/icon-maskable-512.png'];
const NETWORK_TIMEOUT_MS = 4000;
const MATCH = { ignoreVary: true };

self.addEventListener('install', (event) => {
  event.waitUntil(install());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(activate());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (!isOwn(url)) return;
  if (isShell(url)) {
    event.respondWith(shell(event));
    return;
  }
  // Переход на другой адрес в папке (например, значок в новой вкладке) и запросы с Range — без нас
  if (request.mode === 'navigate' || request.headers.has('range')) return;
  event.respondWith(asset(event, request, url));
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'rl-cache' && Array.isArray(data.urls)) event.waitUntil(cacheFiles(data.urls));
});

async function install() {
  const cache = await caches.open(CACHE);
  await storeShell(cache, await fetchFresh(SHELL), undefined);
  await Promise.all(EXTRA.map((path) => cacheIfMissing(cache, new URL(path, SCOPE).href).catch(() => undefined)));
  await self.skipWaiting();
}

async function activate() {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.indexOf(PREFIX) === 0 && name !== CACHE).map((name) => caches.delete(name)));
  await self.clients.claim();
}

// ---------- оболочка (index.html): сначала сеть ----------

async function shell(event) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(SHELL, MATCH);
  const network = fetchFresh(SHELL);
  if (!cached) {
    const response = await network;
    event.waitUntil(updateShell(cache, response.clone(), Promise.resolve(undefined)).catch(() => undefined));
    return response;
  }
  const cachedText = cached.clone().text();
  const fresh = await Promise.race([network.catch(() => null), delay(NETWORK_TIMEOUT_MS)]);
  if (fresh) {
    event.waitUntil(updateShell(cache, fresh.clone(), cachedText).catch(() => undefined));
    return fresh;
  }
  // Сеть не ответила вовремя: отдаём сохранённую копию, свежую сохраним, когда придёт
  event.waitUntil(network.then((response) => updateShell(cache, response, cachedText)).catch(() => undefined));
  return cached;
}

/** Сохранить свежую оболочку; если она изменилась — сообщить вкладкам (у старых другой главный скрипт). */
async function updateShell(cache, response, previousText) {
  const html = await storeShell(cache, response, await previousText);
  if (html === null) return;
  const windows = await self.clients.matchAll({ type: 'window' });
  const entry = entryOf(html);
  windows.forEach((client) => client.postMessage({ type: 'rl-update-ready', entry: entry }));
}

/**
 * Положить оболочку в кеш вместе со всеми файлами, на которые она ссылается: сначала файлы, потом она сама —
 * без сети нельзя остаться с оболочкой без её скриптов. Возвращает html, если оболочка изменилась, иначе null.
 */
async function storeShell(cache, response, previousText) {
  const html = await response.clone().text();
  if (html === previousText) return null;
  await Promise.all(referencedFiles(html).map((url) => cacheIfMissing(cache, url)));
  await cache.put(SHELL, response);
  return html;
}

function referencedFiles(html) {
  const found = new Set();
  const attr = /\s(?:src|href)="([^"]+)"/g;
  let match = attr.exec(html);
  while (match) {
    const value = match[1];
    // внешние адреса, data:, якоря — пропускаем
    if (!/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(value)) {
      const url = new URL(value, SCOPE);
      if (isOwn(url) && !isShell(url)) found.add(url.href);
    }
    match = attr.exec(html);
  }
  return Array.from(found);
}

/** Главный скрипт оболочки: по нему вкладка понимает, та же это сборка или новая. */
function entryOf(html) {
  const tags = html.match(/<script\b[^>]*>/g) || [];
  for (const tag of tags) {
    const src = /\bsrc="([^"]+)"/.exec(tag);
    if (src && /\btype="module"/.test(tag)) return new URL(src[1], SCOPE).href;
  }
  return '';
}

// ---------- остальные файлы: из кеша, обновление в фоне ----------

async function asset(event, request, url) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request, MATCH);
  if (cached && isImmutable(url)) return cached;
  const network = fetch(request).then((response) => {
    if (response.ok && response.type === 'basic') {
      // копию снимаем сразу, пока ответ не начала читать страница
      const copy = response.clone();
      event.waitUntil(cache.put(request, copy).catch(() => undefined));
    }
    return response;
  });
  if (!cached) return network;
  event.waitUntil(network.catch(() => undefined));
  return cached;
}

async function cacheFiles(urls) {
  const cache = await caches.open(CACHE);
  const own = [];
  urls.slice(0, 300).forEach((value) => {
    if (typeof value !== 'string') return;
    try {
      const url = new URL(value);
      if (isOwn(url) && !isShell(url) && !/\/sw\.js$/.test(url.pathname)) own.push(url.href);
    } catch (error) {
      // не адрес — пропускаем
    }
  });
  await Promise.all(own.map((href) => cacheIfMissing(cache, href).catch(() => undefined)));
}

async function cacheIfMissing(cache, href) {
  if (await cache.match(href, MATCH)) return;
  const immutable = isImmutable(new URL(href));
  const response = await fetch(href, { cache: immutable ? 'default' : 'no-cache', credentials: 'same-origin' });
  if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + href);
  await cache.put(href, response);
}

// ---------- вспомогательное ----------

async function fetchFresh(href) {
  // no-cache: браузер переспросит сервер (GitHub Pages разрешает хранить ответ 10 минут)
  const response = await fetch(href, { cache: 'no-cache', credentials: 'same-origin' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response;
}

function isOwn(url) {
  return url.origin === self.location.origin && url.pathname.indexOf(SCOPE_PATH) === 0;
}

function isShell(url) {
  return url.pathname === SCOPE_PATH || url.pathname === SCOPE_PATH + 'index.html';
}

/** Сборка Vite кладёт в assets/ файлы вида «имя-хеш8.расширение»: их содержимое не меняется. */
function isImmutable(url) {
  return url.pathname.indexOf(SCOPE_PATH + 'assets/') === 0 && /-[\w-]{8}\.[a-z0-9]+$/i.test(url.pathname);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}
