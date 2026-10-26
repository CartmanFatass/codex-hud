import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionObservation } from '../../src/utils/collection-observation.js';
import { makeHudData, treeOf, node, FIXED_NOW } from '../fixtures/hud-data.js';

test('idle collection requires positive bound idle evidence; generated health times do not change it', () => {
  const tree = treeOf([node('a','A','completed')]);
  const data = makeHudData({subagentTree:tree,health:{sessionBound:true,lastReadAt:FIXED_NOW},
    activity:{state:'idle',updatedAt:FIXED_NOW},pendingApproval:undefined});
  const quiet = collectionObservation(data,tree);
  assert.equal(quiet.activity,'quiet');
  assert.equal(collectionObservation({...data,health:{...data.health,lastReadAt:new Date(FIXED_NOW.getTime()+5000)}},tree).fingerprint,quiet.fingerprint);
  assert.equal(collectionObservation({...data,stale:true},tree).activity,'uncertain');
  assert.equal(collectionObservation({...data,health:{sessionBound:false}},tree).activity,'uncertain');
  assert.equal(collectionObservation(data,undefined).activity,'uncertain');
  assert.equal(collectionObservation({...data,activity:undefined},tree).activity,'uncertain');
  assert.equal(collectionObservation({...data,pendingApproval:{kind:'input',since:FIXED_NOW}},tree).activity,'uncertain');
});

test('active and unknown descendants prevent idle backoff, including conflicting bridge evidence', () => {
  const tree = treeOf([node('a','A','completed')]);
  const data = makeHudData({health:{sessionBound:true},activity:{state:'idle',updatedAt:FIXED_NOW},pendingApproval:undefined});
  const original = collectionObservation(data,tree);
  tree.nodes[0].children.push(node('b','B','running',{depth:2}));
  assert.equal(collectionObservation(data,tree).activity,'active');
  assert.notEqual(collectionObservation(data,tree).fingerprint,original.fingerprint);
  tree.nodes[0].children[0].status='unknown';
  assert.equal(collectionObservation(data,tree).activity,'uncertain');
  assert.equal(collectionObservation({...data,bridgeHealth:{state:'connected',stateMismatch:true}},treeOf([])).activity,'uncertain');
  assert.equal(collectionObservation({...data,modelHealth:{queued:1}},treeOf([])).activity,'active');
});
