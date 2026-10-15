import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings } from '../../src/settings.js';
import { applyCardPreset, identifyCardPreset, CARD_PRESET_KEYS, CARD_PRESETS } from '../../src/card-presets.js';

test('presets own thirteen booleans, retain identity and add progress then monitoring',()=>{
  const base=defaultSettings();
  assert.equal(CARD_PRESET_KEYS.length,13);
  assert.equal(identifyCardPreset(base),'monitor','existing defaults are unchanged');
  const enabled=(settings:typeof base)=>CARD_PRESET_KEYS.filter(key=>settings[key]);
  assert.deepEqual(enabled(applyCardPreset(base,'minimal')),['cardLabel','cardSummary']);
  assert.deepEqual(enabled(applyCardPreset(base,'progress')),
    ['cardLabel','cardSummary','cardAction','cardSubagents','cardSubagentSummary']);
  assert.deepEqual(enabled(applyCardPreset(base,'monitor')),CARD_PRESET_KEYS.filter(key=>key!=='cardOriginalName'));
  for (const preset of CARD_PRESETS.filter(preset=>preset!=='custom')) {
    const applied=applyCardPreset(base,preset);
    assert.equal(identifyCardPreset(applied),preset);
    assert.equal(applied.cardOriginalName,false);
    assert.equal(applied.cardLabel,true);
    assert.notEqual(applied,base,'named preset produces a new object');
  }
});

test('presets leave scope, corners, model generation/configuration and other preferences alone',()=>{
  const base={...defaultSettings(),cardSubagentScope:'all' as const,cardCorners:'round' as const,
    briefing:'api' as const,briefingApiKey:'synthetic-key',briefingApiBase:'https://synthetic.invalid/v1',
    briefingApiModel:'synthetic-model',briefingApiReasoning:true,briefingPaused:true,modelCallsPerHour:1,
    briefAgents:false,agentProgress:false,agentLabels:false,briefMain:true,sort:'created' as const,treeWidth:56};
  const before={...base};
  for (const preset of CARD_PRESETS) {
    const applied=applyCardPreset(base,preset);
    for (const key of Object.keys(base) as Array<keyof typeof base>) {
      if (!CARD_PRESET_KEYS.some(owned=>owned===key)) assert.equal(applied[key],base[key],`${preset}: ${key}`);
    }
    assert.deepEqual(base,before,'the input is never mutated');
  }
  assert.equal(applyCardPreset(base,'custom'),base,'custom is a true no-op');
});

test('every boolean combination derives a preset only from its actual content switches',()=>{
  const base=defaultSettings();
  const known=CARD_PRESETS.filter(preset=>preset!=='custom').map(preset=>({preset,settings:applyCardPreset(base,preset)}));
  for (let mask=0;mask<2**CARD_PRESET_KEYS.length;mask++) {
    const candidate={...base};
    CARD_PRESET_KEYS.forEach((key,index)=>{candidate[key]=!!(mask & (1<<index));});
    const expected=known.find(({settings})=>CARD_PRESET_KEYS.every(key=>settings[key]===candidate[key]))?.preset ?? 'custom';
    assert.equal(identifyCardPreset(candidate),expected,`mask ${mask}`);
  }
  for (const {preset,settings} of known) {
    for (const key of CARD_PRESET_KEYS) {
      assert.equal(identifyCardPreset({...settings,[key]:!settings[key]}),'custom',`${preset}: tweaking ${key}`);
    }
    const preferences={...settings,cardSubagentScope:'live',cardCorners:'round',agentProgress:false};
    assert.equal(identifyCardPreset(preferences),preset);
  }
});
