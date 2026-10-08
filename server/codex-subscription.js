// Per-run subscription policy. Credentials and global Codex settings remain with Codex.
export const CODEX_TOOLKIT = {
 id: 'codex-subscription', name: 'Your Codex subscription',
 billing: 'ChatGPT login required · OpenAI API-key fallback disabled',
 capabilities: [
  {name:'Web research',detail:'Live native web search for current sources.'},
  {name:'Project work',detail:'Read files, implement changes and run checks within the selected access mode.'},
  {name:'Image creation',detail:'Codex image generation when exposed by your account and client.'},
  {name:'Browser & computer',detail:'Existing Codex browser/computer tools, subject to their permissions and availability.'},
  {name:'Connected apps & skills',detail:'Existing Codex plugins and MCP configuration. Accounts still require their own connections; availability is checked by the worker.'},
  {name:'Company memory',detail:'HQ includes the selected project’s saved notes and approved results.'},
 ],
 registeredApps: ['GitHub','Google Drive / Docs / Sheets / Slides','Pages','Canva','Gmail','Google Calendar','Supabase'],
 inventoryNote: 'Registered in a read-only Codex worker check on October 7, 2026. Registration does not verify account authorization or third-party pricing.',
 limits: 'Uses your shared Codex plan allowance. No automatic credit purchase, paid-service signup, or provider fallback. Third-party services can have their own costs.',
};
export function codexSubscriptionArgs(mode,dir) {
 return ['-c','forced_login_method="chatgpt"','-c','model_provider="openai"','-c','web_search="live"','exec','--json','--color','never','--skip-git-repo-check','--ephemeral','--sandbox',mode,'-C',dir,'-'];
}
export function codexSubscriptionEnv(env) {
 const safe={...env};
 for(const key of Object.keys(safe))if(/^(?:OPENAI_|AZURE_OPENAI_|CODEX_API_KEY$)/.test(key))delete safe[key];
 return safe;
}
export const CODEX_TOOL_INSTRUCTIONS = `Use the tools actually exposed by your Codex run: native web search for current facts, project tools for code and documents, and image or browser tools when the task needs them. Existing Codex plugins/MCP may supply connected apps; discover available tools before claiming an integration works. Do not access unrelated accounts or data. Do not create API keys, sign up for paid services, purchase credits, or switch to an API-key/provider fallback. Do not trigger paid third-party tool operations unless the owner separately authorizes the service and budget. If a subscription limit, missing connection, or required approval blocks the task, stop and report the exact block. External account writes, communications and publishing still require separate authorization. Use local document/spreadsheet tools where available for requested project artifacts.`;
