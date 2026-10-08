import test from 'node:test';
import assert from 'node:assert/strict';
import {codexSubscriptionArgs,codexSubscriptionEnv,CODEX_TOOLKIT} from '../server/codex-subscription.js';
test('subscription launch pins ChatGPT auth and native provider without bypassing access controls',()=>{
 const args=codexSubscriptionArgs('read-only','/projects/client');
 assert.ok(args.includes('forced_login_method="chatgpt"'));assert.ok(args.includes('model_provider="openai"'));assert.ok(args.includes('web_search="live"'));
 assert.equal(args[args.indexOf('--sandbox')+1],'read-only');assert.equal(args[args.indexOf('-C')+1],'/projects/client');
 assert.equal(args.at(-1),'-');assert.ok(!args.some(x=>x.includes('dangerously')||x==='--ignore-rules'||x==='--ignore-user-config'));
});
test('subscription child cannot inherit OpenAI API billing credentials or gateway overrides',()=>{
 const original={PATH:'/bin',CODEX_HOME:'/codex',OPENAI_API_KEY:'test-key',OPENAI_BASE_URL:'https://gateway.invalid',OPENAI_ORG_ID:'org',AZURE_OPENAI_API_KEY:'test-azure',CODEX_API_KEY:'test-code',TERM:'xterm'};
 assert.deepEqual(codexSubscriptionEnv(original),{PATH:'/bin',CODEX_HOME:'/codex',TERM:'xterm'});assert.equal(original.OPENAI_API_KEY,'test-key');
 assert.match(CODEX_TOOLKIT.limits,/shared Codex plan allowance/);
});
