import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { ApprovalQueue, defaultPolicy, HookServer, openDb } from './packages/core/src/index.ts'
const dir = mkdtempSync(join(tmpdir(),'shim2-'))
const db = openDb(join(dir,'d.db'))
const q = new ApprovalQueue(db,{timeoutMs:5000, ask:(r)=>setTimeout(()=>q.settle(r.id,{decision:'allow',source:'human-tap'}),50)})
const srv = new HookServer(q, ()=>({bot:'b',chat:null,policy:{...defaultPolicy(),grants:['Bash']},paused:false}), 'sec')
const port = await srv.listen()
const payload = JSON.stringify({session_id:'s',tool_name:'Bash',tool_input:{command:'echo hi'}})
// Raw curl, stderr visible
const raw = execFileSync('bash',['-c',`printf '%s' '${payload}' | curl -sS -X POST --data-binary @- http://127.0.0.1:${port}/hook/sec/codex; echo "[exit=$?]"`],{encoding:'utf8'})
console.log('RAW CURL:', JSON.stringify(raw))
await srv.close()
