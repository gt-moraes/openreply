import {describe,it,expect} from 'vitest';
import {validateEnrollment,verifyEnrollment} from '@/lib/prospecting/enrollment';
import {readProspectingThread} from '@/lib/prospecting/read';
import type {Thread} from '@/lib/prospecting/reply';
const at=Date.parse('2026-11-05T20:00:00Z');
const command={handle:'new.fixture',campaignId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',opening:'Abertura fictícia de uma nova rodada.',contactedAt:new Date(at-2000).toISOString()};
const thread=():Thread=>({account:'eugteodoro',handle:command.handle,conversationId:'new-thread',source:'instagram_api',observedAt:new Date(at).toISOString(),limited:true,directionKnown:true,messagesSent:0,messages:[{id:'own-opening',author:'self',authorConfirmed:true,text:command.opening,truncated:false,createdAt:command.contactedAt}]});
describe('new campaign enrollment',()=>{
 it('validates exact shape and permanent exclusions',()=>{
  expect(validateEnrollment(command)).toEqual(command);
  for(const handle of ['nutribrunanogs','levonshape','renanjacobi','eugteodoro','gteodoro.ia','BAD','../accounts'])expect(()=>validateEnrollment({...command,handle})).toThrow();
  expect(()=>validateEnrollment({...command,token:'extra'})).toThrow();
 });
 it('requires the actual own first message before enrollment',()=>{
  const proof=verifyEnrollment(command,thread(),at);expect(proof.openingMessageId).toBe('own-opening');expect(proof.openingHash).toHaveLength(64);
  for(const change of [{author:'lead' as const},{text:'Outra abertura'},{authorConfirmed:false},{truncated:true},{createdAt:null}]){const c=thread();Object.assign(c.messages[0],change);expect(()=>verifyEnrollment(command,c,at)).toThrow();}
 });
 it('rejects prior history, wrong account, wrong recipient, future or stale contact',()=>{
  const old=thread();old.messages.unshift({...old.messages[0],id:'older',createdAt:new Date(at-120000).toISOString()});expect(()=>verifyEnrollment(command,old,at)).toThrow();
  for(const change of [{account:'other'},{handle:'other'}])expect(()=>verifyEnrollment(command,{...thread(),...change},at)).toThrow();
  expect(()=>verifyEnrollment(command,thread(),at-10000)).toThrow();expect(()=>verifyEnrollment(command,thread(),at+86400000)).toThrow();
 });
});

it('enrollment in thread A never authorizes thread B for the same handle',async()=>{
 const scope={accountId:'a',workspaceId:'w',allowedHandles:new Set([command.handle]),enrollments:new Map([[command.handle,{conversationId:'A',contactedAt:new Date(command.contactedAt)}]])};
 let reads=0;const account={id:'a',workspaceId:'w',username:'eugteodoro',instagramId:'self',provider:'META'};
 const deps={findAccount:async()=>account,conversations:async()=>[{id:'B',participants:{data:[{id:'self'},{id:'lead',username:command.handle}]}}],messages:async()=>{reads++;return [];}};
 await expect(readProspectingThread({handle:command.handle},scope,deps)).rejects.toThrow('Enrolled conversation changed');expect(reads).toBe(0);
});
