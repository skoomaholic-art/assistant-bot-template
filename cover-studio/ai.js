// MyBrand AI Post Factory. Adds an editor panel, never publishes.
(() => {
  'use strict';
  const editor=window.__skooma;
  const visuals=window.SkoomaStyles;
  // Черновик ИИ → слайды конструктора. Используется и в редакторе, и роботом сборки (IGM pipeline).
  function pagesFromDraft(draft){
    const category=draft.category,format=draft.format,visual=visuals.get(draft.visual_style||'noir');
    return draft.slides.map((p,i)=>({
      format,category,layout:visual.layout,theme:visual.theme,stylePreset:visual.id,bgMode:visual.background,bgColor:visual.bgColor,typeface:visual.typeface,titleAlign:visual.titleAlign,
      title:String(p.title).toLocaleUpperCase('ru-RU'),subtitle:p.subtitle,
      episode:draft.slides.length>1||format==='reel'?String(i+1).padStart(2,'0'):'',
      kicker:(category==='series'?'СЕРИАЛЫ':category==='facts'?'КИНО / ДЕТАЛИ':'КИНО')+(format==='reel'?' / REELS':draft.slides.length>1?' / КАРУСЕЛЬ':' / МНЕНИЕ'),
      footer:format!=='reel'&&draft.slides.length>1&&i===0?'ЛИСТАЙ →':'MYBRAND',
      bgImage:null,showLogo:true,logoPosition:'bottom-right',
      titleSize:format==='portrait'?Math.min(visual.titleSize,94):format==='reel'?Math.max(visual.titleSize,128):visual.titleSize,titleY:visual.titleY,titleWidth:format==='reel'?88:83,
      ...(draft.visual_prefs&&typeof draft.visual_prefs==='object'?draft.visual_prefs:{}), // вёрстка, выученная из правок владельца
    })).map(fitLongWords).concat(creditsPage(draft,visual,category,format));
  }
  // Слайд-титры в конце карусели: кто снимался и о ком шла речь
  function creditsPage(draft,visual,category,format){
    const c=draft.credits;
    if(!draft.credits_on||!c||!Array.isArray(c.lines)||c.lines.length<2||draft.slides.length+1>10)return [];
    const body=c.lines.map(l=>String(l.name||'').toLocaleUpperCase('ru-RU')+(l.role?'\n'+l.role:'')).join('\n\n');
    // по центру слайда по вертикали: оцениваем высоту блока титров
    const lineCount=body.split('\n').length, sz=lineCount>8?34:44, H=format==='reel'?1920:format==='portrait'?1350:1080;
    const block=58*1.2+35+lineCount*sz*1.32;
    const titleY=Math.round(Math.max(8,(H-block)/2/H*100));
    return [{format,category,layout:'center',theme:visual.theme,stylePreset:visual.id,bgMode:visual.background,bgColor:visual.bgColor,typeface:visual.typeface,titleAlign:'center',
      title:c.title?String(c.title).toLocaleUpperCase('ru-RU'):'В РОЛЯХ',subtitle:body,kicker:'ТИТРЫ',episode:String(draft.slides.length+1).padStart(2,'0'),
      footer:'MYBRAND',bgImage:null,showLogo:true,logoPosition:'bottom-right',titleSize:58,titleY,titleWidth:86}];
  }
  // Длинное слово не должно разрываться: уменьшаем кегль под самое длинное слово заголовка
  function fitLongWords(page){
    if(String(page.subtitle||'').length>90){page={...page,titleSize:Math.min(page.titleSize||100,page.format==='reel'?92:76),titleY:Math.min(page.titleY||41,page.format==='reel'?30:24)};}
    const longest=Math.max(0,...String(page.title||'').split(/\s+/).map(w=>w.length));
    const width=(page.titleWidth||83)/100*1080;
    const maxSize=Math.floor(width/(Math.max(longest,1)*0.98));
    return longest>0&&page.titleSize>maxSize?{...page,titleSize:Math.max(40,maxSize)}:page;
  }
  if(visuals)window.SkoomaPages=Object.freeze({fromDraft:pagesFromDraft});
  const root=document.querySelector('aside.right .controls');
  if(!editor||!root||!visuals)return;
  const presets=[
    ['cinema_post','Кино · пост-картинка'],
    ['series_post','Сериалы · пост-картинка'],
    ['cinema_opinion','Кино · Reels-мнение'],
    ['series_analysis','Сериалы · разбор'],
    ['cinema_detail','Кино · детали сцены'],
    ['cinema_carousel','Кино · 6 слайдов'],
    ['series_carousel','Сериалы · 6 слайдов'],
    ['recommendation','Подборка · 6 слайдов'],
  ];
  const div=document.createElement('div');div.className='control-group';div.id='aiFactory';
  div.innerHTML=`
    <h2 class="section-heading">✨ ИИ · СБОРКА ПО ПРЕСЕТУ</h2>
    <p class="section-sub">Введи тему — ИИ напишет заголовок, структуру поста, подпись и сценарий Reels. Конструктор сам разложит их по обложкам. Только черновик.</p>
    <div class="field"><label for="aiPreset">Тип публикации</label><select id="aiPreset"></select></div>
    <div class="field"><label for="aiVisualStyle">Строгий стиль / фон</label><select id="aiVisualStyle"></select></div>
    <div class="inline-buttons">
      <button id="aiApplyStyle" class="small">Применить ко всем слайдам</button>
      <button id="aiCopyPrompt" class="small">Копировать промпт фона</button>
    </div>
    <div class="field"><label for="aiBackgroundPrompt">Промпт фона (изображение без текста)</label><textarea id="aiBackgroundPrompt" rows="5" readonly></textarea></div>
    <p class="help">Выбранный фон создаётся локально и бесплатно средствами Canvas. Промпт можно скопировать в генератор изображений и загрузить результат через «Фон и графика». Авторские права проверяем до публикации.</p>
    <div class="field"><label for="aiTopic">Тема / вопрос</label><textarea id="aiTopic" maxlength="220" rows="3" placeholder="Например: почему мы пересматриваем любимые фильмы?"></textarea></div>
    <div class="field"><label for="aiFacts">Подтверждённые факты / источник (необязательно)</label><textarea id="aiFacts" maxlength="1500" rows="3" placeholder="Ссылки и детали, которые потребуется проверить перед выпуском. Не вставляй конфиденциальные материалы."></textarea></div>
    <div class="field"><label for="aiVoice">Подача</label><select id="aiVoice"><option value="thoughtful">Аналитичная</option><option value="ironic">С лёгкой иронией</option></select></div>
    <button class="primary" id="aiBuild" style="width:100%">✨ Собрать с ИИ</button>
    <p class="help" id="aiStatus" role="status" aria-live="polite" style="margin:9px 0">Генерация доступна из Telegram после подключения бесплатного GROQ_API_KEY на Vercel.</p>
    <div id="aiResult" hidden style="margin-top:12px">
      <div class="field"><label for="aiCaption">Подпись для Instagram</label><textarea id="aiCaption" rows="7" maxlength="2200"></textarea></div>
      <div class="field" id="aiScriptWrap"><label for="aiScript">Сценарий озвучки Reels</label><textarea id="aiScript" rows="6" maxlength="2900"></textarea></div>
      <div class="field"><label for="aiChecks">Что проверить перед публикацией</label><textarea id="aiChecks" rows="4" readonly></textarea></div>
      <div class="inline-buttons">
        <button id="aiCopy" class="small">Копировать подпись</button>
        <button id="aiSave" class="small">↓ Черновик JSON</button>
      </div>
      <div class="note" style="margin-top:8px">ИИ не проверяет источники и права на материалы. Это не готовый видеоролик: для Reels создаются обложка и сценарий. Публикация только через модерацию.</div>
    </div>
  `;
  root.prepend(div);
  const $=id=>document.getElementById(id);
  for(const [key,label] of presets){const option=document.createElement('option');option.value=key;option.textContent=label;$('aiPreset').append(option);}
    for(const [id,style] of Object.entries(visuals.styles)){const op=document.createElement('option');op.value=id;op.textContent=style.label;$('aiVisualStyle').append(op);}
  $('aiVisualStyle').value='noir';
  function currentFormat(){
    const key=$('aiPreset').value;
    return ['cinema_carousel','series_carousel','recommendation','cinema_post','series_post'].includes(key)?'portrait':'reel';
  }
  function updatePrompt(){
    $('aiBackgroundPrompt').value=visuals.prompt($('aiVisualStyle').value,currentFormat(),$('aiTopic').value);
  }
  $('aiVisualStyle').onchange=updatePrompt;
  $('aiPreset').onchange=()=>{const k=$('aiPreset').value;if(k.startsWith('series'))$('aiVisualStyle').value='blue';else if($('aiVisualStyle').value==='blue')$('aiVisualStyle').value='noir';updatePrompt();};
  $('aiTopic').addEventListener('input',updatePrompt);
  $('aiApplyStyle').onclick=()=>{editor.applyVisualStyle(visuals.get($('aiVisualStyle').value),true);$('aiStatus').textContent='Стиль применён ко всем слайдам. Фотографии заменены строгим фоном.';};
  $('aiCopyPrompt').onclick=async()=>{
    const prompt=$('aiBackgroundPrompt').value;
    try{await navigator.clipboard.writeText(prompt);$('aiStatus').textContent='Промпт фона скопирован';}
    catch{$('aiBackgroundPrompt').select();document.execCommand('copy');$('aiStatus').textContent='Промпт фона выделен для копирования';}
  };
  updatePrompt();
  
  const savingKey='mybrand-ai-draft-meta-v1';
  function syncDraft(){
    window.__skoomaAfterSync?.();
    const meta=window.__skoomaDraftMeta;
    if(!meta){$('aiResult').hidden=true;return;}
    $('aiResult').hidden=false;
    $('aiCaption').value=String(meta.caption||'');
    $('aiScript').value=String(meta.video_script||'');
    $('aiScriptWrap').hidden=!meta.video_script;
    $('aiChecks').value=(meta.verification_notes||[]).join('\n')||'Проверить факты, права на иллюстрации и качество всех слайдов.';
  }
  try{window.__skoomaDraftMeta=JSON.parse(localStorage.getItem(savingKey)||'null');}catch{window.__skoomaDraftMeta=null;}
  syncDraft();
  document.addEventListener('skooma-draft-changed',syncDraft);
  $('aiBuild').addEventListener('click',async()=>{
    const btn=$('aiBuild'),status=$('aiStatus');
    const topic=$('aiTopic').value.trim();
    if(topic.length<5){status.textContent='Напиши тему хотя бы из пяти символов.';return;}
    const web=window.Telegram?.WebApp;
    if(!web?.initData){status.textContent='Для безопасной ИИ-сборки открой конструктор через кнопку @your_bot в Telegram. В обычном браузере доступны ручные пресеты.';return;}
    btn.disabled=true;btn.textContent='ИИ готовит пост…';status.textContent='Генерирую черновик и проверяю структуру ответа…';
    try{
      const response=await fetch('/api/ai-draft',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({initData:web.initData,presetId:$('aiPreset').value,styleId:$('aiVisualStyle').value,topic,facts:$('aiFacts').value,voice:$('aiVoice').value})});
      const data=await response.json();
      if(!response.ok||!data.ok)throw Error(data.error||'Не удалось собрать материал');
      const draft=data.draft;
      const pages=pagesFromDraft(draft);
      editor.loadGenerated(pages);
      window.__skoomaDraftMeta={...draft,preset_id:$('aiPreset').value,topic};
      window.__skoomaOrigin='ai';
      window.__skoomaPostId=null;
      savedBackgrounds.clear();selectedImages.clear();backgroundLoadFailed=false;
      try{localStorage.setItem(savingKey,JSON.stringify(draft));}catch{}
      syncDraft();
      status.textContent=`Собрано: ${pages.length} ${pages.length===1?'обложка':'слайдов'}. Проверь текст и экспортируй PNG/ZIP. Ничего не опубликовано.`;
    }catch(err){status.textContent=err.message||'Ошибка генерации';}
    finally{btn.disabled=false;btn.textContent='✨ Собрать с ИИ';}
  });
  for(const key of ['aiCaption','aiScript'])$(key).addEventListener('input',()=>{
    if(!window.__skoomaDraftMeta)return;
    window.__skoomaDraftMeta.caption=$('aiCaption').value;
    window.__skoomaDraftMeta.video_script=$('aiScript').value;
    try{localStorage.setItem(savingKey,JSON.stringify(window.__skoomaDraftMeta));}catch{}
  });
  $('aiCopy').addEventListener('click',()=>{
    const t=$('aiCaption').value;
    if(!t)return;
    navigator.clipboard?.writeText(t).then(()=>{$('aiStatus').textContent='Подпись скопирована';}).catch(()=>{$('aiCaption').select();document.execCommand('copy');});
  });
  $('aiSave').addEventListener('click',()=>{
    const meta=window.__skoomaDraftMeta;if(!meta)return;
    const data={app:'MyBrand Post Draft',version:1,status:'requires_owner_review',slides:editor.slides,post:meta};
    const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download='MyBrand_AI_Post_Draft.json';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    $('aiStatus').textContent='JSON-черновик сохранён. Для изображений скачай ZIP всех слайдов.';
  });

  // ---------- Согласование: черновик из конструктора → бот → сборка роботом ----------
  const box=document.createElement('div');box.className='control-group';box.id='pipeBox';
  box.innerHTML=`
    <h2 class="section-heading">📤 СОГЛАСОВАНИЕ И ПУБЛИКАЦИЯ</h2>
    <p class="section-sub" id="pipeInfo">Собери пост (вручную или «✨ Собрать с ИИ») и отправь текст на согласование. После «ок» робот соберёт финал и пришлёт его в бот, а после второго «ок» опубликует.</p>
    <div id="pipeOrigin" class="note" style="margin:0 0 10px"></div>
    <div class="field"><label for="pipeCaption">Подпись для Instagram (текст под постом и хэштеги)</label><textarea id="pipeCaption" rows="5" maxlength="2200" placeholder="Короткая подводка, вопрос к подписчикам и 3–5 хэштегов"></textarea><div class="help" id="pipeCapCount" style="text-align:right">0 / 2200</div></div>
    <div class="inline-buttons" style="flex-direction:column;align-items:stretch;gap:8px">
      <button class="primary" id="pipeApprove" style="width:100%">✅ Текст ок — собрать пост</button>
      <button id="pipeSend" style="width:100%">📤 Отправить текст на согласование в бот</button>
    </div>
    <label id="pipeRightsWrap" style="display:none;gap:8px;align-items:flex-start;margin-top:10px;font-size:13px;padding:8px;border-radius:8px;border:1px solid rgba(242,170,76,.45)"><input type="checkbox" id="pipeRights" style="margin-top:2px"><span>В посте есть кадры или постеры из TMDB / fanart.tv. Подтверждаю право их использовать (для своих картинок галочка не нужна)</span></label>
    <div id="pipeStatus" role="status" aria-live="polite" hidden style="margin:10px 0 2px;padding:10px 12px;border-radius:10px;font-size:14px;line-height:1.4"></div>`;
  root.prepend(box);
  // Статус крупно и цветом: работаю / готово / ошибка
  const ST_STYLE={busy:'background:rgba(90,140,255,.14);border:1px solid rgba(90,140,255,.5)',ok:'background:rgba(60,190,110,.14);border:1px solid rgba(60,190,110,.55)',err:'background:rgba(235,80,80,.14);border:1px solid rgba(235,80,80,.6)',info:'background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.15)'};
  function setStatus(kind,text){
    const el=$('pipeStatus');if(!el)return;
    if(!text){el.hidden=true;el.textContent='';return;}
    el.hidden=false;el.style.cssText='margin:10px 0 2px;padding:10px 12px;border-radius:10px;font-size:14px;line-height:1.4;'+ST_STYLE[kind||'info'];
    el.textContent=(kind==='busy'?'⏳ ':kind==='ok'?'✅ ':kind==='err'?'❌ ':'')+text;
  }
  window.__skoomaSetStatus=setStatus;
  window.__skoomaPostId=null;
  // Кто собрал пост: manual — ты сам (ИИ учится на нём как на эталоне), ai — черновик ИИ
  window.__skoomaOrigin=window.__skoomaDraftMeta?.source==='groq-draft'?'ai':'manual';
  function showOrigin(){
    const el=$('pipeOrigin');if(!el)return;
    const id=window.__skoomaPostId;
    el.textContent=window.__skoomaOrigin==='manual'
      ?(id?'👤 Твой пост. ':'👤 Твой пост: ')+'собери слайды, поставь картинки, впиши подпись и жми «Текст ок — собрать». Финал придёт в бот на согласование. В менеджере пост будет помечен «сделал сам», ИИ возьмёт его как пример твоего стиля'
      :'🤖 Черновик ИИ: правь как хочешь, ИИ запомнит твои правки';
  }
  const capSync=v=>{const c=$('pipeCaption');if(c&&c.value!==v)c.value=v||'';const a=$('aiCaption');if(a&&a.value!==v)a.value=v||'';$('pipeCapCount').textContent=(v||'').length+' / 2200';};
  $('pipeCaption').addEventListener('input',()=>{const v=$('pipeCaption').value;if(window.__skoomaDraftMeta)window.__skoomaDraftMeta.caption=v;else window.__skoomaDraftMeta={caption:v};try{localStorage.setItem(savingKey,JSON.stringify(window.__skoomaDraftMeta));}catch{}capSync(v);});
  document.addEventListener('skooma-draft-changed',()=>capSync(window.__skoomaDraftMeta?.caption||''));
  capSync(window.__skoomaDraftMeta?.caption||'');showOrigin();
  window.__skoomaAfterSync=()=>{capSync(window.__skoomaDraftMeta?.caption||'');showOrigin();};
  $('aiCaption').addEventListener('input',()=>capSync($('aiCaption').value));
  // 🗑 Сбросить всё: чистый лист для своего поста
  $('resetAllBtn')?.addEventListener('click',async()=>{
    const ok=await new Promise(res=>web?.showConfirm?web.showConfirm('Сбросить всё и начать с чистого листа? Слайды, подпись и привязка к посту очистятся. Уже отправленные посты в боте не пострадают',res):res(confirm('Сбросить всё и начать с чистого листа?')));
    if(!ok)return;
    editor.reset();
    window.__skoomaDraftMeta=null;window.__skoomaPostId=null;window.__skoomaOrigin='manual';
    try{localStorage.removeItem(savingKey);}catch{}
    savedBackgrounds.clear();selectedImages.clear();backgroundLoadFailed=false;
    for(const id of ['aiTopic','aiFacts','imgQ'])if($(id))$(id).value='';
    $('pipeInfo').textContent='Собери пост (вручную или «✨ Собрать с ИИ») и отправь текст на согласование. После «ок» робот соберёт финал и пришлёт его в бот, а после второго «ок» опубликует.';
    $('pipeApprove').textContent='✅ Текст ок — собрать пост';
    setStatus(null,'');
    if(location.search)window.history.replaceState(null,'',location.pathname);
    syncDraft();
    web?.HapticFeedback?.notificationOccurred('success');
  });
  // A local preview image is not a persisted image. Track which exact data
  // were saved for each slide to avoid losing photos or re-uploading duplicates.
  const savedBackgrounds=new Map(), selectedImages=new Map();
  let backgroundLoadFailed=false;
  const web=window.Telegram?.WebApp;
  function draftFromEditor(){
    const meta=window.__skoomaDraftMeta||{};
    const sl=editor.slides;
    const first=sl[0]||{};
    return {
      ...meta,
      format:first.format||meta.format||'reel',category:first.category||meta.category||'cinema',theme:first.theme||meta.theme,layout:first.layout||meta.layout,
      visual_style:first.stylePreset||meta.visual_style||'noir',topic:meta.topic||String(first.title||'').replace(/\s+/g,' ').slice(0,200),
      slides:sl.map(x=>({title:String(x.title||'').replace(/\s*\n\s*/g,' ').trim(),subtitle:String(x.subtitle||'').trim()})),
      caption:$('pipeCaption')?.value||$('aiCaption')?.value||meta.caption||'',video_script:$('aiScript')?.value||meta.video_script||'',
    };
  }
  async function pipeCall(payload){
    if(!web?.initData)throw Error('Открой конструктор из бота, чтобы отправлять на согласование');
    const r=await fetch('/api/pipeline',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:web.initData,...payload})});
    const data=await r.json().catch(()=>({ok:false,error:'Сервер недоступен'}));
    if(!data.ok)throw Error(data.error||'Ошибка');
    return data;
  }
  function needsUpload(){
    try{return (window.SkoomaImageSync?.plan(editor.slides,savedBackgrounds,selectedImages)||[]).some(j=>j.type==='upload'&&j.source);}catch{return false;}
  }
  function refreshRights(){const w=$('pipeRightsWrap');if(w)w.style.display=needsUpload()?'flex':'none';}
  setInterval(refreshRights,1500);
  let tracker=null;
  // После отправки следим за постом: собирается → финал в Telegram (или ошибка)
  function track(id,approve){
    clearInterval(tracker);
    const started=Date.now();
    const tick=async()=>{
      const min=Math.floor((Date.now()-started)/60000),sec=Math.floor((Date.now()-started)/1000)%60;
      const el=`${min}:${String(sec).padStart(2,'0')}`;
      try{
        const {post}=await pipeCall({action:'get',id});
        $('pipeInfo').textContent=`Пост ${id} · ${({text_review:'📝 текст на согласовании',rendering:'🎨 собирается',final_review:'🖼 финал на согласовании',published:'✅ опубликован',failed:'⚠️ ошибка',rejected:'❌ отклонён'})[post.status]||post.status}`;
        if(post.status==='final_review'){clearInterval(tracker);setStatus('ok',`Финал ${id} готов и уже в Telegram. Открой бот: «✅ Публиковать» или «🔁 Переделать»`);web?.HapticFeedback?.notificationOccurred('success');return;}
        if(post.status==='failed'){clearInterval(tracker);setStatus('err',`Сборка ${id} не удалась: ${post.error||'ошибка робота'}. В боте есть кнопка «Повторить»`);return;}
        if(post.status==='rendering'){setStatus('busy',`Робот собирает ${id}: ${el} из обычных 2–3 минут. Финал придёт в Telegram, эту страницу можно закрыть`);}
      }catch{}
      if(Date.now()-started>8*60000){clearInterval(tracker);setStatus('err',`Сборка ${id} идёт дольше 8 минут. Проверь бот: если финала нет, нажми там «Повторить»`);}
    };
    tracker=setInterval(tick,10000);tick();
  }
  async function submit(approve){
    const draft=draftFromEditor();
    if(!draft.caption.trim()){setStatus('err','Нужна подпись для Instagram: впиши её в поле «Подпись» над кнопками');$('pipeCaption').focus();return;}
    if(editor.slides.length>10){setStatus('err','В Instagram максимум 10 слайдов');return;}
    if(backgroundLoadFailed){setStatus('err','Не удалось загрузить сохранённый фон одного из слайдов. Закрой и заново открой этот пост из Telegram, чтобы не потерять изображения');return;}
    refreshRights();
    if(needsUpload()&&!$('pipeRights').checked&&!$('imgRights').checked){
      setStatus('err','Ничего не отправлено: в посте есть кадры или постеры из TMDB / fanart.tv. Отметь галочку про права чуть выше и нажми кнопку ещё раз');
      $('pipeRightsWrap').scrollIntoView({block:'center',behavior:'smooth'});$('pipeRightsWrap').style.borderColor='rgba(235,80,80,.9)';
      web?.HapticFeedback?.notificationOccurred('error');return;
    }
    const btn=approve?$('pipeApprove'):$('pipeSend'),label=btn.textContent;
    for(const b of ['pipeApprove','pipeSend'])$(b).disabled=true;
    btn.textContent='⏳ Отправляю…';
    clearInterval(tracker);
    let step='Сохраняю текст…';
    setStatus('busy',step);
    try{
      const FIELDS=['stylePreset','bgMode','bgColor','theme','layout','typeface','titleAlign','titleY','titleSize','titleWidth','showLogo','logoPosition'];
      let visual_diff=null;
      try{const auto=pagesFromDraft({...draft,slides:[draft.slides[0]]})[0],mine=editor.slides[0];visual_diff={};for(const k of FIELDS)if(mine[k]!==undefined&&JSON.stringify(mine[k])!==JSON.stringify(auto[k]))visual_diff[k]=mine[k];if(!Object.keys(visual_diff).length)visual_diff=null;}catch{visual_diff=null;}
      const images=window.SkoomaImageSync;
      if(!images)throw Error('Не загружен модуль сохранения фонов. Переоткрой конструктор');
      const pages=editor.slides.map(x=>({...x,bgImage:null})); // bytes stored in IGM, not in posts.json
      // Stage text first, but NEVER approve it or start rendering until every
      // locally visible photo has been saved in the post's IGM media directory.
      const data=await pipeCall({action:'submit',id:window.__skoomaPostId||undefined,draft,pages,approve:false,defer_notify:true,visual_diff,origin:window.__skoomaOrigin});
      window.__skoomaPostId=data.post.id;
      $('pipeInfo').textContent=`Пост ${data.post.id} · сохраняю`;
      await images.sync({
        postId:data.post.id, slides:editor.slides, saved:savedBackgrounds, selected:selectedImages,
        call:pipeCall,confirmRights:$('pipeRights').checked||$('imgRights').checked,
        progress:message=>{step=message;setStatus('busy',message);}
      });
      step=approve?'Запускаю сборку…':'Отправляю карточку в бот…';setStatus('busy',step);
      const done=await pipeCall({action:approve?'approve_text':'notify_text',id:data.post.id});
      $('pipeInfo').textContent=`Пост ${data.post.id} · ${done.post.status_label}`;
      if(approve){setStatus('busy',`Принято. Робот собирает ${data.post.id}, обычно 2–3 минуты. Финал придёт в Telegram, здесь статус обновится сам`);track(data.post.id,true);}
      else setStatus('ok',`Готово: карточка ${data.post.id} уже в Telegram (придёт в течение пары секунд)`);
      web?.HapticFeedback?.notificationOccurred('success');
    }catch(e){
      setStatus('err',`Не получилось на шаге «${step.replace(/…$/,'')}»: ${e.message}. Ничего не опубликовано, можно нажать ещё раз`);
      if(window.__skoomaPostId)$('pipeInfo').textContent=`Пост ${window.__skoomaPostId} · не отправлен, см. ошибку ниже`;
      web?.HapticFeedback?.notificationOccurred('error');
    }
    finally{for(const b of ['pipeApprove','pipeSend'])$(b).disabled=false;btn.textContent=label;refreshRights();}
  }
  $('pipeSend').onclick=()=>submit(false);
  $('pipeApprove').onclick=()=>submit(true);
  // ---------- Кадры и постеры: поиск по названию тайтла или имени актёра (TMDB + fanart.tv) ----------
  const imgBox=document.createElement('div');imgBox.className='control-group';imgBox.id='imgSearch';
  imgBox.innerHTML=`
    <h2 class="section-heading">🎬 КАДРЫ И ПОСТЕРЫ</h2>
    <p class="section-sub">Впиши название фильма, сериала или имя актёра. Нажми на картинку — она встанет фоном на выбранный слайд.</p>
    <div style="display:flex;gap:8px"><input id="imgQ" type="search" maxlength="100" placeholder="Крёстный отец или Аль Пачино" style="flex:1" enterkeyhint="search"><button id="imgGo" class="small">Найти</button></div>
    <div id="imgResults" style="display:flex;flex-direction:column;gap:6px;margin-top:8px"></div>
    <div id="imgTabs" class="inline-buttons" hidden style="margin-top:8px"></div>
    <div id="imgGrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px"></div>
    <label style="display:flex;gap:8px;align-items:flex-start;margin-top:10px;font-size:13px"><input type="checkbox" id="imgRights" style="margin-top:2px"><span>Подтверждаю право использовать выбранные изображения. Для кадров и постеров нужно разрешение правообладателя; указания источника недостаточно.</span></label>
    <p class="help" id="imgStatus" role="status" aria-live="polite" style="margin:9px 0"></p>`;
  box.after(imgBox);
  $('imgRights').addEventListener('change',()=>{$('pipeRights').checked=$('imgRights').checked;});
  $('pipeRights').addEventListener('change',()=>{$('imgRights').checked=$('pipeRights').checked;$('pipeRightsWrap').style.borderColor='';});
  const KIND={backdrop:'Кадры',poster:'Постеры',profile:'Фото'};
  let imgList=[],imgKind='backdrop',imgTitle='';
  const imgStatus=t=>{$('imgStatus').textContent=t;};
  async function newsCall(payload){
    if(!web?.initData)throw Error('Поиск кадров работает, когда конструктор открыт из бота');
    const r=await fetch('/api/news',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({initData:web.initData,...payload})});
    const data=await r.json().catch(()=>({ok:false,error:'Сервер недоступен'}));
    if(!data.ok)throw Error(data.error||'Ошибка');
    return data;
  }
  function el(tag,props={},kids=[]){const e=document.createElement(tag);Object.assign(e,props);for(const k of kids)e.append(k);return e;}
  function drawGrid(){
    const grid=$('imgGrid');grid.innerHTML='';
    const items=imgList.filter(x=>x.kind===imgKind);
    for(const it of items){
      const b=el('button',{type:'button',title:`${it.source}${it.width?` · ${it.width}×${it.height}`:''}`});
      b.style.cssText=`padding:0;border:0;border-radius:6px;overflow:hidden;background:#111;aspect-ratio:${it.kind==='backdrop'?'16/9':'2/3'};cursor:pointer`;
      const im=el('img',{src:it.thumb,loading:'lazy',alt:''});im.style.cssText='width:100%;height:100%;object-fit:cover;display:block';
      b.append(im);b.onclick=()=>applyImage(it,b);grid.append(b);
    }
    if(!items.length)grid.append(el('p',{className:'help',textContent:'Нет картинок этого типа'}));
    const tabs=$('imgTabs');tabs.innerHTML='';tabs.hidden=false;
    for(const k of Object.keys(KIND)){const n=imgList.filter(x=>x.kind===k).length;if(!n)continue;
      const t=el('button',{type:'button',className:'small'+(k===imgKind?' primary':''),textContent:`${KIND[k]} · ${n}`});t.onclick=()=>{imgKind=k;drawGrid();};tabs.append(t);}
  }
  async function openTitle(r){
    imgStatus('Загружаю картинки «'+r.title+'»…');$('imgGrid').innerHTML='';
    try{
      const {images}=await newsCall({action:'img_list',type:r.type,id:r.id});
      imgList=images;imgTitle=r.title+(r.year?` (${r.year})`:'');
      imgKind=r.type==='person'?'profile':images.some(x=>x.kind==='backdrop')?'backdrop':'poster';
      drawGrid();imgStatus(images.length?`${imgTitle}: ${images.length} картинок. Сначала выбери слайд слева, потом нажми на картинку.`:'Картинок не нашлось');
    }catch(e){imgStatus(e.message);}
  }
  async function search(){
    const q=$('imgQ').value.trim();if(q.length<2){imgStatus('Введи название или имя');return;}
    imgStatus('Ищу…');$('imgResults').innerHTML='';$('imgGrid').innerHTML='';$('imgTabs').hidden=true;
    try{
      const {results}=await newsCall({action:'img_search',q});
      if(!results.length){imgStatus('Ничего не нашлось. Попробуй оригинальное название');return;}
      imgStatus('Выбери нужный вариант');
      for(const r of results){
        const b=el('button',{type:'button'});b.style.cssText='display:flex;gap:8px;align-items:center;text-align:left;padding:6px;border-radius:8px;width:100%';
        const th=el('div');th.style.cssText='width:34px;height:50px;flex:none;border-radius:4px;background:#222 center/cover no-repeat';if(r.thumb)th.style.backgroundImage=`url("${r.thumb}")`;
        const label={movie:'фильм',tv:'сериал',person:'актёр'}[r.type];
        const info=el('span',{},[el('b',{textContent:r.title+(r.year?` (${r.year})`:'')}),el('br'),el('small',{textContent:label+(r.original&&r.original!==r.title?' · '+r.original:'')+(r.known_for?' · '+r.known_for:'')})]);
        b.append(th,info);b.onclick=()=>{$('imgResults').innerHTML='';$('imgResults').append(el('small',{className:'help',textContent:'⬅︎ '+r.title+' · другой поиск — кнопка «Найти»'}));openTitle(r);};
        $('imgResults').append(b);
      }
    }catch(e){imgStatus(e.message);}
  }
  $('imgGo').onclick=search;
  $('imgQ').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();search();}});
  async function applyImage(it,btn){
    if(!$('imgRights').checked){imgStatus('Сначала отметь галочку про права на изображение');$('imgRights').focus();return;}
    const slideNo=editor.active+1;
    btn.style.opacity='.4';imgStatus(`Ставлю картинку на слайд ${slideNo}…`);
    try{
      const img=await newsCall({action:'img_fetch',url:it.url});
      editor.setBgImage(img.data,slideNo-1);
      selectedImages.set(slideNo-1,{image:img.data,url:it.url,source:it.source,title:imgTitle});
      // Do not save on each click: a final_review post would otherwise
      // switch to rendering after the first picture and reject the rest.
      // Keep all replacements in preview and upload them together before
      // the next owner approval (submit() stages text_review first).
      imgStatus(`Слайд ${slideNo}: картинка добавлена в предпросмотр. Нажми «✅ Текст ок — собрать пост», чтобы сохранить все изображения.`);
      web?.HapticFeedback?.notificationOccurred('success');
    }catch(e){imgStatus(e.message);web?.HapticFeedback?.notificationOccurred('error');}
    finally{btn.style.opacity='';}
  }
  if(new URLSearchParams(location.search).get('images')==='1')setTimeout(()=>{imgBox.scrollIntoView({block:'start'});$('imgQ').focus();},400);

  // Открыт из бота кнопкой «Править в конструкторе»: ?post=P0001
  const postId=new URLSearchParams(location.search).get('post');
  if(postId&&/^P\d{4,6}$/.test(postId)&&web?.initData){
    setStatus('busy','Загружаю пост '+postId+'…');
    pipeCall({action:'get',id:postId}).then(async({post,bg_urls})=>{
      editor.loadGenerated(post.pages||pagesFromDraft(post.draft));
      savedBackgrounds.clear();selectedImages.clear();backgroundLoadFailed=false;
      for(const [i,url] of Object.entries(bg_urls||{})){
        try{
          const response=await fetch(url);
          if(!response.ok)throw Error('Фон недоступен');
          const blob=await response.blob();
          const data=await new Promise((ok,no)=>{const fr=new FileReader();fr.onload=()=>ok(fr.result);fr.onerror=no;fr.readAsDataURL(blob);});
          editor.setBgImage(data,Number(i));
          savedBackgrounds.set(Number(i),data);
        }catch{backgroundLoadFailed=true;}
      }
      editor.select(0);
      const t=post.draft?.tags?.titles?.[0];if(t&&!$('imgQ').value)$('imgQ').value=t;
      window.__skoomaDraftMeta={...post.draft};
      window.__skoomaOrigin=['manual','own','own_text'].includes(post.source?.kind)?'manual':'ai';
      try{localStorage.setItem(savingKey,JSON.stringify(window.__skoomaDraftMeta));}catch{}
      window.__skoomaPostId=post.id;
      syncDraft();
      $('pipeInfo').textContent=post.status==='final_review'?`Пост ${post.id} · финал: поправь вёрстку и жми «✅ Готово — пересобрать». ИИ запомнит твои правки.`:`Пост ${post.id} · правь слайды и подпись, потом «✅ Текст ок — собрать пост». ИИ запомнит твои правки.`;
      if(post.status==='final_review')$('pipeApprove').textContent='✅ Готово — пересобрать';
      setStatus(backgroundLoadFailed?'err':null,backgroundLoadFailed?'Не все сохранённые изображения загрузились. Закрой и заново открой пост из бота перед отправкой.':'');
      if(new URLSearchParams(location.search).get('images')!=='1'&&!document.documentElement.classList.contains('cs-phone'))box.scrollIntoView({block:'start'});
    }).catch(e=>{setStatus('err',e.message);});
  }
})();
