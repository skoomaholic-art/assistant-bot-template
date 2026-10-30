import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Ловит «X is not defined»: функция из соседнего модуля вызывается, но не импортирована
test('api files import every helper they call', () => {
  const files = fs.readdirSync('api').filter(f => f.endsWith('.js'));
  const ex = {};
  for (const f of files) for (const m of fs.readFileSync('api/' + f, 'utf8').matchAll(/export (?:async )?(?:function|const|let|class) (\w+)/g)) (ex[m[1]] ||= []).push(f);
  const missing = [];
  for (const f of files) {
    const s = fs.readFileSync('api/' + f, 'utf8');
    const imps = [...s.matchAll(/(?:import|const)\s*\{([^}]*)\}\s*(?:from|=\s*await import)/g)].map(m => m[1]).join(',');
    for (const n of Object.keys(ex)) {
      if (ex[n].includes(f)) continue;
      if (!new RegExp('(^|[^.\\w])' + n + '\\(').test(s)) continue;
      if (new RegExp('\\b' + n + '\\b').test(imps)) continue;
      if (new RegExp('(function|const|let|var)\\s+' + n + '\\b|[,(]\\s*' + n + '\\s*[,)=]|\\b' + n + '\\s*=').test(s)) continue;
      missing.push(`${f}: ${n}`);
    }
  }
  assert.deepEqual(missing, []);
});
