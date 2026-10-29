/* MyBrand visual presets v1. One brand, six restrained background treatments.
 * These prompts specify ORIGINAL abstract background plates only. No third-party imagery.
 * Auto-created in canvas for free; prompts can be copied to external image tools manually.
 */
(function(){
"use strict";
const master="MYBRAND editorial system: quiet minimalism, clear hierarchy, matte cinema texture, near-black charcoal #101215, warm amber #F2AA4C for cinema and muted blue #90AFB9 for series, creamy typography #F1ECE3. Original abstract backgrounds only; no photography, actors, film stills, logos, film titles, typography, lettering, words, or watermarks in the background plate. Keep central 75% calm, dark, uncluttered for a separately rendered Russian headline. No glowing CGI, fantasy, cyberpunk, 3D, stock-photo clichés or highly detailed AI art.";
const negative="no people, no faces, no actors, no characters, no copyrighted movie frames, no buildings, no text, no letters, no typographic elements, no brand logos, no watermarks, no complex patterns, no flashy lens flare, no excessive contrast, no artificial glossy 3D, no fake film posters";
const entries={
 noir:{label:"01 · Чистый графит",background:"vignette",theme:"orange",layout:"editorial",bgColor:"#101215",typeface:"sans",titleAlign:"left",titleY:43,titleSize:98,
 prompt:"Minimal dark graphite matte background, extremely subtle natural vignette, almost solid charcoal, very fine soft analog film texture, no discernible objects, no shapes, high readability, slight amber reflected ambient at far right edge."},
 projector:{label:"02 · Луч проектора",background:"beam",theme:"orange",layout:"editorial",bgColor:"#101215",typeface:"sans",titleAlign:"left",titleY:44,titleSize:100,
 prompt:"Restrained cinematic projector side light in deep charcoal studio, a single barely visible soft amber light beam grazing the far right edge, sparse tiny airborne dust, broad empty dark foreground, deep restrained shadows, sophisticated film magazine design."},
 frame:{label:"03 · Контур кадра",background:"frame",theme:"orange",layout:"poster",bgColor:"#0E1215",typeface:"sans",titleAlign:"left",titleY:45,titleSize:96,
 prompt:"Geometric minimalist editorial photo-frame abstraction, just two fine muted warm grey corner lines on far right of nearly black matte background, subtle photographic grain, clean empty central negative space, no image inside the frame."},
 grain:{label:"04 · Матовая плёнка",background:"grain",theme:"ivory",layout:"editorial",bgColor:"#131618",typeface:"sans",titleAlign:"left",titleY:44,titleSize:98,
 prompt:"Monochromatic near-black matte photographic paper and fine analog film grain texture, dark grey subtle variation, absolutely minimal, no scratches, no dust clusters, no discernible imagery, refined independent cinema publication feel."},
 blue:{label:"05 · Сериальный нуар",background:"bars",theme:"blue",layout:"editorial",bgColor:"#0F171D",typeface:"sans",titleAlign:"left",titleY:44,titleSize:98,
 prompt:"Dark cold-blue graphite cinema background, near-invisible thin vertical guide lines at far right, desaturated steel-blue ambient rim light, matte shadows and restrained subtle analog grain, clean deep-dark typography negative space."},
 reel:{label:"06 · Геометрия киноплёнки",background:"film",theme:"orange",layout:"split",bgColor:"#11161A",typeface:"sans",titleAlign:"left",titleY:44,titleSize:98,
 prompt:"Very subtle abstract film strip motif confined to extreme right edge of nearly black background, flat charcoal design with occasional muted amber edge reflections, original minimal editorial vector-meets-film texture, absolutely no literal film imagery or readable markings."}
};
const deep=Object.freeze(Object.fromEntries(Object.entries(entries).map(([id,s])=>[id,Object.freeze({id,...s})])));
function get(id){return deep[id]||deep.noir;}
function prompt(id,format='reel',topic=''){const p=get(id);const aspect=format==='portrait'?'4:5':format==='square'?'1:1':format==='wide'?'16:9':'9:16';return `ORIGINAL CINEMATIC BACKGROUND ONLY. Aspect ratio ${aspect}. ${p.prompt}\n\nMASTER ART DIRECTION: ${master}\n\nDo not render the post title, logo or any text. Text and S avatar are added in the MyBrand editor afterwards. Topic for abstract mood only: ${String(topic||'cinema').slice(0,100).replace(/[\r\n]+/g,' ')}.\n\nNEGATIVE PROMPT: ${negative}`;}
window.SkoomaStyles=Object.freeze({styles:deep,get,prompt,master});
})();
