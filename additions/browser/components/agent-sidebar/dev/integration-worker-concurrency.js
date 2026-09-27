const done = arguments[arguments.length - 1];
(async () => {
  const [root, base, label, registry] = arguments;
  const imp = name => ChromeUtils.importESModule("resource:///modules/agentsidebar/" + name + ".sys.mjs");
  const { createAgentRuntime } = imp("runtime/AgentRuntime");
  const { createFirefoxAgentRuntimePorts } = imp("host/FirefoxAgentRuntimeHost");
  const { WorkspaceClaims } = imp("host/WorkspaceClaims");
  const { ConversationStore } = imp("state/ConversationStore");
  const { setTimeout } = ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs");
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pidState = async pid => await IOUtils.exists("/proc/" + pid) ? "alive" : "dead";
  const claims = new WorkspaceClaims({path:registry, pidState});
  const store = new ConversationStore({memoryOnly:true});
  const thread = await store.createThread(label);
  const win = Services.wm.getMostRecentWindow("navigator:browser");
  let page, round = 0, hold = false;
  const response = (content = "", toolCalls = []) => ({content, toolCalls, finishReason:toolCalls.length ? "tool_calls" : "stop"});
  const call = (name, args) => ({id:label + "-" + round + "-" + name, type:"function", function:{name, arguments:JSON.stringify(args)}});
  const ports = createFirefoxAgentRuntimePorts({
    config:{getActiveModelProfile:()=>({id:"test"}), getActiveProvider:()=>"test", getModel:()=>"test"},
    conversations:store, isVisionModel:()=>false,
    createClient:() => { let n = 0; return {model:"test", providerId:"test", protocol:"openai", async chat(messages) {
      if (messages[0]?.content?.includes("当前是任务完成后的记忆检查")) return response(JSON.stringify({schemaVersion:1,summary:"test complete",nextAction:"",memories:[]}));
      if (hold) { await sleep(1000); return response("stopped"); }
      n++;
      if (n === 1) { await sleep(20); return response("", [call("net_capture",{action:"start", urlPattern:base+"/*"}), call("page_navigate", {url:base+"/"+label+"/"+round})]); }
      if (n === 2) {
        for (let i=0; i<200; i++) {
          const value = await page.eval({expression:"document.body?.dataset.task + location.pathname"}, {win, browser:ports.tools.admission.owner.browser}).catch(() => ({}));
          if (value.value === label + "/" + label + "/" + round) break;
          if (i === 199) throw Error("page did not load");
          await sleep(10);
        }
        return response("", [call("page_eval", {expression:"fetch('/"+label+"/event/"+round+"').then(() => document.body.dataset.task)"}),
          call("fs_write", {path:"work/marker.txt", content:label+":"+round}),
          call("fs_read", {path:"work/marker.txt"}),
          call("run_node", {code:"console.log(require('node:child_process').execFileSync('/bin/sh',['-c','cat work/marker.txt'],{encoding:'utf8'}))"})]);
      }
      const results = messages.filter(m=>m.role==="tool").map(m=>JSON.parse(m.content));
      for (const result of results) if (!result.ok || result.data?.ok === false) throw Error("tool failed: "+JSON.stringify(result));
      if (!results.some(r=>r.data?.value===label)) throw Error("wrong page result");
      if (!results.some(r=>r.data?.output?.trim()===label+":"+round)) throw Error("wrong subprocess/file result");
      return response("DONE:"+label+":"+round);
    }};},
  });
  ports.tools.admission.claim = (path, tid) => claims.claim(path, tid);
  const rt = createAgentRuntime(ports); page = ports.tools.getBackends().page;
  win.__worker = {
    rt, ports, thread, root, claims, label, pidState, WorkspaceClaims,
    async turn() {
      const startedAt = Date.now();
      round++;
      await rt.run(thread.id,{systemPrompt:"test",convo:[{role:"user",content:"reverse task "+label}],workspaceRoot:root,hostContext:{win},assist:true,maxRounds:6});
      const state=rt.getState(thread.id);
      if (state.error || state.content!=="DONE:"+label+":"+round) throw Error(JSON.stringify({error:state.error,content:state.content}));
      const requests = (await ports.tools.getBackends().net.list({}, {win})).requests || [];
      if (requests.some(r=>r.url.startsWith(base+"/"+(label==="A"?"B":"A")+"/"))) throw Error("foreign network event");
      return {round,content:state.content,events:requests.length,startedAt,endedAt:Date.now()};
    },
    hold() {hold=true;},
  };
  return {threadId:thread.id,pid:Services.appinfo.processID};
})().then(done, e=>done({error:String(e),stack:e.stack}));
