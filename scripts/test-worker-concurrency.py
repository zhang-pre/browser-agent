"""Real Linux Firefox isolation regression. Uses temporary profiles and a deterministic LLM.
Run: python3 scripts/test-worker-concurrency.py [--firefox /path/to/firefox] [--rounds 30]
"""
import argparse, concurrent.futures, importlib.util, json, os, socket, subprocess, tempfile, time, threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from pathlib import Path

repo = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--firefox', default=str(repo/'upstream/obj-x86_64-pc-linux-gnu/dist/bin/firefox'))
parser.add_argument('--rounds', type=int, default=30)
args = parser.parse_args()
base = Path(tempfile.mkdtemp(prefix='frx-worker-concurrency-'))
spec = importlib.util.spec_from_file_location('wire', repo/'scripts/verify-windows-package.py')
wire = importlib.util.module_from_spec(spec); spec.loader.exec_module(wire)
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        marker = self.path.split('/')[1]
        data = ('<html><body data-task="'+marker+'">'+marker+'</body></html>').encode()
        self.send_response(200); self.send_header('Content-Type','text/html'); self.send_header('Cache-Control','no-store'); self.end_headers(); self.wfile.write(data)
    def log_message(self,*a): pass
server = ThreadingHTTPServer(('127.0.0.1',0),Handler)
threading.Thread(target=server.serve_forever,daemon=True).start()
url = 'http://127.0.0.1:'+str(server.server_port)
class Browser:
    def __init__(self,label):
        self.label=label; self.dir=base/label; self.dir.mkdir(); self.root=self.dir/'work'; self.root.mkdir()
        profile=self.dir/'profile'; profile.mkdir()
        with socket.socket() as s: s.bind(('127.0.0.1',0)); self.port=s.getsockname()[1]
        self.log=(self.dir/'firefox.log').open('wb')
        env=dict(os.environ,MOZ_MARIONETTE_PREF_STATE_ACROSS_RESTARTS=json.dumps({'marionette.port':self.port}))
        trace=self.dir/'trace'; trace.mkdir()
        control=self.dir/'control'; control.mkdir()
        env.update(MOZ_WEBAPI_TRACE_FILE=str(trace/'webapi.ndjson'),MOZ_WEBAPI_TRACE_CTL=str(control/'webapi.ctl'),
                   MOZ_JSVMP_TRACE_FILE=str(trace/'jsvmp.ndjson'),MOZ_JSVMP_TRACE_CTL=str(control/'jsvmp.ctl'),
                   MOZ_JSVMP_DUMP_CTL=str(control/'jsvmp.dump'),MOZ_JSVMP_TRACE_CLEAR=str(control/'jsvmp.clear'))
        self.p=subprocess.Popen([args.firefox,'-headless','-no-remote','-profile',str(profile),'-marionette','-remote-allow-system-access','about:blank'],env=env,stdout=self.log,stderr=self.log)
        for _ in range(150):
            if self.p.poll() is not None: raise RuntimeError('Firefox exited; see '+str(self.dir/'firefox.log'))
            try: self.sock=socket.create_connection(('127.0.0.1',self.port),timeout=.5); break
            except OSError: time.sleep(.2)
        else: raise RuntimeError('Marionette unavailable')
        self.sock.settimeout(90); self.w=wire.Wire(self.sock); self.w.read(); self.w.command('WebDriver:NewSession',{}); self.w.command('Marionette:SetContext',{'value':'chrome'})
        source=(repo/'additions/browser/components/agent-sidebar/dev/integration-worker-concurrency.js').read_text(encoding='utf-8-sig')
        self.info=self.js(source,[str(self.root),url,label,str(base/'claims.sqlite')])
    def js(self,source,a=None):
        result=self.w.command('WebDriver:ExecuteAsyncScript',{'script':source,'args':a or [],'newSandbox':False,'scriptTimeout':80000})
        result=result.get('value',result) if isinstance(result,dict) else result
        if isinstance(result,dict) and result.get('error'): raise RuntimeError(str(result))
        return result
    def call(self,body,a=None):
        return self.js('const cb=arguments[arguments.length-1]; (async()=>{const x=Services.wm.getMostRecentWindow("navigator:browser").__worker; '+body+'})().then(cb,e=>cb({error:String(e),stack:e.stack}));',a)
    def close(self):
        try: self.w.command('Marionette:Quit',{})
        except Exception: pass
        try: self.sock.close(); self.p.wait(timeout=10)
        except subprocess.TimeoutExpired: self.p.terminate(); self.p.wait(timeout=10)
        self.log.close()
