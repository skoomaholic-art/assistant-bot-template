// Cover Studio: synchronize local preview backgrounds with IGM before approval.
// Loaded as a browser script. No publication and no filesystem/network side effects
// except through the authenticated caller-provided API callback.
(function (root) {
  'use strict';
  const MAX_DATA_URL = 2_800_000; // well under Vercel's request body limit

  function plan(slides, saved, selected) {
    const jobs = [];
    slides.forEach((slide, index) => {
      const image = slide?.bgImage || null;
      const previous = saved.get(index) || null;
      if (image && image !== previous) {
        const ref = selected.get(index);
        jobs.push({
          index, type: 'upload',
          image,
          source: ref?.image === image && /^https:\/\/(image\.tmdb\.org|assets\.fanart\.tv)\//.test(ref.url || '') ? ref : null,
        });
      } else if (!image && previous) {
        jobs.push({ index, type: 'remove' });
      }
    });
    // Existing backgrounds from deleted slides must not silently reappear later.
    for (const index of saved.keys()) {
      if (index >= slides.length) jobs.push({ index, type: 'remove' });
    }
    return jobs.sort((a, b) => a.index - b.index);
  }

  function loadedImage(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('Не удалось прочитать фотографию для сохранения'));
      image.src = src;
    });
  }

  async function jpegForUpload(src) {
    if (!/^data:image\/(png|jpeg|webp);base64,/i.test(src || '')) {
      throw Error('Фон не является изображением PNG, JPG или WebP');
    }
    const image = await loadedImage(src);
    const w = image.naturalWidth, h = image.naturalHeight;
    if (!w || !h || w * h > 50_000_000) throw Error('Фотография имеет неподдерживаемый размер');
    for (const [max, quality] of [[1920, .85], [1600, .76], [1200, .68], [900, .55]]) {
      const scale = Math.min(1, max / Math.max(w, h));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) throw Error('Браузер не поддерживает обработку изображения');
      ctx.fillStyle = '#101215';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      const uri = canvas.toDataURL('image/jpeg', quality);
      if (uri.length <= MAX_DATA_URL) return uri;
    }
    throw Error('Фотография слишком большая для сохранения. Попробуй уменьшить разрешение');
  }

  async function sync({ postId, slides, saved, selected, call, confirmRights, progress }) {
    const jobs = plan(slides, saved, selected);
    // Галочка нужна только для кадров и постеров из TMDB / fanart.tv. Свои картинки и сгенерированные — без неё
    if (jobs.some(job => job.type === 'upload' && job.source) && !confirmRights) {
      throw Error('Отметь галочку про права: в посте есть кадры или постеры из TMDB / fanart.tv');
    }
    for (let n = 0; n < jobs.length; n++) {
      const job = jobs[n], slide = job.index + 1;
      progress?.(`Сохраняю картинки: ${n + 1} из ${jobs.length} (слайд ${slide})…`);
      if (job.type === 'remove') {
        await call({ action: 'clear_bg', id: postId, slide });
        saved.delete(job.index);
        selected.delete(job.index);
        continue;
      }
      if (job.source) {
        await call({ action: 'set_bg', id: postId, slide,
          url: job.source.url, source: job.source.source, title: job.source.title, rights: true });
      } else {
        const data = await jpegForUpload(job.image);
        await call({ action: 'set_bg_data', id: postId, slide, data, rights: true });
      }
      saved.set(job.index, job.image);
    }
    return jobs.length;
  }

  root.SkoomaImageSync = Object.freeze({ plan, jpegForUpload, sync });
})(typeof window === 'undefined' ? globalThis : window);
