(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  let members = ['Ouder 1', 'Ouder 2'];
  let settings = {};
  const state = { user: '', pageId: '', pages: [], agenda: [], pageDirty: false, pageRequest: 0, expanded: new Set() };
  const push = { registration: null, config: null, subscriptionId: '', unread: 0, generation: 0, enabled: false, loading: false };
  const profileSettings = { file: null, previewUrl: '', saving: false, generation: 0 };
  const profileVersions = {};
  const tasks = {items:[], loaded:false, signature:"", generation:0, request:0, pending:new Set(), cancelDrag:null, editor:null, saving:false};
  const agendaState = {loading:false, generation:0, lastAttempt:0, lastSuccess:0, day:'', renderedDay:'', detail:'', error:'', clockOffset:0, timer:null};
  const agendaTimeZone = 'Europe/Amsterdam';
  const agendaDayFormat = new Intl.DateTimeFormat('sv-SE', {timeZone:agendaTimeZone, year:'numeric', month:'2-digit', day:'2-digit'});
  const agendaLabelFormat = new Intl.DateTimeFormat('nl-NL', {timeZone:agendaTimeZone, weekday:'long', day:'numeric', month:'long'});
  const agendaTimeFormat = new Intl.DateTimeFormat('nl-NL', {timeZone:agendaTimeZone, hour:'2-digit', minute:'2-digit'});
  const agendaNow = () => new Date(Date.now() + agendaState.clockOffset);
  const agendaDay = (date = agendaNow()) => agendaDayFormat.format(date);
  const toast = (message) => {
    const node = $('[data-toast]');
    node.textContent = message;
    node.classList.add('is-visible');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('is-visible'), 2600);
  };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const initials = (name) => (name || 'V').trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join('').toUpperCase();
  function renderAvatar(node, username) {
    const version = profileVersions[username] || 'current';
    if (node.dataset.avatarUser === username && node.dataset.avatarVersion === version && node.firstChild) return;
    node.dataset.avatarUser = username;
    node.dataset.avatarVersion = version;
    node.replaceChildren();
    const profile = `member${members.indexOf(username) + 1}`;
    if (members.includes(username)) {
      const img = document.createElement('img'); img.src = `/api/profile/${profile}/avatar?v=${encodeURIComponent(version)}`; img.alt = username;
      img.addEventListener('error', () => { if (img.parentNode === node) { node.textContent = initials(username); delete node.dataset.avatarVersion; } }, {once:true});
      node.append(img);
    } else node.textContent = initials(username);
  }
  function applyProfileVersions(versions = {}) {
    for (const username of members) {
      if (typeof versions[username] !== 'string' || profileVersions[username] === versions[username]) continue;
      profileVersions[username] = versions[username];
      $$('[data-avatar-user]').forEach(node => {
        if (node.dataset.avatarUser === username && !(node.matches('[data-profile-preview]') && profileSettings.previewUrl)) renderAvatar(node, username);
      });
    }
  }
  const prettyDate = (date) => new Intl.DateTimeFormat('nl-NL', { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  const shortDate = (date) => new Intl.DateTimeFormat('nl-NL', { weekday: 'short' }).format(date).replace('.', '');

  async function api(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...options, signal: controller.signal, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
      const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null;
      if (response.status === 401 && url !== '/api/login' && url !== '/api/me') {
        showLogin();
        throw new Error('Je sessie is verlopen. Log opnieuw in.');
      }
      if (!response.ok || !data) { const error = new Error(data?.error || 'De verbinding met thuis werkt even niet. Probeer het opnieuw.'); error.status = response.status; throw error; }
      return data;
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('De server is even niet bereikbaar. Probeer het opnieuw.');
      throw error;
    } finally { clearTimeout(timeout); }
  }

  async function busy(button, action, label = 'Even wachten…') {
    if (button.disabled) return;
    const original = button.innerHTML;
    button.disabled = true;
    button.textContent = label;
    try { return await action(); }
    finally { button.disabled = false; button.innerHTML = original; }
  }

  function showLogin() {
    push.generation++; push.enabled = false; push.subscriptionId = '';
    profileSettings.saving = false;
    resetProfileDraft();
    $('[data-settings-dialog]').close();
    syncPushState(0);
    $('[data-boot]').hidden = true;
    state.user = '';
    resetAgenda();
    resetTasks();
    chooseAssignee(null);
    $('[data-owner-dialog]').close();
    document.body.classList.remove('chat-screen');
    closeMobileMenu();
    resetChat(); resetCloud();
    $('[data-app]').hidden = true;
    $('#login').hidden = false;
    $('[name="username"]', $('[data-login]'))?.focus();
  }

  function applySettings(configuration) {
    settings = configuration;
    const previous = members;
    members = configuration.members || members;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      let value = walker.currentNode.nodeValue;
      previous.forEach((name, i) => { value = value.split(name).join(members[i]); });
      walker.currentNode.nodeValue = value;
    }
    $$('[data-assign-person]').forEach((node, i) => { node.title = `Sleep ${members[i % 2]} naar een taak, of klik en kies een taak`; });
    for (const attribute of ['data-owner-choice', 'data-assign-person', 'value']) {
      $$(`[${attribute}]`).forEach(node => {
        const i = previous.indexOf(node.getAttribute(attribute));
        if (i >= 0) node.setAttribute(attribute, members[i]);
      });
    }
    $$('[data-nextcloud-link]').forEach(node => { node.hidden = !settings.nextcloud_url; if (settings.nextcloud_url) node.href = settings.nextcloud_url; });
    for (const [key, selector] of [['photo_links', '[data-photo-links]'], ['holiday_links', '[data-holiday-links]']]) {
      const target = $(selector); target.replaceChildren();
      for (const link of settings[key] || []) {
        const a = document.createElement('a'); a.className = 'button button-light'; a.textContent = link.title + ' ↗'; a.href = link.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; target.append(a);
      }
      if (!target.children.length) target.textContent = 'Voeg je eigen links toe in config.json.';
    }
  }

  function showApp(username, configuration = {}) {
    applySettings(configuration);
    $('[data-boot]').hidden = true;
    resetChat(); resetCloud();
    state.user = username;
    resetAgenda();
    resetTasks();
    push.unread = null;
    try { state.pageId = localStorage.getItem(`family-last-page:${username}`) || ''; } catch { state.pageId = ''; }
    document.body.classList.toggle('chat-screen', location.hash === '#chat');
    try { state.expanded = new Set(JSON.parse(localStorage.getItem(`family-page-tree:${username}`) || '[]')); } catch { state.expanded = new Set(); }
    $('#login').hidden = true;
    $('[data-app]').hidden = false;
    $('[data-user]').textContent = username;
    $$('[data-avatar]').forEach(node => renderAvatar(node, username));
    $$('[data-member1-avatar]').forEach(node => renderAvatar(node, members[0]));
    $$('[data-member2-avatar]').forEach(node => renderAvatar(node, members[1]));
    updateAgendaDate();
    loadDashboard();
    loadChat();
    setupNotifications();
  }

  async function loadDashboard() {
    await Promise.allSettled([loadAgenda(), loadWeather(), refreshTasks(), loadPages()]);
  }

  function resetAgenda() {
    clearTimeout(agendaState.timer);
    agendaState.generation++;
    Object.assign(agendaState, {loading:false, lastAttempt:0, lastSuccess:0, day:'', renderedDay:'', detail:'', error:'', timer:null});
    state.agenda = [];
    renderAgenda();
  }

  function updateAgendaDate() {
    const now = agendaNow();
    const label = $('[data-date-label]');
    label.textContent = agendaLabelFormat.format(now);
    label.dateTime = agendaDay(now);
  }

  function renderAgenda() {
    const today = agendaDay();
    agendaState.renderedDay = today;
    updateAgendaDate();
    // Drop past dates immediately, even before a new network request completes.
    const upcoming = state.agenda.filter(item => item.date >= today);
    const pending = agendaState.loading || !agendaState.lastSuccess || agendaState.day !== today;
    const empty = `<li class="subtle">${agendaState.error ? 'De agenda is tijdelijk niet bereikbaar.' : pending ? 'Agenda bijwerken…' : 'Geen afspraken in deze periode.'}</li>`;
    const home = upcoming.filter(item => item.date === today).slice(0, 5);
    $('[data-agenda]').innerHTML = home.length ? agendaMarkup(home, true) : empty;
    $('[data-agenda-full]').innerHTML = upcoming.length ? agendaMarkup(upcoming, false) : empty;
    const updated = agendaState.lastSuccess ? agendaTimeFormat.format(new Date(agendaState.lastSuccess)) : '';
    const text = agendaState.error
      ? `${agendaState.error}${updated ? ` Laatst bijgewerkt: ${agendaLabelFormat.format(new Date(agendaState.lastSuccess))} om ${updated}.` : ''} We proberen het opnieuw.`
      : agendaState.day !== today || !agendaState.lastSuccess ? 'Agenda bijwerken…'
        : `${agendaState.detail} Nederlandse tijd · bijgewerkt ${updated}${agendaState.loading ? ' · verversen…' : ' · ververst automatisch'}`;
    $$('[data-agenda-status], [data-agenda-status-full]').forEach(node => { node.textContent = text; });
  }

  async function loadAgenda(force = false) {
    if (!state.user || document.hidden || agendaState.loading) return;
    const started = Date.now();
    const changedDay = agendaState.day !== agendaDay();
    const minimumGap = force || changedDay ? 5000 : 60000;
    if (started - agendaState.lastAttempt < minimumGap) {
      clearTimeout(agendaState.timer);
      agendaState.timer = setTimeout(() => loadAgenda(force), Math.max(1000, minimumGap - (started - agendaState.lastAttempt)));
      return;
    }
    clearTimeout(agendaState.timer);
    const generation = agendaState.generation;
    let crossedMidnight = false;
    agendaState.loading = true; agendaState.lastAttempt = started;
    renderAgenda();
    try {
      const data = await api(`/api/agenda?live=${started}`);
      if (generation !== agendaState.generation) return;
      const serverTime = Date.parse(data.server_now);
      if (Number.isFinite(serverTime)) agendaState.clockOffset = serverTime - Date.now();
      if (!['connected', 'unavailable'].includes(data.status) || !Array.isArray(data.items)) throw new Error(data.detail || 'De agenda is tijdelijk niet bereikbaar.');
      if (data.today && data.today !== agendaDay()) {
        crossedMidnight = true;
        throw new Error('De agenda voor de nieuwe dag wordt opgehaald.');
      }
      if (data.items.some(item => !item || !/^\d{4}-\d{2}-\d{2}$/.test(item.date))) throw new Error('De agenda kon niet volledig worden opgehaald.');
      state.agenda = data.items;
      agendaState.day = data.today || agendaDay();
      agendaState.lastSuccess = agendaNow().getTime();
      agendaState.detail = data.detail || '';
      agendaState.error = '';
    } catch (error) {
      if (generation === agendaState.generation) agendaState.error = error.message || 'De agenda is tijdelijk niet bereikbaar.';
    } finally {
      if (generation === agendaState.generation) {
        agendaState.loading = false;
        renderAgenda();
        agendaState.timer = setTimeout(() => loadAgenda(), Math.max(1000, (crossedMidnight ? 5000 : 60000) - (Date.now() - agendaState.lastAttempt)));
      }
    }
  }

  function resumeAgenda() {
    if (!state.user || document.hidden) return;
    renderAgenda();
    loadAgenda(true);
  }
  // This also updates an app left open across Dutch midnight and DST changes.
  setInterval(() => {
    if (state.user && !document.hidden && agendaState.renderedDay !== agendaDay()) resumeAgenda();
  }, 1000);
  window.addEventListener('online', resumeAgenda);
  window.addEventListener('focus', resumeAgenda);
  window.addEventListener('pageshow', resumeAgenda);
  document.addEventListener('visibilitychange', resumeAgenda);
  window.addEventListener('thuis-app-visibility', () => { if (window.__thuisMacActive) resumeAgenda(); });

  function agendaMarkup(items, home) {
    if (!items.length) return '<li class="subtle">Geen afspraken in deze periode.</li>';
    let priorDate = '';
    const limit = home ? 5 : items.length;
    return items.slice(0, limit).map((item) => {
      const date = new Date(`${item.date}T12:00:00Z`);
      const day = item.date === agendaDay() ? 'Vandaag' : agendaLabelFormat.format(date);
      const heading = !home && priorDate !== item.date ? `<li class="agenda-day">${escapeHtml(day)}</li>` : '';
      priorDate = item.date;
      const category = ['me', 'family', 'qa'].includes(item.category) ? item.category : 'me';
      const label = category === 'family' ? 'Gezin' : category === 'qa' ? 'Q&A' : 'Persoonlijk';
      const location = item.location ? `<span>${escapeHtml(item.location)}</span>` : '';
      return `${heading}<li class="agenda-item ${category}"><time class="agenda-time">${escapeHtml(item.time)}</time><span class="agenda-line"></span><span class="agenda-copy"><b>${escapeHtml(item.title)}</b><span class="agenda-meta"><i class="agenda-chip">${label}</i><span>${escapeHtml(item.calendar)}</span>${location}</span></span></li>`;
    }).join('');
  }

  const weatherDescriptions = { 0: ['Zonnig', '☀'], 1: ['Licht bewolkt', '🌤'], 2: ['Half bewolkt', '⛅'], 3: ['Bewolkt', '☁'], 45: ['Mistig', '〰'], 48: ['Mistig', '〰'], 51: ['Lichte motregen', '🌦'], 53: ['Motregen', '🌦'], 55: ['Motregen', '🌧'], 61: ['Lichte regen', '🌦'], 63: ['Regen', '🌧'], 65: ['Stevige regen', '🌧'], 71: ['Lichte sneeuw', '🌨'], 73: ['Sneeuw', '🌨'], 75: ['Stevige sneeuw', '❄'], 80: ['Regenbuien', '🌦'], 81: ['Regenbuien', '🌧'], 82: ['Stevige buien', '🌧'], 95: ['Onweer', '⛈'] };
  const weatherState = {loading:false, lastSuccess:0, lastAttempt:0};
  async function loadWeather(force = false) {
    if (!state.user || weatherState.loading) return;
    if (!settings.weather) { $('[data-weather-summary]').textContent = 'Kies je eigen weerlocatie'; $('[data-weather-status]').textContent = 'Stel weather in config.json in om het weer te tonen.'; return; }
    const now = Date.now();
    if (!force && (now - weatherState.lastAttempt < 60000 || now - weatherState.lastSuccess < 600000)) return;
    weatherState.loading = true; weatherState.lastAttempt = now;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const status = $('[data-weather-status]');
    try {
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(settings.weather.latitude)}&longitude=${encodeURIComponent(settings.weather.longitude)}&current=temperature_2m,apparent_temperature,weather_code&hourly=precipitation_probability&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&forecast_days=7&timezone=Europe%2FAmsterdam`;
      const response = await fetch(url, { cache: 'no-store', signal:controller.signal });
      if (!response.ok) throw new Error('Weer niet beschikbaar');
      const data = await response.json();
      const current = data.current;
      if (!current || !Number.isFinite(current.temperature_2m) || !Number.isFinite(current.apparent_temperature) || !Array.isArray(data.daily?.time) || data.daily.time.length < 7 || !Array.isArray(data.hourly?.time) || !['weather_code','temperature_2m_max','temperature_2m_min'].every(key => Array.isArray(data.daily[key]) && data.daily[key].length === data.daily.time.length && data.daily[key].every(Number.isFinite))) throw new Error('Onvolledig weerbericht');
      const [summary, icon] = weatherDescriptions[current.weather_code] || ['Wisselvallig', '☁'];
      $('[data-weather-now]').textContent = `${Math.round(current.temperature_2m)}°`;
      $('[data-weather-summary]').textContent = summary;
      $('[data-weather-icon]').textContent = icon;
      $('[data-weather-feels]').textContent = `${Math.round(current.apparent_temperature)}°`;
      const currentHour = data.hourly.time.indexOf(`${current.time.slice(0, 13)}:00`);
      $('[data-weather-rain]').textContent = `${currentHour >= 0 ? data.hourly.precipitation_probability?.[currentHour] ?? '—' : data.daily.precipitation_probability_max?.[0] ?? '—'}%`;
      $('[data-forecast]').innerHTML = data.daily.time.map((day, index) => {
        const [desc, symbol] = weatherDescriptions[data.daily.weather_code[index]] || ['Wisselvallig', '☁'];
        const dayName = index === 0 ? 'vandaag' : shortDate(new Date(`${day}T12:00:00`));
        return `<div class="forecast-day" title="${escapeHtml(desc)}"><span>${escapeHtml(dayName)}</span><i>${symbol}</i><b>${Math.round(data.daily.temperature_2m_max[index])}°</b><small>${Math.round(data.daily.temperature_2m_min[index])}°</small></div>`;
      }).join('');
      weatherState.lastSuccess = Date.now();
      status.textContent = `Vandaag + de komende zes dagen · Open-Meteo · bijgewerkt ${new Date().toLocaleTimeString('nl-NL', {hour:'2-digit',minute:'2-digit'})}`;
    } catch {
      if (!weatherState.lastSuccess) {
        $('[data-weather-summary]').textContent = 'Weer tijdelijk niet bereikbaar';
        $('[data-forecast]').innerHTML = '';
        status.textContent = 'We proberen het automatisch opnieuw.';
      } else {
        status.textContent = `Verbinding onderbroken · laatst opgehaald ${new Date(weatherState.lastSuccess).toLocaleString('nl-NL', {day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})}. We proberen het opnieuw.`;
      }
    } finally { clearTimeout(timeout); weatherState.loading = false; }
  }
  setInterval(() => { if (!document.hidden) loadWeather(); }, 60000);
  window.addEventListener('online', () => loadWeather(true));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadWeather(); });
  window.addEventListener('thuis-app-visibility', () => { if (window.__thuisMacActive) loadWeather(); });

  const taskLists = {today:'Vandaag', tomorrow:'Morgen', 'future-log':'Later'};
  const pencilIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15Z"/></svg>';
  const gripIcon = '<svg viewBox="0 0 16 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="5" r="1.5"/><circle cx="11" cy="5" r="1.5"/><circle cx="5" cy="12" r="1.5"/><circle cx="11" cy="12" r="1.5"/><circle cx="5" cy="19" r="1.5"/><circle cx="11" cy="19" r="1.5"/></svg>';
  function resetTasks() {
    tasks.cancelDrag?.();
    tasks.generation++; tasks.request++;
    tasks.items = []; tasks.signature = ''; tasks.loaded = false; tasks.pending.clear();
    tasks.editor = null; tasks.saving = false;
    $('[data-task-dialog]').close();
    renderTasks();
  }
  async function refreshTasks() {
    if (!state.user || tasks.cancelDrag) return;
    const request = ++tasks.request, generation = tasks.generation;
    try {
      const data = await api(`/api/tasks?list=all&live=${Date.now()}`);
      if (generation !== tasks.generation || request !== tasks.request || tasks.cancelDrag) return;
      tasks.items = data.items;
      tasks.loaded = true;
      const signature = JSON.stringify(data.items);
      if (tasks.signature !== signature) { tasks.signature = signature; renderTasks(); }
      $('[data-task-status]').textContent = '';
    } catch (error) {
      if (generation !== tasks.generation || request !== tasks.request) return;
      $('[data-task-status]').textContent = error.message;
      if (!tasks.loaded) $$('[data-home-tasks], [data-task-list-items]').forEach(root => { root.innerHTML = '<li class="subtle">Taken ophalen lukt even niet. We proberen het opnieuw.</li>'; });
    }
  }
  function renderTasks() {
    const fill = (root, items, board) => {
      root.innerHTML = items.length ? items.map(task => taskMarkup(task, board)).join('') : `<li class="task-empty">${board ? 'Nog niets op het lijstje.' : 'Geen open taken. Fijn!'}</li>`;
      bindTaskChecks(root);
    };
    fill($('[data-home-tasks]'), tasks.items.filter(task => task.list_key === 'today'), false);
    for (const list of Object.keys(taskLists)) {
      const items = tasks.items.filter(task => task.list_key === list);
      fill($(`[data-task-list-items="${list}"]`), items, true);
      $(`[data-task-count="${list}"]`).textContent = items.length;
    }
  }
  function taskMarkup(task, board = false) {
    const id = escapeHtml(task.id), title = escapeHtml(task.title);
    const date = task.due_date ? new Intl.DateTimeFormat('nl-NL', {day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(`${task.due_date}T12:00:00Z`)) : '';
    return `<li class="task-row task-card" data-task-row="${id}">
      <input class="task-check" type="checkbox" data-complete="${id}" aria-label="${title} afvinken">
      <span class="task-title">${title}</span>
      <button type="button" class="task-edit" data-task-edit="${id}" aria-label="${title} aanpassen" title="Taak aanpassen">${pencilIcon}</button>
      <div class="task-card-meta">
        <button type="button" class="task-owner" data-task-owner="${id}" data-owner="${escapeHtml(task.assigned_to || '')}" aria-label="${title}: ${escapeHtml(task.assigned_to || 'nog niet toegewezen')}. Persoon kiezen.">${task.assigned_to ? `<span class="avatar" data-task-avatar="${escapeHtml(task.assigned_to)}"></span><span>${escapeHtml(task.assigned_to)}</span>` : '<span>Toewijzen +</span>'}</button>
        ${date ? `<span class="task-date-chip" title="${task.reminder_enabled ? 'Herinnering om 09:00 Nederlandse tijd' : 'Datum; open het potloodje om een herinnering in te stellen'}">${task.reminder_enabled ? '<span aria-hidden="true">◷</span><span class="visually-hidden">Herinnering </span>' : ''}<time datetime="${escapeHtml(task.due_date)}">${escapeHtml(date)}</time></span>` : ''}
        ${board ? `<button type="button" class="task-drag" data-drag-task="${id}" aria-label="${title} verplaatsen. Sleep naar een lijst of druk Enter om een lijst te kiezen." title="Sleep naar een andere lijst">${gripIcon}</button>` : ''}
      </div>
    </li>`;
  }
  async function patchTask(id, changes) {
    if (tasks.pending.has(id)) return false;
    const task = tasks.items.find(item => item.id === id);
    if (!task) return false;
    const generation = tasks.generation;
    tasks.pending.add(id); tasks.request++;
    try {
      await api(`/api/tasks/${encodeURIComponent(id)}`, {method:'PATCH', body:JSON.stringify({revision:task.revision, ...changes})});
      if (generation !== tasks.generation) return false;
      await refreshTasks();
      return true;
    } catch (error) {
      if (generation === tasks.generation) { toast(error.message); await refreshTasks(); }
      return false;
    } finally { if (generation === tasks.generation) tasks.pending.delete(id); }
  }
  function bindTaskDrag(button) {
    let suppressClick = false;
    button.addEventListener('click', () => {
      if (suppressClick) return;
      openTaskEditor(button.dataset.dragTask);
      $('#edit-task-list').focus();
    });
    button.addEventListener('dragstart', event => event.preventDefault());
    button.addEventListener('pointerdown', event => {
      if (event.button !== 0 || tasks.cancelDrag || tasks.pending.has(button.dataset.dragTask)) return;
      const task = tasks.items.find(item => item.id === button.dataset.dragTask);
      if (!task) return;
      tasks.request++;
      chooseAssignee(null);
      const row = button.closest('[data-task-row]'), pointerId = event.pointerId;
      const startX = event.clientX, startY = event.clientY;
      let x = startX, y = startY, ghost = null, target = null, frame = null, finished = false, lastFrame = 0;
      button.setPointerCapture(pointerId);
      const highlight = () => {
        const next = document.elementFromPoint(x, y)?.closest('[data-task-column]');
        if (next !== target) { target?.classList.remove('task-drop-target'); target = next; target?.classList.add('task-drop-target'); }
      };
      const tick = timestamp => {
        const elapsed = Math.min(32, timestamp - (lastFrame || timestamp)); lastFrame = timestamp;
        const speed = y < 110 ? -Math.min(14, (110-y)/6) : y > innerHeight-90 ? Math.min(14, (y-innerHeight+90)/6) : 0;
        if (speed) window.scrollBy(0, speed * elapsed / 16);
        highlight(); frame = requestAnimationFrame(tick);
      };
      function move(e) {
        if (e.pointerId !== pointerId) return;
        x = e.clientX; y = e.clientY;
        if (!ghost && Math.hypot(x-startX, y-startY) < 8) return;
        e.preventDefault();
        if (!ghost) {
          ghost = document.createElement('div'); ghost.className = 'task-drag-ghost'; ghost.textContent = task.title;
          ghost.setAttribute('aria-hidden','true'); document.body.append(ghost);
          row.classList.add('is-dragging'); document.body.classList.add('dragging-task');
          frame = requestAnimationFrame(tick);
        }
        ghost.style.left = `${Math.min(innerWidth-240, Math.max(8, x-60))}px`;
        ghost.style.top = `${y+18}px`;
        highlight();
      }
      function finish(e) {
        if (finished) return;
        finished = true;
        const dragged = !!ghost, list = target?.dataset.taskColumn;
        ghost?.remove(); target?.classList.remove('task-drop-target'); row.classList.remove('is-dragging');
        document.body.classList.remove('dragging-task'); cancelAnimationFrame(frame);
        button.removeEventListener('pointermove',move); button.removeEventListener('pointerup',finish);
        button.removeEventListener('pointercancel',finish); button.removeEventListener('lostpointercapture',finish);
        window.removeEventListener('blur',cancel);
        if (button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
        tasks.cancelDrag = null; suppressClick = dragged;
        if (dragged && e?.type === 'pointerup' && list && list !== task.list_key) {
          patchTask(task.id, {list, revision:task.revision}).then(ok => { if (ok) toast(`Taak verplaatst naar ${taskLists[list]}.`); });
        }
        setTimeout(() => { suppressClick = false; }, 0);
      }
      const cancel = () => finish();
      tasks.cancelDrag = cancel;
      window.addEventListener('blur',cancel);
      button.addEventListener('pointermove',move,{passive:false}); button.addEventListener('pointerup',finish);
      button.addEventListener('pointercancel',finish); button.addEventListener('lostpointercapture',finish);
    });
  }
  function taskFormValues() {
    const form = $('[data-task-edit-form]');
    return {title:form.elements.title.value.trim(), list:form.elements.list.value,
      assigned_to:form.elements.assigned_to.value || null, due_date:form.elements.due_date.value || null};
  }
  function taskEditorDirty() {
    return !!tasks.editor && JSON.stringify(taskFormValues()) !== tasks.editor.initial;
  }
  function closeTaskEditor(force = false) {
    if (!force && (tasks.saving || (taskEditorDirty() && !confirm('Je wijzigingen zijn nog niet opgeslagen. Toch sluiten?')))) return false;
    tasks.editor = null;
    $('[data-task-dialog]').close();
    return true;
  }
  function taskReminderHint() {
    const form = $('[data-task-edit-form]');
    const recipient = form.elements.assigned_to.value || tasks.editor?.createdBy || state.user;
    $('[data-task-clear-date]').disabled = !form.elements.due_date.value || tasks.saving;
    $('[data-task-reminder-help]').textContent = form.elements.due_date.value
      ? `Appmelding voor ${recipient} om 09:00 Nederlandse tijd. Is dat tijdstip vandaag al voorbij, dan komt de melding na het opslaan. Zet Appmeldingen aan in Instellingen op het ontvangende toestel.`
      : 'Geen herinnering. Kies een datum als je een appmelding wilt ontvangen.';
  }
  function openTaskEditor(id = null, list = 'today') {
    if (tasks.saving) return;
    const task = id ? tasks.items.find(item => item.id === id) : null;
    if (id && !task) return;
    chooseAssignee(null);
    const form = $('[data-task-edit-form]'); form.reset();
    for (const control of form.elements) control.disabled = false;
    form.elements.title.value = task?.title || '';
    form.elements.list.value = task?.list_key || list;
    form.elements.assigned_to.value = task?.assigned_to || '';
    form.elements.due_date.value = task?.due_date || '';
    tasks.editor = {id, revision:task?.revision, createdBy:task?.created_by || state.user, initial:JSON.stringify(taskFormValues())};
    $('#task-editor-heading').textContent = task ? 'Taak aanpassen' : 'Nieuwe taak';
    $('[data-task-save]').textContent = task ? 'Opslaan' : 'Toevoegen';
    $('[data-task-edit-error]').textContent = '';
    taskReminderHint();
    $('[data-task-dialog]').showModal();
    form.elements.title.focus();
  }
  $$('[data-new-task]').forEach(button => button.addEventListener('click', () => openTaskEditor(null, button.dataset.newTask)));
  $$('[data-task-close], [data-task-cancel]').forEach(button => button.addEventListener('click', () => closeTaskEditor()));
  $('[data-task-dialog]').addEventListener('cancel', event => {event.preventDefault(); closeTaskEditor();});
  $('[data-task-clear-date]').addEventListener('click', () => {$('#edit-task-date').value = ''; taskReminderHint();});
  $('#edit-task-date').addEventListener('change', taskReminderHint);
  $('#edit-task-owner').addEventListener('change', taskReminderHint);
  $('[data-task-edit-form]').addEventListener('submit', async event => {
    event.preventDefault();
    if (!tasks.editor || tasks.saving) return;
    const values = taskFormValues(), editor = tasks.editor, generation = tasks.generation;
    if (!values.title) {$('#edit-task-title').focus(); return;}
    tasks.saving = true; tasks.request++;
    for (const control of event.currentTarget.elements) control.disabled = true;
    const form = event.currentTarget;
    $('[data-task-save]').textContent = 'Opslaan…'; $('[data-task-edit-error]').textContent = '';
    try {
      await api(editor.id ? `/api/tasks/${encodeURIComponent(editor.id)}` : '/api/tasks', {
        method:editor.id ? 'PATCH' : 'POST', body:JSON.stringify({...values, reminder_enabled:!!values.due_date, ...(editor.id ? {revision:editor.revision} : {})})
      });
      if (generation !== tasks.generation) return;
      closeTaskEditor(true); await refreshTasks(); toast(editor.id ? 'Taak aangepast.' : 'Taak toegevoegd.');
    } catch (error) {
      if (generation !== tasks.generation) return;
      $('[data-task-edit-error]').textContent = error.message;
      if (error.status === 409) await refreshTasks();
    } finally {
      if (generation === tasks.generation) {
        tasks.saving = false;
        for (const control of form.elements) control.disabled = false;
        $('[data-task-save]').textContent = editor.id ? 'Opslaan' : 'Toevoegen';
        taskReminderHint();
      }
    }
  });
  setInterval(() => {if (!document.hidden && ['', '#home', '#taken'].includes(location.hash)) refreshTasks();}, 30000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) tasks.cancelDrag?.(); else refreshTasks(); });
  window.addEventListener('online', () => refreshTasks());
  let selectedAssignee = null, assigningTask = false;
  function chooseAssignee(person) {
    selectedAssignee = person;
    $$('[data-assign-person]').forEach(button => button.setAttribute('aria-pressed',String(button.dataset.assignPerson === person)));
    $$('[data-assign-cancel]').forEach(button => {button.hidden = !person;});
    $$('[data-assign-hint]').forEach(hint => {hint.textContent = person ? `Tik op een taak om die aan ${person} toe te wijzen.` : 'Sleep een foto naar een taak, of tik op de foto en daarna op een taak.';});
    document.body.classList.toggle('assigning-person',!!person);
  }
  async function assignTask(id, person) {
    if (assigningTask) return;
    assigningTask = true;
    try {
      if (await patchTask(id, {assigned_to:person})) {
        chooseAssignee(null);
        toast(person ? `Taak toegewezen aan ${person}.` : 'Toewijzing verwijderd.');
      }
    } finally {assigningTask = false;}
  }
  $$('[data-assign-cancel]').forEach(button => button.addEventListener('click',()=>chooseAssignee(null)));
  $$('[data-assign-person]').forEach(button => {
    let suppressClick = false;
    button.addEventListener('dragstart', event => event.preventDefault());
    button.addEventListener('click',()=>{if (suppressClick) {suppressClick=false;return;} chooseAssignee(selectedAssignee === button.dataset.assignPerson ? null : button.dataset.assignPerson);});
    button.addEventListener('pointerdown',event=>{
      if (event.button !== 0 || assigningTask) return;
      const person = button.dataset.assignPerson, x = event.clientX, y = event.clientY, pointerId=event.pointerId;
      let ghost=null, target=null;
      button.setPointerCapture(pointerId);
      const clear=()=>$$('[data-task-row]').forEach(row=>row.classList.remove('assignment-target'));
      function move(e) {
        if (!ghost && Math.hypot(e.clientX-x,e.clientY-y)<8) return;
        if (!ghost) {ghost=button.cloneNode(true);ghost.className='person-drag assignment-ghost';ghost.setAttribute('aria-hidden','true');ghost.removeAttribute('data-assign-person');document.body.append(ghost);}
        ghost.style.left=`${e.clientX+10}px`;ghost.style.top=`${e.clientY+10}px`;
        clear();target=document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-task-row]');target?.classList.add('assignment-target');
        if(e.clientY<60) window.scrollBy(0,-15);else if(e.clientY>innerHeight-60) window.scrollBy(0,15);
      }
      function finish(e) {
        const dragged=!!ghost;ghost?.remove();clear();
        button.removeEventListener('pointermove',move);button.removeEventListener('pointerup',finish);button.removeEventListener('pointercancel',finish);button.removeEventListener('lostpointercapture',finish);
        if(button.hasPointerCapture(pointerId)) button.releasePointerCapture(pointerId);
        suppressClick=dragged;
        if(dragged && e.type==='pointerup' && target) assignTask(target.dataset.taskRow,person);
        setTimeout(()=>{suppressClick=false;},0);
      }
      button.addEventListener('pointermove',move);button.addEventListener('pointerup',finish);button.addEventListener('pointercancel',finish);button.addEventListener('lostpointercapture',finish);
    });
  });
  let ownerTaskId = null;
  $$('[data-owner-choice]').forEach(button=>button.addEventListener('click',()=>{const id=ownerTaskId; $('[data-owner-dialog]').close(); if(id) assignTask(id,button.dataset.ownerChoice || null);}));
  $('[data-owner-close]').addEventListener('click',()=>$('[data-owner-dialog]').close());
  function bindTaskChecks(root) {
    $$('[data-task-avatar]',root).forEach(node=>renderAvatar(node,node.dataset.taskAvatar));
    $$('[data-task-row]',root).forEach(row=>row.addEventListener('click',event=>{
      if(!selectedAssignee) return;
      event.preventDefault();event.stopImmediatePropagation();assignTask(row.dataset.taskRow,selectedAssignee);
    },true));
    $$('[data-task-owner]',root).forEach(button=>button.addEventListener('click',()=>{ownerTaskId=button.dataset.taskOwner;$('[data-owner-dialog]').showModal();}));
    $$('[data-task-edit]',root).forEach(button => button.addEventListener('click', () => openTaskEditor(button.dataset.taskEdit)));
    $$('[data-drag-task]',root).forEach(bindTaskDrag);
    $$('[data-complete]',root).forEach(checkbox => checkbox.addEventListener('change', async () => {
      checkbox.disabled = true;
      if (await patchTask(checkbox.dataset.complete, {done:true})) toast('Taak afgevinkt.');
      else {checkbox.checked = false; checkbox.disabled = false;}
    }));
  }
  async function addTask(title, list) {
    const generation = tasks.generation;
    await api('/api/tasks', {method:'POST', body:JSON.stringify({title, list})});
    if (generation !== tasks.generation) return;
    await refreshTasks(); toast('Taak toegevoegd.');
  }

  function rememberTree() {
    try { localStorage.setItem(`family-page-tree:${state.user}`, JSON.stringify([...state.expanded])); } catch {}
  }
  function revealPage(id) {
    let parent = state.pages.find((page) => page.id === id)?.parent_id;
    const seen = new Set();
    while (parent && !seen.has(parent)) { seen.add(parent); state.expanded.add(parent); parent = state.pages.find((page) => page.id === parent)?.parent_id; }
    rememberTree();
  }
  function renderPageTree() {
    const groups = new Map();
    const ids = new Set(state.pages.map((page) => page.id));
    for (const page of state.pages) {
      const parent = ids.has(page.parent_id) ? page.parent_id : null;
      if (!groups.has(parent)) groups.set(parent, []);
      groups.get(parent).push(page);
    }
    const draw = (parent) => (groups.get(parent) || []).map((page) => {
      const children = groups.get(page.id)?.length;
      const expanded = state.expanded.has(page.id);
      return `<li><div class="tree-row" data-tree-row="${escapeHtml(page.id)}"><button class="tree-drag" type="button" data-drag-page="${escapeHtml(page.id)}" aria-label="${escapeHtml(page.title)} verslepen. Pijl omhoog of omlaag voor volgorde." title="Sleep om te sorteren · ↑ / ↓">⠿</button><button class="tree-toggle" type="button" data-toggle-page="${escapeHtml(page.id)}" aria-label="${escapeHtml(page.title)} ${expanded ? 'inklappen' : 'uitklappen'}" ${children ? `aria-expanded="${expanded}" aria-controls="children-${escapeHtml(page.id)}"` : 'disabled'}>${children ? (expanded ? '⌄' : '›') : '·'}</button><button class="tree-title ${page.id === state.pageId ? 'is-active' : ''}" type="button" data-open-page="${escapeHtml(page.id)}" title="${escapeHtml(page.title)}" ${page.id === state.pageId ? 'aria-current="page"' : ''}>${escapeHtml(page.title)}</button><button class="tree-add" type="button" data-add-child="${escapeHtml(page.id)}" aria-label="Subpagina onder ${escapeHtml(page.title)} maken">+</button></div>${children ? `<ul class="tree-children" id="children-${escapeHtml(page.id)}" ${expanded ? '' : 'hidden'}>${draw(page.id)}</ul>` : ''}</li>`;
    }).join('');
    $('[data-page-list]').innerHTML = state.pages.length ? `<ul class="page-tree">${draw(null)}</ul>` : '<p class="subtle">Nog geen pagina’s. Maak je eerste pagina.</p>';
    $$('[data-open-page]').forEach((button) => button.addEventListener('click', () => openPage(button.dataset.openPage)));
    $$('[data-toggle-page]').forEach((button) => button.addEventListener('click', () => {
      const id = button.dataset.togglePage;
      if (state.expanded.has(id)) state.expanded.delete(id); else state.expanded.add(id);
      rememberTree(); renderPageTree();
      $(`[data-toggle-page="${id}"]`)?.focus();
    }));
    bindPageOrder();
    $$('[data-add-child]').forEach((button) => button.addEventListener('click', () => createPage(button.dataset.addChild, button)));
  }
  let sortingPages = false;
  async function reorderPage(sourceId, targetId, placement) {
    if (sortingPages) return;
    sortingPages = true;
    $$('[data-drag-page]').forEach(button => { button.disabled = true; });
    try {
      await api('/api/pages/reorder', {method:'PATCH', body:JSON.stringify({source_id:sourceId, target_id:targetId, placement})});
      const data = await api('/api/pages');
      state.pages = data.items; renderPageTree();
      const children = $('.page-children');
      if (children) { children.outerHTML = childPagesMarkup(state.pageId); $$('[data-child-page]').forEach(button => button.addEventListener('click', () => openPage(button.dataset.childPage))); }
      toast('Paginavolgorde opgeslagen.');
      $(`[data-drag-page="${sourceId}"]`)?.focus({preventScroll:true});
    } catch (error) { toast(error.message); }
    finally { sortingPages = false; $$('[data-drag-page]').forEach(button => { button.disabled = false; }); }
  }
  function bindPageOrder() {
    $$('[data-drag-page]').forEach(handle => {
      handle.disabled = sortingPages;
      handle.addEventListener('keydown', event => {
        if (!['ArrowUp','ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        const source = state.pages.find(p => p.id === handle.dataset.dragPage);
        const siblings = state.pages.filter(p => p.parent_id === source.parent_id);
        const target = siblings[siblings.indexOf(source) + (event.key === 'ArrowUp' ? -1 : 1)];
        if (target) reorderPage(source.id, target.id, event.key === 'ArrowUp' ? 'before' : 'after');
      });
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || sortingPages) return;
        const source = state.pages.find(p => p.id === handle.dataset.dragPage);
        const sourceRow = handle.closest('[data-tree-row]');
        let target = null, placement = null, started = false;
        const startY = event.clientY, pointerId = event.pointerId;
        handle.setPointerCapture(pointerId);
        function clearMarks() { $$('[data-tree-row]').forEach(row => row.classList.remove('drop-before','drop-after')); }
        function move(e) {
          if (!started && Math.abs(e.clientY-startY)<5) return;
          started = true; sourceRow.classList.add('is-dragging'); clearMarks(); target = null;
          const row = document.elementFromPoint(e.clientX,e.clientY)?.closest('[data-tree-row]');
          const candidate = state.pages.find(p => p.id === row?.dataset.treeRow);
          if (candidate && candidate.id !== source.id && candidate.parent_id === source.parent_id) {
            target = candidate.id; const rect = row.getBoundingClientRect();
            placement = e.clientY < rect.top + rect.height/2 ? 'before' : 'after';
            row.classList.add(`drop-${placement}`);
          }
          const list = $('[data-page-list]'), bounds = list.getBoundingClientRect();
          if (list.scrollHeight > list.clientHeight) { if (e.clientY < bounds.top+30) list.scrollTop -= 12; else if(e.clientY > bounds.bottom-30) list.scrollTop += 12; }
          if (e.clientY < 50) window.scrollBy(0,-12); else if(e.clientY > innerHeight-50) window.scrollBy(0,12);
        }
        function finish(e) {
          clearMarks(); sourceRow.classList.remove('is-dragging');
          handle.removeEventListener('pointermove',move); handle.removeEventListener('pointerup',finish); handle.removeEventListener('pointercancel',finish); handle.removeEventListener('lostpointercapture',finish);
          if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
          if (e.type === 'pointerup' && started && target) reorderPage(source.id,target,placement);
        }
        handle.addEventListener('pointermove',move); handle.addEventListener('pointerup',finish); handle.addEventListener('pointercancel',finish); handle.addEventListener('lostpointercapture',finish);
      });
    });
  }
  function descendants(id) {
    const found = new Set([id]);
    let changed = true;
    while (changed) { changed = false; for (const page of state.pages) { if (found.has(page.parent_id) && !found.has(page.id)) { found.add(page.id); changed = true; } } }
    return found;
  }
  function pagePath(page) {
    const names = [page.title];
    const seen = new Set([page.id]);
    let parent = state.pages.find((item) => item.id === page.parent_id);
    while (parent && !seen.has(parent.id)) { seen.add(parent.id); names.unshift(parent.title); parent = state.pages.find((item) => item.id === parent.parent_id); }
    return names.join(' / ');
  }
  function childPagesMarkup(id) {
    const children = state.pages.filter((page) => page.parent_id === id);
    if (!children.length) return '';
    return `<section class="page-children" aria-label="Subpagina’s"><h3>Subpagina’s</h3>${children.map((page) => `<button type="button" data-child-page="${escapeHtml(page.id)}"><span>${escapeHtml(page.title)}</span><span aria-hidden="true">↗</span></button>`).join('')}</section>`;
  }
  function pageActions(page) {
    const excluded = descendants(page.id);
    const options = state.pages.filter((item) => !excluded.has(item.id));
    return `<div class="page-location">${escapeHtml(page.parent_id ? pagePath(page) : 'Familieboek / ' + page.title)}</div><details class="page-actions"><summary>Pagina organiseren <span aria-hidden="true">•••</span></summary><div class="page-actions-content"><button class="button button-light" type="button" data-create-child>Subpagina maken +</button><label for="parent-page">Verplaatsen naar</label><div class="page-move"><select id="parent-page"><option value="">Hoofdniveau</option>${options.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === page.parent_id ? 'selected' : ''}>${escapeHtml(pagePath(item))}</option>`).join('')}</select><button class="button button-light" type="button" data-move-page>Verplaatsen</button></div><button class="delete-page" type="button" data-delete-page>Naar prullenbak</button></div></details>`;
  }
  let pageEditor = null, pageSave = null, pageUploading = false;
  function disposeEditor() { pageSave?.dispose(); pageSave = null; pageEditor?.destroy(); pageEditor = null; }
  async function flushPage() { if (pageUploading) { toast('Wacht tot de bestanden zijn opgeslagen.'); return false; } return !state.pageDirty || (pageSave && await pageSave.flush()); }
  function clearPage() {
    disposeEditor();
    try { if (state.user) localStorage.removeItem(`family-last-page:${state.user}`); } catch {}
    state.pageId = ''; state.pageDirty = false; state.pageRequest++;
    $('[data-page-editor]').innerHTML = '<div class="empty-page"><span aria-hidden="true">✳</span><h2>Een nieuw begin.</h2><p>Maak een pagina of herstel er één uit de prullenbak.</p></div>';
    $('[data-comments]').replaceChildren(); $('[data-file-list]').replaceChildren();
    $('[data-comment-form]').hidden = true; $('[data-attachments]').hidden = true;
  }
  async function createPage(parentId, button) {
    if (!await flushPage()) return;
    try { await busy(button, async () => {
      const result = await api('/api/pages', { method: 'POST', body: JSON.stringify({ title: 'Nieuwe pagina', parent_id: parentId }) });
      state.pageDirty = false;
      if (parentId) { state.expanded.add(parentId); rememberTree(); }
      await loadPages(result.page.id);
      $('[data-edit-page]')?.click(); $('#page-title')?.focus(); $('#page-title')?.select();
      toast(parentId ? 'Subpagina aangemaakt.' : 'Pagina aangemaakt.');
    }); } catch (error) { toast(error.message); }
  }
  function bindPageActions(page) {
    $('[data-create-child]').addEventListener('click', (event) => createPage(page.id, event.currentTarget));
    $('[data-move-page]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const parentId = $('#parent-page').value || null;
      if (parentId === page.parent_id) { toast('Deze pagina staat hier al.'); return; }
      try { await busy(button, async () => {
        await api(`/api/pages/${encodeURIComponent(page.id)}`, { method: 'PATCH', body: JSON.stringify({ parent_id: parentId }) });
        page.parent_id = parentId;
        if (parentId) state.expanded.add(parentId);
        await loadPages(page.id);
        revealPage(page.id); renderPageTree();
        $('.page-location').textContent = pagePath(state.pages.find((item) => item.id === page.id));
        toast('Pagina verplaatst, inclusief subpagina’s.');
      }, 'Verplaatsen…'); } catch (error) { toast(error.message); }
    });
    $('[data-delete-page]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const count = descendants(page.id).size - 1;
      const extra = count ? ` Inclusief ${count} subpagina${count === 1 ? '' : '’s'}.` : '';
      if (!confirm(`“${page.title}” naar de prullenbak?${extra} Je kunt alles later herstellen.${state.pageDirty ? ' Niet opgeslagen wijzigingen gaan verloren.' : ''}`)) return;
      try { await busy(button, async () => {
        await api(`/api/pages/${encodeURIComponent(page.id)}`, { method: 'DELETE' });
        clearPage(); await loadPages(page.parent_id || '');
        toast('Naar de prullenbak verplaatst. Je kunt de pagina daar herstellen.');
      }); } catch (error) { toast(error.message); }
    });
  }
  async function loadTrash() {
    const root = $('[data-trash-list]');
    root.innerHTML = '<p class="subtle">Prullenbak laden…</p>';
    try {
      const data = await api('/api/pages?trash=1');
      const byId = new Map(data.items.map((page) => [page.id, page]));
      const roots = data.items.filter((page) => !byId.has(page.parent_id) || byId.get(page.parent_id).deleted_batch !== page.deleted_batch);
      root.innerHTML = roots.length ? roots.map((page) => {
        const count = data.items.filter((item) => item.deleted_batch === page.deleted_batch).length - 1;
        return `<div class="trash-row"><div><b>${escapeHtml(page.title)}</b><small>${count ? `Met ${count} subpagina${count === 1 ? '' : '’s'} · ` : ''}${escapeHtml(new Date(page.deleted_at).toLocaleDateString('nl-NL'))}</small></div><button class="button button-light" data-restore-page="${escapeHtml(page.id)}">Herstellen</button></div>`;
      }).join('') : '<p class="subtle">De prullenbak is leeg.</p>';
      $$('[data-restore-page]').forEach((button) => button.addEventListener('click', async () => {
        try { await busy(button, async () => {
          const result = await api(`/api/pages/${encodeURIComponent(button.dataset.restorePage)}/restore`, { method: 'POST', body: '{}' });
          await loadPages(state.pageDirty ? state.pageId : result.page_id);
          await loadTrash(); toast('Pagina hersteld, met reacties en bestanden.');
        }, 'Herstellen…'); } catch (error) { toast(error.message); }
      }));
    } catch (error) { root.textContent = error.message; }
  }
  $('[data-open-trash]').addEventListener('click', () => { $('[data-trash-dialog]').showModal(); loadTrash(); });
  $('[data-close-trash]').addEventListener('click', () => $('[data-trash-dialog]').close());

  async function loadPages(selectId = state.pageId) {
    try {
      const data = await api('/api/pages');
      state.pages = data.items || [];
      $('[data-trash-count]').textContent = data.trash_count ? ` (${data.trash_count})` : '';
      renderPageTree();
      const chosen = state.pages.some((page) => page.id === selectId) ? selectId : state.pages.find((page) => /familie management/i.test(page.title))?.id || state.pages[0]?.id;
      if (chosen && !state.pageDirty) await openPage(chosen);
      if (!chosen) clearPage();
    } catch (error) { if (error.message !== 'Log opnieuw in.') $('[data-page-list]').innerHTML = '<p class="subtle">Pagina’s konden niet worden opgehaald.</p>'; }
  }

  async function openPage(id, preserveEdits = false) {
    if (!preserveEdits && !await flushPage()) return;
    const request = ++state.pageRequest;
    let data;
    try { data = await api(`/api/pages/${encodeURIComponent(id)}`); } catch (error) { toast(error.message); return; }
    if (request !== state.pageRequest || (state.pageDirty && !preserveEdits)) return;
    const keepEditor = preserveEdits && state.pageId === id;
    state.pageId = id;
    try { localStorage.setItem(`family-last-page:${state.user}`, id); } catch {}
    revealPage(id);
    renderPageTree();
    const page = data.page;
    if (!keepEditor) {
      disposeEditor();
      state.pageDirty = false;
      $('[data-page-editor]').innerHTML = `<div class="page-editor-inner">${pageActions(page)}<div class="editor-meta"><span class="eyebrow">ONS FAMILIEBOEK</span><span data-save-status role="status">Alles opgeslagen</span></div><label class="visually-hidden" for="page-title">Titel</label><input id="page-title" maxlength="160" value="${escapeHtml(page.title)}" placeholder="Zonder titel"><div class="editor-toolbar" role="toolbar" aria-label="Tekstopmaak" data-editor-toolbar></div><div class="editor-canvas"><div data-rich-editor></div><div class="slash-menu" data-slash-menu aria-label="Blok invoegen" hidden></div></div><div data-save-error role="alert" hidden><p></p><button type="button" data-retry-save>Opnieuw opslaan</button><button type="button" data-download-draft>Download mijn tekst</button><button type="button" data-reload-page>Serverversie laden</button></div>${childPagesMarkup(page.id)}</div>`;
      bindPageActions(page);
      $$('[data-child-page]').forEach((button) => button.addEventListener('click', () => openPage(button.dataset.childPage)));
      const title = $('#page-title'), status = $('[data-save-status]'), errorBox = $('[data-save-error]');
      let baseTitle = page.title, baseBody = page.body, timer, saving = null, disposed = false, conflict = false;
      const markDirty = () => { state.pageDirty = true; status.textContent = 'Nog niet opgeslagen'; clearTimeout(timer); if (!conflict) timer = setTimeout(save, 900); };
      pageEditor = window.FamilyPageEditor({element:$('[data-rich-editor]'), toolbar:$('[data-editor-toolbar]'), menu:$('[data-slash-menu]'), content:page.body, onChange:markDirty,
        onUploadFile:(file, progress)=>uploadPageFile(page.id, file, progress),
        onUploadState:active=>{pageUploading=active;}, onError:toast,
        onUploaded:async()=>{await pageSave?.flush(); if (state.pageId===page.id) await openPage(page.id,true);}
      });
      const editor = pageEditor;
      // Keep the original Markdown untouched until the body is actually edited.
      let bodyEdited = false;
      editor.on('update', () => { bodyEdited = true; });
      function snapshot() { return {title:title.value.trim() || 'Zonder titel', body:bodyEdited ? editor.getMarkdown() : baseBody}; }
      async function save() {
        clearTimeout(timer);
        if (disposed) return false;
        if (saving) { await saving; if (conflict || disposed) return false; return state.pageDirty ? save() : true; }
        if (conflict) return false;
        const value = snapshot();
        if (value.title === baseTitle && value.body === baseBody) { state.pageDirty = false; status.textContent = 'Alles opgeslagen'; return true; }
        if (value.body.length > 100000) { errorBox.hidden=false; $('p',errorBox).textContent='Deze pagina is te lang. Verdeel de inhoud over subpagina’s.'; return false; }
        status.textContent = 'Opslaan…';
        saving = (async () => {
          try {
            await api(`/api/pages/${encodeURIComponent(id)}`, {method:'PATCH', body:JSON.stringify({...value, expected_title:baseTitle, expected_body:baseBody})});
            baseTitle = value.title; baseBody = value.body;
            if (disposed) return true;
            const current = snapshot(); state.pageDirty = current.title !== baseTitle || current.body !== baseBody;
            status.textContent = state.pageDirty ? 'Nog niet opgeslagen' : 'Alles opgeslagen'; errorBox.hidden = true;
            const item = state.pages.find(p => p.id === id); if (item) { item.title = baseTitle; renderPageTree(); }
            return true;
          } catch (error) {
            if (disposed) return false;
            conflict = error.status === 409;
            state.pageDirty = true; status.textContent = 'Niet opgeslagen'; errorBox.hidden = false;
            $('p',errorBox).textContent = error.message + (conflict ? ' Je tekst blijft hier staan. Download je tekst voordat je de serverversie laadt.' : ' Je tekst blijft hier staan. Probeer opnieuw.');
            $('[data-retry-save]').hidden = conflict;
            return false;
          } finally { saving = null; }
        })();
        const ok = await saving;
        if (ok && state.pageDirty && !disposed) return save();
        return ok;
      }
      pageSave = {flush:save, dispose() { disposed = true; clearTimeout(timer); }};
      title.addEventListener('input', markDirty);
      $('[data-retry-save]').addEventListener('click', save);
      $('[data-download-draft]').addEventListener('click', () => {
        const value = snapshot(), url = URL.createObjectURL(new Blob([`# ${value.title}\n\n${value.body}`],{type:'text/markdown;charset=utf-8'}));
        const a = document.createElement('a'); a.href=url; a.download='familiepagina-concept.md'; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
      });
      $('[data-reload-page]').addEventListener('click', () => {
        if (!confirm('Je eigen niet-opgeslagen wijzigingen vervangen door de serverversie? Download eerst je tekst als je die wilt bewaren.')) return;
        state.pageDirty=false; disposeEditor(); openPage(id);
      });
    }
    $('[data-comments]').innerHTML = data.comments.length ? data.comments.map((comment) => `<article class="comment"><div class="comment-meta"><b>${escapeHtml(comment.username)}</b><time>${escapeHtml(new Date(comment.created_at).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' }))}</time></div><p>${escapeHtml(comment.body)}</p></article>`).join('') : '<p class="subtle">Nog geen reacties. Begin het gesprek.</p>';
    $('[data-comment-form]').hidden = false;
    $('[data-attachments]').hidden = false;
    $('[data-file-list]').innerHTML = data.files.length ? data.files.map((file) => `<li class="file-row"><span>↳</span><a href="/api/files/${encodeURIComponent(file.id)}" target="_blank" rel="noreferrer">${escapeHtml(file.filename)}</a><small>${formatBytes(file.size)}</small><button type="button" class="file-insert" data-insert-file="${escapeHtml(file.id)}" aria-label="Voeg ${escapeHtml(file.filename)} in de tekst in" title="In de tekst invoegen">＋</button></li>`).join('') : '<li class="subtle">Nog geen bestanden toegevoegd.</li>';
    $$('[data-insert-file]').forEach(button=>button.addEventListener('click',()=>{const file=data.files.find(item=>item.id===button.dataset.insertFile); if(file) pageEditor?.insertPageFiles([file]);}));
    $$('[data-open-page]').forEach((button) => button.classList.toggle('is-active', button.dataset.openPage === id));
  }

  function bindPageChecklist(page) {
    const root = $('.page-prose');
    $$('[data-page-check]', root).forEach((checkbox) => checkbox.addEventListener('change', async () => {
      const checked = checkbox.checked;
      const line = Number(checkbox.dataset.pageCheck);
      const editButton = $('[data-edit-page]');
      $$('[data-page-check]', root).forEach((input) => { input.disabled = true; });
      editButton.disabled = true;
      try {
        const result = await api(`/api/pages/${encodeURIComponent(page.id)}/checklist`, {method:'PATCH', body:JSON.stringify({line, checked, expected:page.body.split(/\r?\n/)[line]})});
        if (root.isConnected && state.pageId === page.id && !state.pageDirty) {
          root.innerHTML = renderMarkdown(result.page.body);
          $('#page-body').value = result.page.body;
          const updated = `Laatst bijgewerkt door ${result.page.updated_by} · ${new Date(result.page.updated_at).toLocaleDateString('nl-NL')}`;
          $('.page-reading > .subtle').textContent = updated;
          $('.page-savebar .subtle').textContent = updated;
          bindPageChecklist(result.page);
          $(`[data-page-check="${line}"]`, root)?.focus({preventScroll:true});
        }
        toast(checked ? 'Afgevinkt en opgeslagen.' : 'Vinkje verwijderd en opgeslagen.');
      } catch (error) {
        checkbox.checked = !checked;
        toast(error.message);
        if (error.message.startsWith('Deze checklist') && root.isConnected && !state.pageDirty) await openPage(page.id);
      } finally {
        $$('[data-page-check]', root).forEach((input) => { input.disabled = false; });
        editButton.disabled = false;
      }
    }));
  }

  // Escape every user-written fragment; only our own formatting becomes HTML.
  function inlineMarkdown(input) {
    const pattern = /\[([^\]\n]+)\]\(<?(https?:\/\/[^\s)>]+)>?\)|\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
    let output = '', end = 0;
    for (const match of input.matchAll(pattern)) {
      output += escapeHtml(input.slice(end, match.index));
      if (match[1]) output += `<a href="${escapeHtml(match[2])}" target="_blank" rel="noreferrer">${escapeHtml(match[1])} ↗</a>`;
      else if (match[3]) output += `<strong>${escapeHtml(match[3])}</strong>`;
      else output += `<code>${escapeHtml(match[4])}</code>`;
      end = match.index + match[0].length;
    }
    return output + escapeHtml(input.slice(end));
  }
  function renderMarkdown(body) {
    if (!body.trim()) return '<p class="subtle">Nog een leeg blad. Klik op Bewerken en maak er iets van.</p>';
    const lines = body.split(/\r?\n/);
    const html = [];
    const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((cell) => cell.trim());
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      if (line.includes('|') && lines[i + 1] && /^[\s|:-]+$/.test(lines[i + 1]) && lines[i + 1].includes('---')) {
        html.push('<div class="table-scroll"><table><thead><tr>' + cells(line).map((cell) => `<th>${inlineMarkdown(cell)}</th>`).join('') + '</tr></thead><tbody>');
        i += 2;
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
          html.push('<tr>' + cells(lines[i]).map((cell) => `<td>${inlineMarkdown(cell)}</td>`).join('') + '</tr>'); i++;
        }
        i--; html.push('</tbody></table></div>'); continue;
      }
      const heading = line.match(/^(#{1,6})\s+(.+)$/);
      if (heading) { const level = Math.min(heading[1].length + 2, 6); html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`); continue; }
      if (/^[-*_]{3,}$/.test(line)) { html.push('<hr>'); continue; }
      if (/^(?:[-*]\s+|\d+\.\s+)/.test(line)) {
        const tag = /^\d+\.\s+/.test(line) ? 'ol' : 'ul';
        html.push(`<${tag}>`);
        while (i < lines.length && /^(?:[-*]\s+|\d+\.\s+)/.test(lines[i].trim())) {
          const item = lines[i].trim().replace(/^(?:[-*]\s+|\d+\.\s+)/, '');
          const check = item.match(/^\[([ xX])\](?:\s+(.*))?$/);
          if (check) {
            const label = check[2] || 'Checklist-item';
            html.push(`<li class="page-check-row"><input type="checkbox" data-page-check="${i}" id="page-check-${i}" aria-label="${escapeHtml(label.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'))}" ${check[1].toLowerCase() === 'x' ? 'checked' : ''}><div class="page-check-text">${inlineMarkdown(label)}</div></li>`);
          } else html.push(`<li>${inlineMarkdown(item)}</li>`);
          i++;
        }
        i--; html.push(`</${tag}>`); continue;
      }
      html.push(`<p>${inlineMarkdown(line)}</p>`);
    }
    return html.join('');
  }

  function formatBytes(value) { return value < 1024 ? `${value} B` : `${(value / 1024).toFixed(0)} KB`; }
  function bytesToBase64(buffer) { let binary = ''; const bytes = new Uint8Array(buffer); for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary); }

  function markPageDirty() {
    state.pageDirty = true;
    $('.page-savebar .subtle').textContent = 'Nog niet opgeslagen';
  }
  window.addEventListener('beforeunload', (event) => { if (pageUploading || state.pageDirty || chat.attachments.length || chat.sending || profileSettings.saving || tasks.saving || taskEditorDirty()) { event.preventDefault(); event.returnValue = ''; } });

  function closeMobileMenu() {
    const dialog = $('#mobile-menu');
    if (dialog.open) dialog.close();
    document.body.classList.remove('menu-open');
    $('[data-mobile-menu-open]').setAttribute('aria-expanded','false');
  }
  $('[data-mobile-menu-open]').addEventListener('click', () => {
    $('#mobile-menu').showModal(); document.body.classList.add('menu-open');
    $('[data-mobile-menu-open]').setAttribute('aria-expanded','true');
  });
  $('[data-mobile-menu-close]').addEventListener('click', closeMobileMenu);
  $('#mobile-menu').addEventListener('close', closeMobileMenu);
  $('#mobile-menu').addEventListener('click', event => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.target === event.currentTarget && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) closeMobileMenu();
  });
  matchMedia('(max-width:700px)').addEventListener('change', event => { if (!event.matches) closeMobileMenu(); });
  function navigate(name) {
    chooseAssignee(null);
    closeMobileMenu();
    if (!['home', 'agenda', 'taken', 'pagina', 'vakanties', 'chat', 'bestanden'].includes(name)) name = 'home';
    history.replaceState(null, '', `#${name}`);
    document.body.classList.toggle('chat-screen', name === 'chat' && !!state.user);
    syncChatViewport();
    $$('[data-view]').forEach((view) => { view.hidden = view.dataset.view !== name; });
    $$('.main-nav [data-route], .mobile-popup-nav [data-route]').forEach((item) => {
      item.classList.toggle('is-active', item.dataset.route === name);
      if (item.dataset.route === name) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
    });
    $('[data-page-title]').textContent = ({ home: 'Home', agenda: 'Agenda', taken: 'Gezinstaken', pagina: 'Pagina’s', vakanties: 'Vakanties', chat: 'Chat', bestanden: 'Bestanden' })[name];
    if (state.user && name === 'home') loadWeather();
    if (state.user && (name === 'home' || name === 'agenda')) resumeAgenda();
    if (state.user && ['home','taken'].includes(name)) refreshTasks();
    if (state.user && name === 'pagina') loadPages();
    if (state.user && name === 'bestanden') loadCloudStatus();
    if (state.user && name === 'chat') { renderChat(true); loadChat(); markChatRead(); }
    window.scrollTo({ top: 0, behavior: 'instant' });
  }
  $$('[data-route]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); navigate(link.dataset.route); }));
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1)));

  $('[data-toggle-password]').addEventListener('click', (event) => {
    const input = $('#password');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    event.currentTarget.textContent = show ? 'Verberg' : 'Toon';
    event.currentTarget.setAttribute('aria-pressed', String(show));
    event.currentTarget.setAttribute('aria-label', show ? 'Wachtwoord verbergen' : 'Wachtwoord tonen');
  });
  $('[data-login]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const loginForm = event.currentTarget;
    const form = new FormData(loginForm);
    $('[data-login-error]').textContent = '';
    try {
      await busy($('[type="submit"]', loginForm), async () => {
        await api('/api/login', { method: 'POST', body: JSON.stringify({ username: form.get('username'), password: form.get('password') }) });
        const session = await api('/api/me');
        if (!session.authenticated) throw new Error('De login kon niet worden bewaard. Sta cookies voor deze website toe en probeer opnieuw.');
        loginForm.reset();
        $('#password').type = 'password';
        $('[data-toggle-password]').textContent = 'Toon';
        $('[data-toggle-password]').setAttribute('aria-pressed', 'false');
        $('[data-toggle-password]').setAttribute('aria-label', 'Wachtwoord tonen');
        showApp(session.username, session.config);
        navigate(location.hash.slice(1) || 'home');
      }, 'Even binnenlaten…');
    } catch (error) { $('[data-login-error]').textContent = error.message; }
  });
  $$('[data-logout]').forEach((button) => button.addEventListener('click', async () => {
    if (!await flushPage()) return;
    disposeEditor();
    try {
      await api('/api/logout', { method: 'POST', body: '{}' });
      // The server deletes this session's subscriptions, even if local cleanup fails.
      push.registration?.pushManager.getSubscription().then(subscription => subscription?.unsubscribe()).catch(() => {});
      state.pageDirty = false;
      state.pageId = '';
      state.pages = [];
      $('[data-page-editor]').replaceChildren();
      showLogin();
    } catch (error) { toast(error.message); }
  }));

  $('[data-quick-task]').addEventListener('submit', async event => {
    event.preventDefault();
    const form = event.currentTarget, input = form.elements.title, title = input.value.trim();
    if (!title) return;
    try { await busy($('button',form), async () => {
      await addTask(title,'today');
      if (input.value.trim() === title) input.value = '';
      input.focus();
    }, '…'); } catch (error) {toast(error.message);}
  });
  $('[data-new-page]').addEventListener('click', (event) => createPage(null, event.currentTarget));
  $('[data-comment-form]').addEventListener('submit', async (event) => {
    event.preventDefault(); if (!state.pageId) return;
    const commentForm = event.currentTarget;
    const pageId = state.pageId;
    const body = $('textarea[name="body"]', commentForm);
    if (!body.value.trim()) return;
    const submittedBody = body.value;
    try { await busy($('button', commentForm), async () => {
      await api(`/api/pages/${encodeURIComponent(pageId)}/comments`, { method: 'POST', body: JSON.stringify({ body: submittedBody }) });
      if (body.value === submittedBody) body.value = '';
      if (state.pageId === pageId) await openPage(pageId, true);
      toast('Reactie geplaatst.');
    }, 'Plaatsen…'); } catch (error) { toast(error.message); }
  });
  function uploadPageFile(pageId, file, progress) {
    const uploadId=crypto.randomUUID();
    const attempt=()=>new Promise((resolve,reject)=>{
      const request=new XMLHttpRequest();
      request.open('POST', `/api/pages/${encodeURIComponent(pageId)}/files`);
      request.setRequestHeader('Content-Type','application/octet-stream');
      request.setRequestHeader('X-File-Name',encodeURIComponent(file.name));
      request.setRequestHeader('X-Page-Upload-ID',uploadId);
      request.timeout=10*60*1000;
      request.upload.onprogress=event=>{if(event.lengthComputable) progress(`Uploaden ${Math.round(event.loaded/event.total*100)}%`);};
      request.upload.onload=()=>progress('Opslaan op server…');
      request.onload=()=>{
        let data; try {data=JSON.parse(request.responseText);} catch {}
        if(request.status>=200 && request.status<300 && data?.item?.size===file.size && /^[a-f0-9]{32}$/.test(data.item.id)) {resolve(data.item);return;}
        const error=new Error(data?.error || (request.status===413 ? 'Dit bestand is te groot voor de server.' : 'De server heeft de upload niet bevestigd. Probeer opnieuw.'));
        error.retryable=request.status>=500; reject(error);
      };
      request.onerror=request.ontimeout=()=>{const error=new Error('De upload is onderbroken. Probeer het bestand opnieuw.');error.retryable=true;reject(error);};
      request.send(file);
    });
    return attempt().catch(error=>{if(!error.retryable) throw error;progress('Verbinding herstellen…');return attempt();});
  }
  $('[data-upload]').addEventListener('change', event => {
    const input=event.currentTarget, files=Array.from(input.files); input.value='';
    pageEditor?.uploadPageFiles(files);
  });

  const cloud = {generation:0, pending:false, polling:false, connected:false, searchRequest:0};
  function resetCloud() {
    cloud.generation++;cloud.searchRequest++;cloud.pending=false;cloud.polling=false;cloud.connected=false;
    $('[data-cloud-results]').replaceChildren();$('[data-cloud-message]').textContent='';
    $('[data-cloud-search]').reset();$('[data-cloud-approval]').hidden=true;$('[data-cloud-login]').removeAttribute('href');
    $$('input,button',$('[data-cloud-search]')).forEach(node=>{node.disabled=true;});
  }
  function renderCloudStatus(data) {
    cloud.pending=!!data.pending;cloud.connected=!!data.connected;
    $('[data-cloud-status]').textContent=data.connected ? `Verbonden met ${data.account || 'je Nextcloud-account'}.` : data.pending ? 'Wacht op jouw toestemming in Nextcloud.' : 'Verbind jouw Nextcloud-account om bestanden te zoeken.';
    $('[data-cloud-connect]').hidden=!!data.connected || !!data.pending;
    $('[data-cloud-disconnect]').hidden=!data.connected && !data.pending;
    $('[data-cloud-approval]').hidden=!data.pending;
    if(data.login_url) $('[data-cloud-login]').href=data.login_url;
    if(!data.pending) $('[data-cloud-login]').removeAttribute('href');
    $$('input,button',$('[data-cloud-search]')).forEach(node=>{node.disabled=!data.connected;});
  }
  async function loadCloudStatus() {
    const generation=cloud.generation;
    try {const data=await api('/api/nextcloud/status');if(generation===cloud.generation) renderCloudStatus(data);}
    catch(error) {if(generation===cloud.generation) $('[data-cloud-status]').textContent=error.message;}
  }
  async function pollCloud() {
    if(!state.user || !cloud.pending || cloud.polling || document.hidden) return;
    cloud.polling=true;const generation=cloud.generation;
    try {
      const data=await api('/api/nextcloud/poll',{method:'POST',body:'{}'});
      if(generation!==cloud.generation) return;
      if(data.connected) {renderCloudStatus(data);toast('Nextcloud verbonden. Je kunt nu zoeken.');}
      else if(!data.pending) {renderCloudStatus(data);$('[data-cloud-status]').textContent='Het verbindingsverzoek is verlopen. Klik opnieuw op Verbinden.';}
    } catch(error) {if(generation===cloud.generation) $('[data-cloud-status]').textContent=error.message;}
    finally {if(generation===cloud.generation) cloud.polling=false;}
  }
  $('[data-cloud-connect]').addEventListener('click',async event=>{
    const generation=cloud.generation;
    try {await busy(event.currentTarget,async()=>{
      const data=await api('/api/nextcloud/connect',{method:'POST',body:'{}'});
      if(generation===cloud.generation) renderCloudStatus({...data,connected:false,pending:true});
    },'Verbinden…');}catch(error){if(generation===cloud.generation) $('[data-cloud-status]').textContent=error.message;}
  });
  $('[data-cloud-check]').addEventListener('click',pollCloud);
  $('[data-cloud-disconnect]').addEventListener('click',async event=>{
    if(!confirm('Je Nextcloud-koppeling voor dit dashboard verbreken?')) return;
    const generation=cloud.generation;
    try {await busy(event.currentTarget,async()=>{
      const data=await api('/api/nextcloud/disconnect',{method:'POST',body:'{}'});
      if(generation!==cloud.generation) return;
      resetCloud();renderCloudStatus(data);
      if(!data.revoked) $('[data-cloud-status]').textContent='Koppeling verwijderd. Trek de app-toegang ook in via Nextcloud → Persoonlijke instellingen → Beveiliging.';
    });}catch(error){$('[data-cloud-status]').textContent=error.message;}
  });
  $('[data-cloud-search]').addEventListener('submit',async event=>{
    event.preventDefault();const form=event.currentTarget,term=$('[name="term"]',form).value.trim();
    if(term.length<2) return;
    const generation=cloud.generation,request=++cloud.searchRequest;
    $('[data-cloud-results]').replaceChildren();$('[data-cloud-message]').textContent='Zoeken…';
    try {await busy($('button',form),async()=>{
      const data=await api('/api/nextcloud/search',{method:'POST',body:JSON.stringify({term})});
      if(generation!==cloud.generation || request!==cloud.searchRequest) return;
      $('[data-cloud-message]').textContent=data.items.length ? `${data.items.length} bestanden gevonden.${data.has_more ? ' Er zijn meer resultaten; maak je zoekopdracht specifieker.' : ''}` : 'Geen bestanden gevonden. Probeer een andere bestandsnaam.';
      $('[data-cloud-results]').innerHTML=data.items.map(item=>`<li><a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.path)}</small></span><span aria-hidden="true">↗</span></a></li>`).join('');
    },'Zoeken…');}catch(error){if(generation===cloud.generation && request===cloud.searchRequest) $('[data-cloud-message]').textContent=error.message;}
    finally {$('button',form).disabled=!cloud.connected;}
  });
  setInterval(pollCloud,3500);
  document.addEventListener('visibilitychange',()=>{if(!document.hidden && state.user && location.hash==='#bestanden') {if(cloud.pending) pollCloud();else loadCloudStatus();}});

  function syncChatViewport() {
    const viewport = window.visualViewport;
    document.documentElement.style.setProperty('--chat-viewport-height', `${viewport?.height || innerHeight}px`);
    document.documentElement.style.setProperty('--chat-viewport-top', `${viewport?.offsetTop || 0}px`);
    document.body.classList.toggle('chat-keyboard', (viewport?.height || innerHeight) < 480);
  }
  window.visualViewport?.addEventListener('resize', syncChatViewport);
  window.visualViewport?.addEventListener('scroll', syncChatViewport);
  window.addEventListener('resize', syncChatViewport);
  syncChatViewport();
  const supportsPush = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && isSecureContext;
  function renderProfileControls() {
    $('[data-profile-actions]').hidden = !profileSettings.file;
    $('[data-profile-save]').disabled = profileSettings.saving;
    $('[data-profile-save]').textContent = profileSettings.saving ? 'Foto opslaan…' : 'Foto opslaan';
    $('[data-profile-choose]').disabled = profileSettings.saving;
    $('[data-profile-cancel]').disabled = profileSettings.saving;
    $('[data-settings-close]').disabled = profileSettings.saving;
  }
  function profileStatus(message = '', isError = false) {
    const node = $('[data-profile-status]');
    node.textContent = message;
    node.classList.toggle('is-error', isError);
  }
  function resetProfileDraft() {
    profileSettings.generation++;
    if (profileSettings.previewUrl) URL.revokeObjectURL(profileSettings.previewUrl);
    profileSettings.previewUrl = ''; profileSettings.file = null;
    $('#profile-photo').value = '';
    const preview = $('[data-profile-preview]');
    delete preview.dataset.avatarVersion;
    if (state.user) renderAvatar(preview, state.user); else preview.replaceChildren();
    renderProfileControls();
    profileStatus();
  }
  $$('[data-settings-open]').forEach(button => button.addEventListener('click', () => {
    closeMobileMenu();
    resetProfileDraft();
    $('[data-profile-name]').textContent = state.user;
    renderNotificationSettings();
    $('[data-settings-dialog]').showModal();
    $('[data-settings-dialog]').scrollTop = 0;
    if (!push.loading && !push.config?.available) setupNotifications();
  }));
  $('[data-settings-close]').addEventListener('click', () => { if (!profileSettings.saving) $('[data-settings-dialog]').close(); });
  $('[data-settings-dialog]').addEventListener('cancel', event => { if (profileSettings.saving) event.preventDefault(); });
  $('[data-settings-dialog]').addEventListener('close', () => {
    resetProfileDraft();
    if (matchMedia('(max-width:700px)').matches && state.user) $('[data-mobile-menu-open]').focus();
  });
  $('[data-profile-choose]').addEventListener('click', () => $('#profile-photo').click());
  $('[data-profile-cancel]').addEventListener('click', resetProfileDraft);
  $('#profile-photo').addEventListener('change', event => {
    const file = event.currentTarget.files[0];
    if (!file || profileSettings.saving) return;
    resetProfileDraft();
    if (file.size > 10 * 1024 * 1024 || !file.size) { profileStatus('Kies een foto van maximaal 10 MB.', true); return; }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) && !(file.type === '' && /\.(jpe?g|png|webp)$/i.test(file.name))) {
      profileStatus('Kies een JPG-, PNG- of WebP-foto.', true); return;
    }
    const generation = profileSettings.generation;
    const url = URL.createObjectURL(file);
    profileSettings.previewUrl = url;
    const image = new Image();
    image.alt = `Voorbeeld van de nieuwe profielfoto van ${state.user}`;
    image.onload = () => {
      if (generation !== profileSettings.generation) return;
      if (image.naturalWidth * image.naturalHeight > 40000000) {
        resetProfileDraft(); profileStatus('Kies een foto van maximaal 40 megapixels.', true); return;
      }
      profileSettings.file = file;
      $('[data-profile-preview]').replaceChildren(image);
      renderProfileControls();
      profileStatus('Dit is je nieuwe foto. Klik op Foto opslaan om hem te gebruiken.');
    };
    image.onerror = () => {
      if (generation !== profileSettings.generation) return;
      resetProfileDraft(); profileStatus('Deze foto kan niet worden geopend. Kies een andere foto.', true);
    };
    image.src = url;
  });
  $('[data-profile-form]').addEventListener('submit', async event => {
    event.preventDefault();
    if (!profileSettings.file || profileSettings.saving) return;
    const generation = profileSettings.generation;
    const file = profileSettings.file;
    profileSettings.saving = true; renderProfileControls(); profileStatus('Foto opslaan…');
    try {
      const data = await api('/api/profile/avatar', {method: 'POST', body: file, headers: {'Content-Type': file.type || 'application/octet-stream'}});
      if (generation !== profileSettings.generation) return;
      applyProfileVersions(data.profiles);
      profileSettings.saving = false;
      resetProfileDraft();
      profileStatus('Je profielfoto is opgeslagen.');
    } catch (error) {
      if (generation === profileSettings.generation) profileStatus(error.message, true);
    } finally {
      if (generation === profileSettings.generation) { profileSettings.saving = false; renderProfileControls(); }
    }
  });
  function syncPushState(count = push.unread) {
    push.unread = count == null ? null : Math.max(0, Number(count) || 0);
    push.registration?.active?.postMessage({type: 'thuis-push-state', subscriptionId: push.subscriptionId, username: state.user, unread: push.unread});
  }
  function renderNotificationSettings(message = '') {
    const toggle = $('[data-notifications-toggle]');
    toggle.textContent = push.enabled ? 'Zet meldingen uit' : 'Zet meldingen aan';
    toggle.disabled = push.loading || !supportsPush() || !push.config?.available || (!push.enabled && Notification.permission === 'denied');
    $('[data-notifications-status]').textContent = message || (window.webkit?.messageHandlers?.thuisBadge
      ? 'De Mac-app toont het aantal ongelezen berichten op het Dock-icoon. Chatmeldingen kun je op je Android-telefoon aanzetten.'
      : !supportsPush()
      ? 'Open Thuis in Chrome op je Android-telefoon om meldingen aan te zetten.'
      : push.loading ? 'Even laden…' : Notification.permission === 'denied'
        ? 'Meldingen zijn geblokkeerd. Sta ze toe bij de site- of appinstellingen van je telefoon en open Thuis opnieuw.'
        : !push.config?.available ? 'Meldingen zijn tijdelijk niet beschikbaar. Open dit venster later opnieuw.'
          : push.enabled ? 'Meldingen staan aan op dit toestel.' : 'Meldingen staan uit op dit toestel.');
  }
  async function savePushSubscription(subscription, generation) {
    const data = await api('/api/push/subscribe', {method: 'POST', body: JSON.stringify({subscription: subscription.toJSON()})});
    if (generation !== push.generation) return;
    push.subscriptionId = data.subscription_id;
    push.enabled = true;
    syncPushState();
  }
  async function setupNotifications() {
    const generation = ++push.generation;
    push.enabled = false; push.subscriptionId = ''; push.loading = true;
    renderNotificationSettings();
    if (!supportsPush() || window.webkit?.messageHandlers?.thuisBadge) {
      push.loading = false; renderNotificationSettings(); return;
    }
    try {
      const [config, registration] = await Promise.all([
        api('/api/push/config'), navigator.serviceWorker.register('/sw.js', {scope: '/', updateViaCache: 'none'})
      ]);
      await navigator.serviceWorker.ready;
      if (generation !== push.generation) return;
      push.config = config; push.registration = registration;
      const subscription = await registration.pushManager.getSubscription();
      if (generation !== push.generation) return;
      if (subscription && Notification.permission === 'granted' && config.available) {
        await savePushSubscription(subscription, generation);
      } else syncPushState();
    } catch {
      if (generation === push.generation) push.config = null;
    } finally {
      if (generation === push.generation) { push.loading = false; renderNotificationSettings(); }
    }
  }
  $('[data-notifications-toggle]').addEventListener('click', async () => {
    if (push.loading || !supportsPush() || !push.config?.available) return;
    const generation = push.generation;
    // Ask only following an explicit tap, before awaiting any network work.
    const permission = push.enabled ? null : Notification.requestPermission();
    push.loading = true; renderNotificationSettings();
    let message = '';
    try {
      if (push.enabled) {
        const subscription = await push.registration.pushManager.getSubscription();
        if (subscription) {
          await api('/api/push/unsubscribe', {method: 'POST', body: JSON.stringify({endpoint: subscription.endpoint})});
          await subscription.unsubscribe();
        }
        push.enabled = false; push.subscriptionId = ''; syncPushState();
      } else if (await permission === 'granted') {
        const key = push.config.public_key;
        const applicationServerKey = Uint8Array.from(atob(key.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - key.length % 4) % 4)), char => char.charCodeAt(0));
        let subscription = await push.registration.pushManager.getSubscription();
        let created = false;
        if (!subscription) {
          subscription = await push.registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey});
          created = true;
        }
        try { await savePushSubscription(subscription, generation); }
        catch (error) {
          if (created) await subscription.unsubscribe().catch(() => {});
          throw error;
        }
      } else message = 'Meldingen zijn niet aangezet. Je kunt dit later opnieuw kiezen.';
    } catch (error) { message = error.message || 'Meldingen aanzetten lukt even niet. Probeer opnieuw.'; }
    finally {
      if (generation === push.generation) { push.loading = false; renderNotificationSettings(message); }
    }
  });
  navigator.serviceWorker?.addEventListener('message', async event => {
    if (event.data?.type === 'thuis-chat-updated') loadChat();
    if (event.data?.type === 'thuis-open-chat' && await flushPage()) location.hash = 'chat';
    if (event.data?.type === 'thuis-open-tasks' && await flushPage()) { location.hash = 'taken'; refreshTasks(); }
  });
  function setChatBadge(count, syncNotifications = true) {
    count = Math.max(0, Math.floor(Number(count) || 0));
    window.webkit?.messageHandlers?.thuisBadge?.postMessage(count);
    if ('setAppBadge' in navigator) {
      (count ? navigator.setAppBadge(count) : navigator.clearAppBadge()).catch(() => {});
    }
    if (syncNotifications) syncPushState(count);
    $$('[data-chat-badge]').forEach(badge => {
      badge.textContent = count > 99 ? '99+' : String(count);
      badge.hidden = !count;
    });
    $$('.main-nav [data-route="chat"], .mobile-popup-nav [data-route="chat"]').forEach(link => link.setAttribute('aria-label', count ? `Chat, ${count} ongelezen berichten` : 'Chat'));
    $('[data-mobile-menu-open]').setAttribute('aria-label', count ? `Menu openen, ${count} ongelezen chatberichten` : 'Menu openen');
    document.title = count ? `(${count}) Thuis — samen thuis.` : 'Thuis — samen thuis.';
  }
  const chat = { items: [], peer: '', peerRead: 0, lastRead: 0, loading: false, generation: 0, initialized: false, pending: null, older: false, ready: false, attachments: [], sending: false, upload: null };
  const chatVisible = () => state.user && location.hash === '#chat' && !document.hidden && window.__thuisMacActive !== false;
  const chatAtBottom = () => { const box = $('[data-chat-scroll]'); return box.scrollHeight - box.scrollTop - box.clientHeight < 70; };
  function resetChat() {
    chat.upload?.abort(); chat.upload = null; chat.attachments = []; chat.sending = false;
    chat.generation++; chat.items = []; chat.peer = ''; chat.peerRead = 0; chat.lastRead = 0;
    chat.loading = false; chat.initialized = false; chat.pending = null; chat.older = false;
    $('[data-chat-messages]').replaceChildren(); $('[data-chat-form]').reset();
    $('[data-chat-setup-form]').reset(); $('[data-chat-setup]').hidden = true;
    setChatBadge(0, false); $('[data-chat-new]').hidden = true;
    $('[data-chat-error]').textContent = '';
    renderChatDraft();
    $('[data-chat-upload-status]').textContent = '';
    $('[data-chat-file-dialog]').close();
    $('[data-chat-file-image]').removeAttribute('src');
  }
  function chatFileSize(size) {
    if (size < 1024) return `${size} B`;
    return size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toLocaleString('nl-NL', {maximumFractionDigits: 1})} MB`
      : `${Math.max(1, Math.ceil(size / 1024))} kB`;
  }
  function chatAttachmentsMarkup(items = []) {
    return items.length ? `<div class="chat-attachments">${items.map(file => {
      const url = `/api/chat/files/${encodeURIComponent(file.id)}`;
      const name = escapeHtml(file.filename);
      const image = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.media_type);
      return `<div class="chat-attachment">${image ? `<button type="button" class="chat-image-preview" data-chat-image="${escapeHtml(url)}" data-filename="${name}" aria-label="Bekijk ${name}"><img src="${url}?preview=1" alt="${name}" loading="lazy"></button>` : ''}<a class="chat-file-link" href="${url}" target="_blank" rel="noopener noreferrer" download="${name}" aria-label="Download ${name}"><span aria-hidden="true">📎</span><span><b>${name}</b><small>${chatFileSize(file.size)} · Downloaden</small></span><span aria-hidden="true">↓</span></a></div>`;
    }).join('')}</div>` : '';
  }
  function renderChatDraft() {
    const list = $('[data-chat-draft-files]');
    list.hidden = !chat.attachments.length;
    list.innerHTML = chat.attachments.map(item => `<div class="chat-draft-file"><span aria-hidden="true">📎</span><span><b>${escapeHtml(item.file.name)}</b><small>${chatFileSize(item.file.size)}${item.uploaded ? ' · Klaar om te versturen' : ''}</small></span><button type="button" data-remove-chat-file="${item.key}" aria-label="Verwijder ${escapeHtml(item.file.name)} uit dit bericht" ${chat.sending ? 'disabled' : ''}>×</button></div>`).join('');
    $('[data-chat-attach]').disabled = chat.sending || chat.attachments.length >= 5;
    $('#chat-message').disabled = chat.sending;
    $('#chat-files').disabled = chat.sending;
    $('[data-chat-send]').disabled = chat.sending;
    $('[data-chat-send]').textContent = chat.sending ? '…' : 'Verstuur ↗';
  }
  $('[data-chat-attach]').addEventListener('click', () => $('#chat-files').click());
  $('#chat-files').addEventListener('change', event => {
    if (chat.sending) return;
    const errors = [];
    for (const file of event.currentTarget.files) {
      if (chat.attachments.length >= 5) { errors.push('Maximaal vijf bestanden per bericht.'); break; }
      if (file.size > 25 * 1024 * 1024) { errors.push(`${file.name} is groter dan 25 MB.`); continue; }
      chat.attachments.push({key: crypto.randomUUID(), file, uploaded: null});
    }
    event.currentTarget.value = '';
    $('[data-chat-error]').textContent = errors.join(' ');
    renderChatDraft();
  });
  $('[data-chat-draft-files]').addEventListener('click', event => {
    const button = event.target.closest('[data-remove-chat-file]');
    if (!button || chat.sending) return;
    chat.attachments = chat.attachments.filter(item => item.key !== button.dataset.removeChatFile);
    renderChatDraft();
  });
  $('[data-chat-messages]').addEventListener('click', event => {
    const button = event.target.closest('[data-chat-image]');
    if (!button) return;
    $('[data-chat-file-title]').textContent = button.dataset.filename;
    const image = $('[data-chat-file-image]');
    image.alt = button.dataset.filename; image.src = `${button.dataset.chatImage}?preview=1`;
    const link = $('[data-chat-file-download]');
    link.href = button.dataset.chatImage; link.download = button.dataset.filename;
    $('[data-chat-file-dialog]').showModal();
  });
  $('[data-chat-file-close]').addEventListener('click', () => $('[data-chat-file-dialog]').close());
  $('[data-chat-file-dialog]').addEventListener('close', () => $('[data-chat-file-image]').removeAttribute('src'));
  function uploadChatFile(item, generation, index, total) {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      chat.upload = request;
      request.open('POST', '/api/chat/attachments');
      request.timeout = 180000;
      request.setRequestHeader('Content-Type', 'application/octet-stream');
      request.setRequestHeader('X-File-Name', encodeURIComponent(item.file.name));
      request.setRequestHeader('X-Chat-Upload-ID', item.key);
      const progress = text => { if (generation === chat.generation) $('[data-chat-upload-status]').textContent = text; };
      progress(`Bestand ${index} van ${total} uploaden…`);
      request.upload.onprogress = event => {
        if (event.lengthComputable) progress(`Bestand ${index} van ${total} · ${Math.round(event.loaded / event.total * 100)}%`);
      };
      request.upload.onload = () => progress(`Bestand ${index} van ${total} opslaan…`);
      request.onload = () => {
        let data;
        try { data = JSON.parse(request.responseText); } catch { /* A proxy may return an HTML error. */ }
        if (request.status >= 200 && request.status < 300 && data?.item) resolve(data.item);
        else reject(new Error(request.status === 401 ? 'Je sessie is verlopen. Log opnieuw in.'
          : request.status === 413 ? 'De server weigert deze bestandsgrootte. Kies een kleiner bestand.'
            : data?.error || 'Het bestand kon niet worden opgeslagen. Probeer opnieuw.'));
      };
      request.onerror = () => reject(new Error('De upload is onderbroken. Je bestanden staan nog klaar.'));
      request.ontimeout = () => reject(new Error('De upload duurde te lang. Probeer opnieuw.'));
      request.onabort = () => reject(new Error('Upload afgebroken.'));
      request.onloadend = () => { if (chat.upload === request) chat.upload = null; };
      request.send(item.file);
    });
  }
  function chatTextMarkup(value) {
    const text = String(value || '');
    const pattern = /\b(?:https?:\/\/|www\.)[^\s<>"'`“”‘’]+/gi;
    let html = '', cursor = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      if (start && /[\p{L}\p{N}_@]/u.test(text[start - 1])) continue;
      let label = match[0];
      // Keep sentence punctuation outside the link, preserving balanced URL brackets.
      const pairs = {')':'(', ']':'[', '}':'{'};
      while (label) {
        const last = label.at(-1), opening = pairs[last];
        if (/[.,!?;:…]/.test(last) || (opening && label.split(last).length > label.split(opening).length)) label = label.slice(0, -1);
        else break;
      }
      let url;
      try { url = new URL(/^www\./i.test(label) ? `https://${label}` : label); }
      catch { continue; }
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) continue;
      html += escapeHtml(text.slice(cursor, start));
      html += `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer" title="Openen in een nieuw tabblad">${escapeHtml(label)}</a>`;
      cursor = start + label.length;
    }
    return html + escapeHtml(text.slice(cursor));
  }
  function renderChat(scrollBottom = false) {
    const box = $('[data-chat-scroll]');
    const top = box.scrollTop, height = box.scrollHeight;
    let day = '';
    $('[data-chat-messages]').innerHTML = chat.items.length ? chat.items.map((item) => {
      const date = new Date(item.created_at);
      const dateKey = date.toLocaleDateString('nl-NL');
      const divider = dateKey !== day ? `<div class="chat-day">${escapeHtml(prettyDate(date))} ${date.getFullYear()}</div>` : '';
      day = dateKey;
      const own = item.username === state.user;
      const readByPeer = own && chat.peer && chat.peer !== state.user && item.id <= chat.peerRead;
      const receipt = own ? `<span class="chat-receipt ${readByPeer ? 'is-read' : ''}" role="img" aria-label="${readByPeer ? 'Gelezen' : 'Verstuurd'}">${readByPeer ? '✓✓' : '✓'}</span>` : '';
      return `${divider}<div class="chat-message ${own ? 'is-own' : ''}"><b>${escapeHtml(item.username)}</b>${item.body ? `<p>${chatTextMarkup(item.body)}</p>` : ''}${chatAttachmentsMarkup(item.attachments)}<div class="chat-message-meta"><time datetime="${escapeHtml(item.created_at)}">${date.toLocaleTimeString('nl-NL', {hour:'2-digit',minute:'2-digit'})}</time>${receipt}</div></div>`;
    }).join('') : '<div class="chat-empty"><span aria-hidden="true">☺</span><h3>Een klein berichtje.<br>Een fijn begin.</h3><p>Jullie gesprek begint hier.</p></div>';
    $('[data-chat-older]').hidden = !chat.older;
    if (scrollBottom) { box.scrollTop = box.scrollHeight; $('[data-chat-new]').hidden = true; }
    else box.scrollTop = top;
    return { top, height };
  }
  async function markChatRead() {
    if (!chatVisible() || !chatAtBottom() || !chat.items.length) return;
    const latest = chat.items.findLast(item => item.username !== state.user)?.id || 0;
    if (latest <= chat.lastRead) return;
    const generation = chat.generation;
    try {
      await api('/api/chat/read', {method:'POST', body:JSON.stringify({last_id:latest})});
      if (generation !== chat.generation) return;
      chat.lastRead = latest;
      if ((chat.items.findLast(item => item.username !== state.user)?.id || 0) === latest) setChatBadge(0);
    } catch { /* The next poll retries the read receipt. */ }
  }
  async function loadChat() {
    if (!state.user || document.hidden || chat.loading) return;
    chat.loading = true;
    const generation = chat.generation;
    try {
      const latest = chat.items.at(-1)?.id || 0;
      const data = await api(`/api/chat?after=${latest}`);
      if (generation !== chat.generation) return;
      applyProfileVersions(data.profiles);
      const wasBottom = chatAtBottom();
      const changed = data.items.length || data.peer_read !== chat.peerRead || !chat.initialized;
      const ids = new Set(chat.items.map((item) => item.id));
      chat.items.push(...data.items.filter((item) => !ids.has(item.id)));
      chat.items.sort((a,b) => a.id - b.id);
      chat.peer = data.peer; chat.peerRead = data.peer_read; chat.ready = data.peer_ready;
      if (!chat.initialized) chat.older = data.has_older;
      $('[data-chat-peer]').textContent = data.peer;
      renderAvatar($('[data-chat-peer-avatar]'), data.peer);
      $('[data-chat-status]').textContent = data.peer_ready ? 'Jullie gesprek · automatisch bijgewerkt' : `${members[1]} heeft nog een eigen login nodig`;
      $('[data-chat-setup]').hidden = state.user !== members[0] || data.peer_ready;
      setChatBadge(data.unread);
      if (changed) renderChat(!chat.initialized || (chatVisible() && wasBottom));
      if (data.items.length && chat.initialized && chatVisible() && !wasBottom) $('[data-chat-new]').hidden = false;
      chat.initialized = true;
      await markChatRead();
    } catch (error) {
      if (generation === chat.generation) $('[data-chat-status]').textContent = error.message + ' We proberen het opnieuw.';
    } finally { if (generation === chat.generation) chat.loading = false; }
  }
  $('[data-chat-scroll]').addEventListener('scroll', () => {
    if (chatAtBottom()) { $('[data-chat-new]').hidden = true; markChatRead(); }
  });
  $('[data-chat-new]').addEventListener('click', () => {
    const box = $('[data-chat-scroll]'); box.scrollTop = box.scrollHeight;
    $('[data-chat-new]').hidden = true; markChatRead();
  });
  $('[data-chat-older]').addEventListener('click', async (event) => {
    const generation = chat.generation;
    try { await busy(event.currentTarget, async () => {
      const data = await api(`/api/chat?before=${chat.items[0].id}`);
      if (generation !== chat.generation) return;
      const box = $('[data-chat-scroll]'), oldHeight = box.scrollHeight, oldTop = box.scrollTop;
      const ids = new Set(chat.items.map((item) => item.id));
      chat.items.unshift(...data.items.filter((item) => !ids.has(item.id)));
      chat.older = data.has_older; renderChat();
      box.scrollTop = oldTop + box.scrollHeight - oldHeight;
    }, 'Laden…'); } catch (error) { toast(error.message); }
  });
  $('[data-chat-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (chat.sending) return;
    const input = $('#chat-message');
    const body = input.value.trim(); if (!body && !chat.attachments.length) return;
    const files = [...chat.attachments], attachmentKeys = files.map(item => item.key).join(',');
    if (!chat.pending || chat.pending.body !== body || chat.pending.attachmentKeys !== attachmentKeys) chat.pending = {body, client_id:crypto.randomUUID(), attachmentKeys};
    const pending = chat.pending, generation = chat.generation;
    $('[data-chat-error]').textContent = '';
    chat.sending = true; renderChatDraft();
    try {
      for (const [index, item] of files.entries()) {
        if (!item.uploaded) item.uploaded = await uploadChatFile(item, generation, index + 1, files.length);
        if (generation !== chat.generation) return;
        renderChatDraft();
      }
      $('[data-chat-upload-status]').textContent = 'Bericht versturen…';
      await api('/api/chat', {method:'POST', body:JSON.stringify({body: pending.body, client_id: pending.client_id, attachment_ids: files.map(item => item.uploaded.id)})});
      if (generation !== chat.generation) return;
      if (input.value.trim() === body) input.value = '';
      chat.pending = null; chat.attachments = [];
      const box = $('[data-chat-scroll]'); box.scrollTop = box.scrollHeight;
      await loadChat();
    } catch (error) {
      if (generation === chat.generation) $('[data-chat-error]').textContent = `${error.message} Je bericht staat nog klaar; druk op Verstuur om opnieuw te proberen.`;
    } finally {
      if (generation === chat.generation) {
        chat.sending = false; renderChatDraft(); $('[data-chat-upload-status]').textContent = '';
        if (!matchMedia('(pointer: coarse)').matches && chatVisible()) input.focus();
      }
    }
  });
  $('#chat-message').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) {
      event.preventDefault(); $('[data-chat-form]').requestSubmit();
    }
  });
  $('[data-chat-setup-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget, password = $('#member2-password'), confirmInput = $('#member2-confirm');
    if (password.value !== confirmInput.value) { $('[data-setup-status]').textContent = 'De wachtwoorden komen niet overeen.'; return; }
    try { await busy($('button', form), async () => {
      await api('/api/chat/setup', {method:'POST',body:JSON.stringify({password:password.value})});
      form.reset(); $('[data-chat-setup]').hidden = true;
      toast('Het tweede account kan nu inloggen.'); await loadChat();
    }); } catch (error) { $('[data-setup-status]').textContent = error.message; }
  });
  window.addEventListener('thuis-app-visibility', () => { if (window.__thuisMacActive) loadChat(); });
  setInterval(loadChat, 4000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) loadChat(); });

  async function init() {
    try {
      const data = await api('/api/me');
      if (data.authenticated) showApp(data.username, data.config); else showLogin();
    } catch { showLogin(); }
    navigate(location.hash.slice(1) || 'home');
  }
  init();
})();
