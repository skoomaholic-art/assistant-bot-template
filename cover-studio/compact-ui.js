// Cover Studio compact controls: progressive enhancement only.
// Existing fields, ids, handlers, rendering and publishing remain unchanged.
(() => {
  'use strict';
  // IGM uses this same HTML for image rendering. Do not alter its DOM.
  if (new URLSearchParams(location.search).get('render') === '1') return;

  const left = document.querySelector('aside.left .controls');
  const right = document.querySelector('aside.right .controls');
  if (!left || !right || !document.getElementById('pipeBox')) return;

  const sections = [
    { key:'text', side:left, field:'title', title:'Заголовок и текст', icon:'✍️', hint:'Заголовок, подпись и типографика' },
    { key:'background', side:left, field:'backgroundUpload', title:'Фон и фотография', icon:'🖼', hint:'Загрузка, затемнение и кадрирование' },
    { key:'foundation', side:left, field:'preset', title:'Формат и оформление', icon:'🎞', hint:'Шаблон, рубрика и композиция' },
    { key:'logo', side:left, field:'logoUpload', title:'Логотип и сетка', icon:'◈', hint:'Расположение и обрезка 1:1' },
    { key:'slides', side:right, field:'slides', title:'Слайды', icon:'▤', hint:'Список, порядок и копирование' },
    { key:'images', side:right, field:'imgSearch', title:'Кадры и постеры', icon:'🎬', hint:'Поиск по названию или актёру' },
    { key:'publish', side:right, field:'pipeApprove', title:'Согласование и публикация', icon:'📤', hint:'Сохранить и отправить в Telegram' },
    { key:'ai', side:right, field:'aiFactory', title:'ИИ-редактор', icon:'✨', hint:'Создать текст, карусель и стиль' },
    { key:'carousel', side:right, field:'buildCarousel', title:'Автосборка карусели', icon:'▦', hint:'Создать слайды из списка' },
    { key:'export', side:right, field:'exportPngSecondary', title:'Экспорт файлов', icon:'↓', hint:'PNG, ZIP и рекомендации' },
    { key:'help', side:right, field:null, title:'Сохранение и справка', icon:'?', hint:'Где хранятся проекты' },
  ];
  const groups = new Map();

  function matchGroup(side, id) {
    const children = [...side.children].filter(el => el.classList.contains('control-group'));
    return id ? children.find(el => el.id === id || el.querySelector('#'+id))
      : children.find(el => !sections.some(c => c.side === side && c.field && (el.id === c.field || el.querySelector('#'+c.field))));
  }

  function fold(group, config) {
    let details = [...group.children].find(el => el.tagName === 'DETAILS');
    let summary, body;
    if (details) {
      summary = [...details.children].find(el => el.tagName === 'SUMMARY');
      if (!summary) { summary = document.createElement('summary'); details.prepend(summary); }
      body = document.createElement('div');
      body.className = 'cs-fold-body';
      [...details.childNodes].filter(node => node !== summary).forEach(node => body.append(node));
      details.append(body);
    } else {
      details = document.createElement('details');
      summary = document.createElement('summary');
      body = document.createElement('div');
      body.className = 'cs-fold-body';
      // Preserve every existing control/event handler by moving its DOM node.
      while (group.firstChild) body.append(group.firstChild);
      details.append(summary, body);
      group.append(details);
    }

    details.classList.add('cs-fold');
    details.dataset.section = config.key;
    group.classList.add('cs-section');
    group.dataset.section = config.key;
    summary.className = 'cs-fold-summary';
    summary.replaceChildren();
    const icon = document.createElement('span');
    icon.className = 'cs-fold-icon';
    icon.textContent = config.icon;
    icon.setAttribute('aria-hidden','true');
    const heading = document.createElement('span');
    heading.className = 'cs-fold-copy';
    const title = document.createElement('strong');
    title.textContent = config.title;
    const hint = document.createElement('small');
    hint.textContent = config.hint;
    heading.append(title, hint);
    const chevron = document.createElement('span');
    chevron.className = 'cs-fold-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    chevron.textContent = '⌄';
    summary.append(icon,heading,chevron);
    // An opened section displays no duplicate legacy title.
    const oldTitle = body.querySelector(':scope > .section-heading');
    if (oldTitle) oldTitle.classList.add('cs-original-heading');
    details.open = false;
    groups.set(config.key, { group, details, summary });
  }

  // Move only whole original panels. No cloneNode(): references held by
  // ai.js and index.html and their event listeners must remain valid.
  for (const config of sections) {
    const group = matchGroup(config.side, config.field);
    if (!group) continue;
    config.side.append(group);
    fold(group,config);
  }
  if (!groups.size) return;
  document.documentElement.classList.add('cs-compact-ui');

  function openSection(key, scroll=true) {
    const entry = groups.get(key);
    if (!entry) return;
    entry.details.open = true;
    if (scroll) entry.summary.scrollIntoView({behavior: 'smooth', block:'start'});
  }

  // ---------- Телефон: одна колонка в порядке работы, кнопка «Отправить» всегда под пальцем ----------
  const phone = window.matchMedia('(max-width:720px)').matches;
  if (phone) {
    document.documentElement.classList.add('cs-phone');
    const brandTitle = document.querySelector('.brand b');
    const pid = new URLSearchParams(location.search).get('post');
    if (brandTitle) brandTitle.textContent = pid && /^P\d{4,6}$/.test(pid) ? 'Пост ' + pid : 'Конструктор';
    const ORDER = ['slides', 'text', 'background', 'images', 'foundation', 'logo', 'publish', 'ai', 'carousel', 'export', 'help'];
    for (const key of ORDER) { const g = groups.get(key); if (g) left.append(g.group); }
    const actions = document.querySelector('.header-actions');
    if (actions) {
      const files = document.createElement('button');
      files.type = 'button'; files.className = 'cs-files-toggle'; files.textContent = '⋯'; files.setAttribute('aria-label', 'Файлы: открыть, сохранить, экспорт');
      files.addEventListener('click', () => document.documentElement.classList.toggle('cs-files-open'));
      const undo = document.getElementById('undoBtn');
      const tools = document.createElement('div'); tools.className = 'cs-head-tools';
      if (undo) { const u = document.createElement('button'); u.type = 'button'; u.className = 'cs-files-toggle'; u.textContent = '↶'; u.setAttribute('aria-label', 'Отменить'); u.addEventListener('click', () => undo.click()); tools.append(u); }
      tools.append(files);
      actions.before(tools);
    }
    // нижняя панель: статус + действия согласования (прокси к настоящим кнопкам)
    const approve = document.getElementById('pipeApprove'), send = document.getElementById('pipeSend'), status = document.getElementById('pipeStatus');
    if (approve && send) {
      const bar = document.createElement('div'); bar.className = 'cs-actionbar';
      const msg = document.createElement('div'); msg.className = 'cs-actionbar-msg'; msg.hidden = true;
      const row = document.createElement('div'); row.className = 'cs-actionbar-row';
      const mk = (src, cls) => { const b = document.createElement('button'); b.type = 'button'; b.className = cls; b.addEventListener('click', () => src.click()); return b; };
      const a = mk(approve, 'cs-ab-primary'), sBtn = mk(send, 'cs-ab-secondary');
      const sync = () => {
        a.textContent = approve.textContent.replace('Текст ок — собрать пост', 'Текст ок — собрать'); a.disabled = approve.disabled;
        sBtn.textContent = send.disabled ? '⏳' : '📤 В бот'; sBtn.disabled = send.disabled;
        if (status && !status.hidden && status.textContent) { msg.hidden = false; msg.textContent = status.textContent; msg.style.cssText = status.style.cssText + ';margin:0 0 8px;font-size:13px;padding:8px 10px'; }
        else msg.hidden = true;
      };
      for (const el of [approve, send, status].filter(Boolean)) new MutationObserver(sync).observe(el, { attributes: true, childList: true, characterData: true, subtree: true });
      row.append(sBtn, a); bar.append(msg, row); document.body.append(bar); sync();
    }
  }

  const nav = document.createElement('nav');
  nav.className = 'cs-quickbar';
  nav.setAttribute('aria-label','Быстрый доступ к инструментам Cover Studio');
  const label = document.createElement('span');
  label.className = 'cs-quickbar-label';
  label.textContent = 'БЫСТРО:';
  nav.append(label);
  for (const [key, title] of [
    ['slides','▤ Слайды'],['text','✍️ Текст'],['background','🖼 Фон'],['images','🎬 Кадры'],
    ['foundation','🎞 Формат'],['publish','📤 Отправка'],['ai','✨ ИИ'],
  ]) {
    if (!groups.has(key)) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cs-quick-button';
    button.textContent = title;
    button.addEventListener('click',()=>openSection(key));
    nav.append(button);
  }
  document.querySelector('header')?.after(nav);

  // Contextual entry points must not land inside collapsed sections.
  const params = new URLSearchParams(location.search);
  if (params.get('images') === '1') openSection('images',false);
  else { openSection('slides',false); openSection('text',false); }
  if (params.has('post') && !phone) openSection('publish',false); // на телефоне отправка в нижней панели

  // A section opened from the preview remains open until the user closes it.
  window.SkoomaCompactUI = Object.freeze({openSection});
})();
