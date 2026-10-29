// Editorial preflight hints only. No fact-check is claimed, no network calls,
// no mutation of post state, and never gates owner approvals or publishing.
// Factual truth requires corroboration against independent primary sources.
const VERIFIABLE_CLAIMS = [
  /(?:^|[^\d])(?:19|20)\d{2}(?!\d)/u,                     // years
  /\b\d[\d\s.,]*\s*(?:%|процент(?:а|ов)?|млн|миллион(?:а|ов)?|млрд|миллиард(?:а|ов)?|доллар(?:ов|а)?|тенге)(?![\p{L}\p{N}])/iu,
  /(?:официально|подтвердил[аи]?|подтвержден[оаы]?|объявил[аи]?|заявил[аи]?|сообщил[аи]?|по\s+словам)/iu,
  /(?:премь?ер[аыуеой]?|дата\s+выхода|выйдет|выходит|продлили|продл[её]н|кастинг|съ[её]мк[иа]|бюджет|кассов(?:ые|ых)\s+сборы|рейтинг|награ(?:да|ды)|номинаци)/iu,
  /(?:акт[её]р|актриса|режисс[её]р|сценарист|продюсер)\s+[^.!?\n]{0,65}(?:сыграл|снял|подписал|подтвердил|заявил|станет)/iu,
];

const normalize = v => String(v ?? '').replace(/\s+/g,' ').trim();
const hasWebLink = link => {
  try { const url=new URL(String(link||'')); return url.protocol==='https:' && Boolean(url.hostname.includes('.')); }
  catch { return false; }
};
const assetCount = post => (post?.image_sources || []).filter(x=>x && typeof x==='object' && (x.source||x.url)).length;
const hasAttachedBackground = post => Boolean(post?.bg?.path || Object.values(post?.bgs || {}).some(Boolean)
  || (post?.pages || []).some(p=>typeof p?.bgImage==='string' && p.bgImage.length));
const ownerUploads = post => (post?.source?.kind==='own' && Boolean(post?.own?.files?.length));

// Returns warnings, never verdicts such as 'false' or 'rights cleared'.
// Warning texts are short enough for Telegram's message length budget.
export function reviewWarnings(post) {
  if (!post || typeof post!=='object') return [];
  const d=post.draft || {};
  const text=[
    ...(Array.isArray(d.slides)?d.slides.flatMap(s=>[s?.title,s?.subtitle]):[]),
    d.caption,d.video_script,
    ...(Array.isArray(d.credits?.lines)?d.credits.lines.map(l=>l?.name+' '+(l?.role||'')):[]),
  ].map(normalize).filter(Boolean).join(' ');
  const warnings=[];
  if (text && VERIFIABLE_CLAIMS.some(pattern=>pattern.test(text))) {
    if (hasWebLink(post.source?.link)) {
      warnings.push({
        kind:'facts',code:'CLAIMS_REQUIRE_CORROBORATION',
        text:'Есть проверяемые утверждения (даты, имена, цифры или анонсы). Ссылка на материал есть, но совпадение каждого факта с первоисточником ещё не установлено.',
      });
    } else {
      warnings.push({
        kind:'facts',code:'CLAIMS_WITHOUT_SOURCE_LINK',
        text:'Есть проверяемые утверждения (даты, имена, цифры или анонсы), но не указан проверяемый URL первоисточника. Нужна ручная сверка перед публикацией.',
      });
    }
  }
  if (assetCount(post)) {
    warnings.push({
      kind:'rights',code:'THIRD_PARTY_IMAGE_RIGHTS',
      text:'Используются изображения из внешнего каталога. Указание TMDB/fanart.tv или авторства не подтверждает право на публикацию. Проверь лицензию каждого кадра и постера.',
    });
  } else if (hasAttachedBackground(post)) {
    warnings.push({
      kind:'rights',code:'BACKGROUND_RIGHTS_UNKNOWN',
      text:'На слайдах есть загруженные фоны. Убедись в праве использовать изображения и в отсутствии ограничений. Автоматически права не проверены.',
    });
  } else if (ownerUploads(post)) {
    warnings.push({
      kind:'rights',code:'UPLOADED_MEDIA_RIGHTS_UNKNOWN',
      text:'В посте есть загруженные фото или видео. Проверь права на изображение, музыку и другие элементы. Автоматически права не проверены.',
    });
  }
  return warnings;
}

export function warningsText(post) {
  const list=reviewWarnings(post);
  if (!list.length) return '';
  return '\n\n⚠️ Предпубликационная проверка (предупреждения, не вердикт):\n'
    +list.map(w=> '• '+w.text).join('\n');
}
