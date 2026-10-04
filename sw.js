/* Notifications only: private pages, API responses and files are never cached. */
const SETTINGS = 'thuis-push-settings-v1';
const SETTINGS_URL = new URL('/__notification-settings', self.location.origin).href;
const TAG = 'thuis-chat';
let work = Promise.resolve();
function enqueue(action) {
  const next = work.then(action);
  work = next.catch(() => {});
  return next;
}
async function settings() {
  const entry = await (await caches.open(SETTINGS)).match(SETTINGS_URL);
  return entry ? entry.json() : {};
}
async function badge(count) {
  try {
    if (count) await self.navigator.setAppBadge?.(count);
    else await self.navigator.clearAppBadge?.();
  } catch { /* Android derives the launcher dot from the notification itself. */ }
}
async function clearNotifications(all = false) {
  for (const notification of await self.registration.getNotifications(all ? {} : {tag: TAG})) notification.close();
  await badge(0);
}
async function taskNotification(data, context) {
  if (!/^[a-f0-9]{32}$/.test(data.task_id || '') || !/^[a-f0-9]{32}$/.test(data.reminder_token || '')
      || !Number.isFinite(data.expires_at) || data.expires_at * 1000 <= Date.now()) return;
  let preview = typeof data.preview === 'string' ? data.preview : '';
  try {
    const response = await fetch(`/api/tasks/${data.task_id}/reminder?live=${Date.now()}`, {
      credentials:'same-origin', cache:'no-store', signal:AbortSignal.timeout(5000)
    });
    if (response.status === 401) {await clearNotifications(true); return;}
    if (response.ok) {
      const latest = await response.json();
      if (latest.username !== context.username) {await clearNotifications(true); return;}
      if (!latest.available || latest.reminder_token !== data.reminder_token) return;
      preview = latest.title;
    } else return;
  } catch { /* The encrypted reminder remains usable until the Dutch day ends. */ }
  await self.registration.showNotification('Thuis · Herinnering', {
    body:Array.from(String(preview).replace(/\s+/g,' ').trim()).slice(0,240).join('') || 'Er staat een taak voor je klaar.',
    icon:'/assets/icon-192.png', badge:'/assets/notification-badge.png',
    tag:`thuis-task-${data.task_id}`, renotify:true, silent:false,
    data:{kind:'task', url:'/#taken'}, lang:'nl', actions:[{action:'open',title:'Open taken'}]
  });
}
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('message', event => {
  if (event.data?.type !== 'thuis-push-state') return;
  event.waitUntil(enqueue(async () => {
    const client = event.source?.id && await self.clients.get(event.source.id);
    if (!client || new URL(client.url).origin !== self.location.origin) return;
    const next = {
      subscriptionId: String(event.data.subscriptionId || ''),
      username: String(event.data.username || '')
    };
    const previous = await settings();
    if (next.subscriptionId !== previous.subscriptionId || next.username !== previous.username) await clearNotifications(true);
    await (await caches.open(SETTINGS)).put(SETTINGS_URL, new Response(JSON.stringify(next)));
    const count = Math.max(0, Number(event.data.unread) || 0);
    const knownCount = typeof event.data.unread === 'number';
    if (!next.subscriptionId) await clearNotifications(true);
    else if (knownCount && !count) await clearNotifications();
    else if (knownCount) await badge(count);
  }));
});
self.addEventListener('push', event => {
  event.waitUntil(enqueue(async () => {
    const context = await settings();
    let data;
    try { data = event.data?.json(); } catch { return; }
    if (!context.subscriptionId || data?.subscription_id !== context.subscriptionId) return;
    if (data.kind === 'task') {await taskNotification(data, context); return;}
    let count = Math.max(0, Number(data.unread) || 0);
    try {
      const response = await fetch('/api/chat/unread', {credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(5000)});
      if (response.status === 401) { await clearNotifications(true); return; }
      if (response.ok) {
        const latest = await response.json();
        if (latest.username !== context.username) { await clearNotifications(true); return; }
        count = Math.max(0, Number(latest.unread) || 0);
      }
    } catch { /* The encrypted push includes a short preview for poor connectivity. */ }
    if (!count) { await clearNotifications(); return; }
    const sender = typeof data.sender === 'string' && data.sender.length <= 80 && data.sender !== context.username ? data.sender : '';
    const preview = typeof data.preview === 'string' ? Array.from(data.preview.replace(/\s+/g, ' ').trim()).slice(0, 160).join('') : '';
    await self.registration.showNotification(sender ? `${sender} · Thuis` : 'Thuis · Chat', {
      body: (sender && preview) || (count === 1 ? 'Je hebt een nieuw chatbericht.' : `Je hebt ${count} ongelezen chatberichten.`),
      icon: '/assets/icon-192.png', badge: '/assets/notification-badge.png',
      tag: TAG, renotify: true, silent: false, data: {url: '/#chat'},
      lang: 'nl', actions: [{action: 'open', title: 'Open chat'}]
    });
    await badge(count);
    for (const client of await self.clients.matchAll({type: 'window', includeUncontrolled: true})) {
      client.postMessage({type: 'thuis-chat-updated'});
    }
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const isTask = event.notification.data?.kind === 'task';
    const target = new URL(isTask ? '/#taken' : '/#chat', self.location.origin).href;
    const windows = await self.clients.matchAll({type: 'window', includeUncontrolled: true});
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      // Ask an open page to navigate so its existing unsaved-page guard is respected.
      client.postMessage({type: isTask ? 'thuis-open-tasks' : 'thuis-open-chat'});
      await client.focus();
      return;
    }
    await self.clients.openWindow(target);
  })());
});
