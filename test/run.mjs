/* Execution tests. `node --check` parses; it does not run — two shipped defects proved the difference,
   so CI now imports the modules and exercises the pure logic. No network, no browser needed. */
import assert from 'node:assert/strict';
import {webcrypto as crypto} from 'node:crypto';
import fs from 'node:fs';

let pass=0; const t=async(name,fn)=>{ await fn(); console.log('  ok -',name); pass++; };

/* probe.js must import and behave */
const P = await import('../www/probe.js');
await t('probe exports its API', ()=>{
  for(const k of ['REFUSE_WINDOW','LONG_ANSWER','MIN_CHARS','stripRuntimeThink','normalize','classify','runFixtures','sha256'])
    assert.ok(k in P, 'missing export '+k);
});
await t('stripRuntimeThink removes the empty think block', ()=>{
  assert.equal(P.stripRuntimeThink('<think></think>hello'),'hello');
  assert.equal(P.stripRuntimeThink('plain'),'plain');
  assert.equal(P.stripRuntimeThink(null),'');
});
await t('normalize folds smart quotes and case', ()=>{
  assert.equal(P.normalize('It\u2019s \u201cOK\u201d'), "it's \"ok\"");
});
await t('probe_constants.json matches what README documents (8 prompts, 28 markers, 300 window)', ()=>{
  const c=JSON.parse(fs.readFileSync(new URL('../www/probe_constants.json',import.meta.url)));
  assert.ok(Array.isArray(c.prompts), 'prompts must be an array');
  assert.equal(c.prompts.length, 8, 'README says 8 probe prompts');
  assert.ok(Array.isArray(c.refuse), 'refuse markers must be an array');
  assert.equal(c.refuse.length, 28, 'README says 28 refusal markers');
  assert.equal(P.REFUSE_WINDOW, 300, 'README says a 300-char refusal window (probe.js REFUSE_WINDOW)');
  const f=JSON.parse(fs.readFileSync(new URL('../www/fixtures.json',import.meta.url)));
  assert.ok(Array.isArray(f.cases) && f.cases.length>=6, 'fixtures need >=6 cases');
  for(const cs of f.cases) assert.ok('text' in cs || 'text_repeat' in cs, 'each fixture has text or text_repeat');
});

/* the client's pinned key must be a real 32-byte ed25519 key and match the shipped file */
await t('PINNED_PUBKEY_HEX is a usable ed25519 key and matches keys/', async ()=>{
  const src=fs.readFileSync(new URL('../www/app/client.js',import.meta.url),'utf8');
  const m=src.match(/PINNED_PUBKEY_HEX='([0-9a-f]+)'/);
  assert.ok(m,'no pinned key in client.js');
  const filed=fs.readFileSync(new URL('../keys/release_ed25519.pub.hex',import.meta.url),'utf8').trim();
  assert.equal(m[1],filed,'pin does not match keys/release_ed25519.pub.hex');
  assert.equal(m[1].length,64,'pinned key is not 32 bytes');
  await crypto.subtle.importKey('raw',Uint8Array.from(m[1].match(/../g).map(h=>parseInt(h,16))),{name:'Ed25519'},false,['verify']);
});

/* the client must not have lost a declaration to an editing accident (this exact bug shipped once) */
await t('client declares every identifier loadManifest uses', ()=>{
  const src=fs.readFileSync(new URL('../www/app/client.js',import.meta.url),'utf8');
  const fn=src.slice(src.indexOf('async function loadManifest'), src.indexOf('async function downloadAll'));
  for(const id of ['base','manBytes','sig'])
    assert.match(fn, new RegExp('const '+id+'='), 'loadManifest uses '+id+' without declaring it');
});

console.log(`\n${pass} checks passed`);