workers=[]; report={}
try:
    for label in ['A','B']: workers.append(Browser(label))
    a,b=workers
    with concurrent.futures.ThreadPoolExecutor(2) as pool:
        rows=[]
        for i in range(args.rounds):
            futures=[pool.submit(w.call,'return await x.turn();') for w in workers]
            rows.append([f.result() for f in futures])
        report['parallelTurns']=rows
        report['overlappingPairs']=sum(max(x['startedAt'] for x in pair)<min(x['endedAt'] for x in pair) for pair in rows)
        assert report['overlappingPairs'] > 0
        # Real SQLite writer contention, with distinct candidate roots per iteration.
        claim_js="const c=new x.WorkspaceClaims({path:arguments[0],pidState:x.pidState}); try {await c.claim(arguments[1],x.label);return {claimed:true};} catch(e) {return {claimed:false,reason:String(e)};}"
        winners=[]
        for i in range(args.rounds):
            root=base/('race-'+str(i));root.mkdir()
            fs=[pool.submit(w.call,claim_js,[str(base/'claims.sqlite'),str(root)]) for w in workers]
            results=[f.result() for f in fs]
            assert sum(r['claimed'] for r in results)==1,results
            winners.append(results)
        report['claimRaces']=winners
    for w in workers:
        denied=w.call("try {await x.rt.prepare('other',{workspaceRoot:x.root});return false;} catch(e){return /绑定/.test(String(e));}")
        assert denied
    # An ancestor and a symlink alias must both conflict while A is alive.
    alias=base/'alias-A';alias.symlink_to(a.root,target_is_directory=True)
    for path in [a.dir,alias]:
        r=b.call(claim_js,[str(base/'claims.sqlite'),str(path)])
        assert not r['claimed'],r
    report['ancestorAndSymlinkRejected']=True
    # No matching PID trace must return null even if another process wrote a newer file.
    report['traceNoFallback']=a.call("const imp=n=>ChromeUtils.importESModule('resource:///modules/agentsidebar/backends/'+n+'Backend.sys.mjs'); const ctx={browser:{browsingContext:{currentWindowGlobal:{osPid:2147483000}}}}; return [(await new (imp('Jsvmp').JsvmpBackend)()._findTrace(ctx)),(await new (imp('WebApi').WebApiBackend)()._findTrace(ctx))];")
    assert report['traceNoFallback']==[None,None]
    report['tracePaths']=a.call("const b=x.ports.tools.getBackends(),ctx=x.ports.tools.createContext({workspaceRoot:x.root}); const web=await b.webapi.trace({action:'stop'},ctx); const js=await b.jsvmp.trace({action:'stop'},ctx); const pid=ctx.browser.browsingContext.currentWindowGlobal.osPid; const path=Services.env.get('MOZ_WEBAPI_TRACE_FILE')+'.'+pid; await IOUtils.writeUTF8(path,'fixture'); const hit=await b.webapi._findTrace(ctx); return {web:web.control===Services.env.get('MOZ_WEBAPI_TRACE_CTL'),js:js.control===Services.env.get('MOZ_JSVMP_TRACE_CTL'),file:hit===path};")
    assert all(report['tracePaths'].values()),report['tracePaths']
    # Timeout poisons A but does not poison B.
    report['timeout']=a.call("const ctx=x.ports.tools.createContext({workspaceRoot:x.root}); try {await x.ports.tools.getBackends().page._q({sendQuery:()=>new Promise(()=>{})},'test',{},ctx,5);} catch {} return x.rt.workerState();")
    assert report['timeout']['restartRequired']
    report['BafterAtimeout']=b.call('return await x.turn();')
    assert a.call("try {await x.rt.prepare(x.thread.id,{workspaceRoot:x.root});return false;} catch(e){return /重启/.test(String(e));}")
    report['stop']=b.call("x.hold(); const p=x.rt.run(x.thread.id,{convo:[{role:'user',content:'hold'}],workspaceRoot:x.root,assist:true}); await new Promise(r=>ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs').setTimeout(r,50)); x.rt.stop(x.thread.id); await p; return x.rt.workerState();")
    assert report['stop']['restartRequired']
    a.close(); workers.remove(a)
    report['deadOwnerReclaimed']=b.call(claim_js,[str(base/'claims.sqlite'),str(a.root)])
    assert report['deadOwnerReclaimed']['claimed']
    report['ok']=True
finally:
    for w in workers: w.close()
    server.shutdown()
    (base/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps({'report':str(base/'report.json'),'ok':report.get('ok',False)},ensure_ascii=False))
