import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

const revision = "a".repeat(40);
const buildUuid = "11111111-1111-4111-8111-111111111111";

// Run the actual CLI module with in-process intercepted HTTP and real SQLite.
// No network, Wrangler deployment or credentials are used by these fixtures.
function releaseEntry(scenario) {
  const directory = mkdtempSync(join(tmpdir(), "cf-video-release-entry-"));
  try {
    mkdirSync(join(directory, "src"));
    mkdirSync(join(directory, "migrations"));
    mkdirSync(join(directory, "node_modules/wrangler/bin"), {
      recursive: true,
    });
    writeFileSync(
      join(directory, "migrations/0001_initial.sql"),
      "-- fixture\n",
    );
    writeFileSync(
      join(directory, "node_modules/wrangler/bin/wrangler.js"),
      "console.log('OFFLINE_WRANGLER_CALL');process.exit(7);\n",
    );
    writeFileSync(
      join(directory, "wrangler.jsonc"),
      JSON.stringify({
        account_id: "fixture-account",
        env: {
          test: {
            name: "fixture-test",
            d1_databases: [{ binding: "DB", database_id: "fixture-db" }],
            r2_buckets: [{ binding: "MEDIA", bucket_name: "fixture-bucket" }],
          },
        },
      }),
    );
    const script = `
      import { DatabaseSync } from 'node:sqlite';
      import { writeFileSync } from 'node:fs';
      const scenario=${JSON.stringify(scenario)}, revision=${JSON.stringify(revision)};
      const db=new DatabaseSync(':memory:');
      db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE jobs(state TEXT,started_at INTEGER,stop_verified INTEGER);CREATE TABLE d1_migrations(name TEXT);INSERT INTO d1_migrations VALUES('0001_initial.sql');");
      db.prepare("INSERT INTO settings VALUES('deployment_fence_until',?,0)").run(scenario==='contention'?'20000':'0');
      let time=10000, settingsReads=0;
      Date.now=()=>time;
      globalThis.setTimeout=(callback,ms)=>{time+=ms;if(scenario==='contention')db.exec("UPDATE settings SET value='0' WHERE key='deployment_fence_until'");queueMicrotask(callback);return 0};
      const resourceBindings=[
        {name:'DB',type:'d1',id:'fixture-db'},
        {name:'MEDIA',type:'r2_bucket',bucket_name:'fixture-bucket'},
        {name:'PROCESSOR',type:'durable_object_namespace',class_name:'Processor',namespace_id:'fixture-processor'},
        {name:'COORDINATOR',type:'durable_object_namespace',class_name:'Coordinator',namespace_id:'fixture-coordinator'},
        {name:'VERSION',type:'version_metadata'}
      ];
      const settings=()=>({bindings:[
        ...['ADMIN_PASSWORD','SESSION_SECRET','CF_USAGE_API_TOKEN'].map(name=>({name,type:['bad-readback','changed-secret-before-command'].includes(scenario)&&settingsReads>1&&name==='ADMIN_PASSWORD'?'plain_text':'secret_text'})),
        {name:'APP_ENV',type:'plain_text',text:'test'},
        {name:'CLOUDFLARE_ACCOUNT_ID',type:'plain_text',text:'fixture-account'},
        {name:'PROCESSING_ENABLED',type:'plain_text',text:'false'},
        ...resourceBindings
      ]});
      globalThis.fetch=async(url,init)=>{
        const path=new URL(url).pathname;
        if(path==='/health')return Response.json({configured:true,buildCommit:revision,versionId:'fixture-version'});
        let result;
        if(path.endsWith('/query')){const sql=JSON.parse(init.body).sql;result=[{success:true,results:db.prepare(sql).all()}];}
        else if(path.endsWith('/settings')){settingsReads++;result=settings();}
        else if(path.endsWith('/deployments'))result={deployments:[{versions:[{version_id:'fixture-version',percentage:100}]}]};
        else if(path.includes('/versions/'))result={id:'fixture-version',annotations:{'workers/tag':['command-failure','changed-secret-before-command'].includes(scenario)?'b'.repeat(40):revision},resources:{bindings:resourceBindings,script_runtime:{containers:[{class_name:'Processor',name:'fixture-app',images:{processor:'registry.example/image@sha256:'+'a'.repeat(64)}}]}}};
        else if(path.includes('/containers/applications/'))result={id:'fixture-processor',durable_objects:{namespace_id:'fixture-processor'},name:'fixture-app',scheduling_policy:'durable_object',health:{instances:{active:0,starting:0}}};
        else if(path.endsWith('/workers/subdomain'))result={subdomain:'fixture'};
        else if(path.endsWith('/subdomain'))result={enabled:true};
        else throw new Error('Unexpected offline fixture route');
        return Response.json({success:true,result});
      };
      process.argv[2]='test';
      try{await import(${JSON.stringify(new URL("../scripts/release.mjs", import.meta.url).href)});}
      catch(error){console.error(error.message);process.exitCode=1;}
      finally{writeFileSync('result.json',JSON.stringify(Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r=>[r.key,r.value]))));db.close();}
    `;
    const run = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: directory,
        encoding: "utf8",
        timeout: 5000,
        env: {
          PATH: process.env.PATH,
          CLOUDFLARE_API_TOKEN: "offline-fixture-token",
          WORKERS_CI_COMMIT_SHA: revision,
          WORKERS_CI_BUILD_UUID: buildUuid,
        },
      },
    );
    return {
      run,
      state: JSON.parse(readFileSync(join(directory, "result.json"), "utf8")),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("actual release CLI duplicate and failure semantics", () => {
  it.each(["duplicate", "contention"])(
    "skips Wrangler only after complete same-commit proof (%s)",
    (scenario) => {
      const { run, state } = releaseEntry(scenario);
      expect(run.error).toBeUndefined();
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain('"result":"duplicate_already_deployed"');
      expect(run.stdout).toContain('"migrationsVerified":true');
      expect(run.stdout).not.toContain("OFFLINE_WRANGLER_CALL");
      expect(state.deployment_fence_until).toBe("0");
      expect(JSON.parse(state.deployment_fence_owner).buildUuid).toBe(
        buildUuid,
      );
      if (scenario === "contention")
        expect(run.stdout).toContain("waiting up to five minutes");
    },
  );

  it("preserves the nonzero command failure and retains the owned fence", () => {
    const { run, state } = releaseEntry("command-failure");
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("OFFLINE_WRANGLER_CALL");
    expect(run.stdout).not.toContain('"result":"duplicate_already_deployed"');
    expect(run.stderr).toContain("Cloudflare release command failed");
    expect(Number(state.deployment_fence_until)).toBeGreaterThan(0);
  });

  it("retains a fence after failed same-commit full proof, without deploying or reporting success", () => {
    const { run, state } = releaseEntry("bad-readback");
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("OFFLINE_WRANGLER_CALL");
    expect(run.stdout).not.toContain('"result":"duplicate_already_deployed"');
    expect(run.stderr).toContain(
      "readback did not converge; release fence retained",
    );
    expect(Number(state.deployment_fence_until)).toBeGreaterThan(0);
  });

  it("rechecks runtime Secret types immediately before Wrangler after admission", () => {
    const { run, state } = releaseEntry("changed-secret-before-command");
    expect(run.error).toBeUndefined();
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain("OFFLINE_WRANGLER_CALL");
    expect(run.stderr).toContain(
      "Runtime ADMIN_PASSWORD must be a Cloudflare Secret",
    );
    expect(Number(state.deployment_fence_until)).toBeGreaterThan(0);
  });
});
