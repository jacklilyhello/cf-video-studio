#!/usr/bin/env python3
"""Configure/query Workers Builds using project deployment credentials only.

ensure never deploys. trigger requires an explicit merged commit and verifies
complete build history before a new trigger. The API scan/create is not atomic.
Cloudflare GitHub App authorization remains external.
"""
import json
import http.client
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from provision import api, env_values, STATE, BASE

BUILDS_PER_PAGE = 200
MAX_BUILD_PAGES = 100
AUTOMATIC_BUILD_GRACE_SECONDS = 90
AUTOMATIC_BUILD_POLL_SECONDS = 15


def github_repository(values):
    repository = values.get('CF_VIDEO_REPOSITORY')
    if not repository:
        origin = subprocess.run(['git', 'remote', 'get-url', 'origin'], text=True, capture_output=True, check=True).stdout.strip()
        match = re.fullmatch(r'(?:https://github\.com/|git@github\.com:)([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?', origin)
        if not match:
            raise RuntimeError('Set CF_VIDEO_REPOSITORY to the GitHub owner/repository')
        repository = match.group(1)
    if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
        raise RuntimeError('CF_VIDEO_REPOSITORY must be a GitHub owner/repository')
    return repository


def deployment_branch(values):
    branch = values.get('CF_VIDEO_BRANCH', 'main')
    if not re.fullmatch(r'[A-Za-z0-9_/-]+', branch) or branch.startswith(('/', '-')) or branch.endswith('/') or '//' in branch:
        raise RuntimeError('CF_VIDEO_BRANCH must be an exact branch name without glob characters')
    return branch


def deployment_command(worker):
    if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', worker):
        raise RuntimeError('State contains an invalid deployment Worker name')
    return ('CF_VIDEO_WORKER_NAME=' + shlex.quote(worker) + ' ' if worker != 'cf-video-hub-test' else '') + 'npm run release:test'


def history_error(reason):
    return RuntimeError('Cannot verify complete build history: ' + reason + '; refusing to trigger a build')


def builds_page(token, path, page):
    """Keep the list envelope: provision.api intentionally returns result only.

    This GET helper never includes response bodies, headers or credentials in
    errors. Missing optional API pagination fields are not proof of absence.
    """
    query = urllib.parse.urlencode({'page': page, 'per_page': BUILDS_PER_PAGE})
    try:
        request = urllib.request.Request(BASE + path + '?' + query,
            headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/json'})
        with urllib.request.urlopen(request, timeout=45) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as error:
        raise history_error('list request returned HTTP ' + str(error.code)) from None
    except (OSError, ValueError, http.client.HTTPException):
        raise history_error('list request failed or returned invalid JSON') from None
    if not isinstance(payload, dict) or payload.get('success') is not True:
        raise history_error('list response did not confirm success')
    return payload


def build_priority(item):
    # Prefer an in-flight or unverified existing handle over a completed one.
    # Cloudflare can add status names; only its stopped state is terminal here.
    if item.get('status') != 'stopped':
        return 3
    if item.get('build_outcome') == 'success':
        return 2
    return 1


def find_build(token, path, commit):
    """Return an exact-SHA build only after validating a bounded, complete list.

    Official contract: https://developers.cloudflare.com/api/resources/workers_builds/subresources/builds/methods/list/
    Pagination does not provide an atomic snapshot or prevent an external build
    from appearing between this scan and the subsequent POST.
    """
    seen = set()
    totals = None
    same = None
    for page in range(1, MAX_BUILD_PAGES + 1):
        payload = builds_page(token, path, page)
        records = payload.get('result')
        info = payload.get('result_info')
        fields = ('count', 'page', 'per_page', 'total_count', 'total_pages')
        if not isinstance(records, list) or not isinstance(info, dict):
            raise history_error('missing records or pagination metadata')
        if any(type(info.get(key)) is not int or info[key] < 0 for key in fields):
            raise history_error('missing or invalid pagination fields')
        if info['page'] != page or info['per_page'] != BUILDS_PER_PAGE:
            raise history_error('unexpected page or page size')
        total_count, total_pages = info['total_count'], info['total_pages']
        expected_pages = (total_count + BUILDS_PER_PAGE - 1) // BUILDS_PER_PAGE
        if total_pages not in ((0, 1) if total_count == 0 else (expected_pages,)):
            raise history_error('inconsistent total count and page count')
        if total_pages > MAX_BUILD_PAGES:
            raise history_error('build history exceeds the page limit')
        signature = (total_count, total_pages)
        if totals is not None and totals != signature:
            raise history_error('pagination totals changed during the scan')
        totals = signature
        expected_count = min(BUILDS_PER_PAGE, total_count - (page - 1) * BUILDS_PER_PAGE)
        if info['count'] != len(records) or len(records) != expected_count:
            raise history_error('incomplete page or inconsistent record count')
        for build in records:
            if not isinstance(build, dict):
                raise history_error('invalid build record')
            build_id = build.get('build_uuid')
            metadata = build.get('build_trigger_metadata')
            build_commit = metadata.get('commit_hash') if isinstance(metadata, dict) else None
            if not isinstance(build_id, str) or not build_id or build_id in seen:
                raise history_error('missing or repeated build identity')
            if (not isinstance(build_commit, str) or len(build_commit) != 40
                    or any(c not in '0123456789abcdef' for c in build_commit)):
                raise history_error('build record lacks an exact commit SHA')
            seen.add(build_id)
            if build_commit == commit:
                if same is None or build_priority(build) > build_priority(same):
                    same = build
        if page >= total_pages:
            if len(seen) != total_count:
                raise history_error('incomplete build history')
            return same
    raise history_error('build history reached the page limit without completion')


def wait_for_automatic_build(token, path, commit):
    """Give delayed Git push delivery a bounded chance before API creation.

    A complete list is required on each observation. This reduces the
    scan/create race; release admission must still serialize external builds.
    """
    deadline = time.monotonic() + AUTOMATIC_BUILD_GRACE_SECONDS
    same = find_build(token, path, commit)
    while same is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return None
        time.sleep(min(AUTOMATIC_BUILD_POLL_SECONDS, remaining))
        same = find_build(token, path, commit)
    return same

def main():
    values=env_values()
    token=values['CF_DEPLOY_API_TOKEN']
    account='/accounts/'+values['CLOUDFLARE_ACCOUNT_ID']
    state=json.loads(STATE.read_text())
    branch=deployment_branch(values)
    command=sys.argv[1] if len(sys.argv)>1 else 'ensure'
    def save():
        STATE.write_text(json.dumps(state,indent=2)+'\n')
        STATE.chmod(0o600)
    if command=='ensure':
        credential=subprocess.run(['git','credential','fill'],input='protocol=https\nhost=github.com\n\n',text=True,capture_output=True,env={**os.environ,'GIT_TERMINAL_PROMPT':'0'},check=True)
        git_values=dict(x.split('=',1) for x in credential.stdout.splitlines() if '=' in x)
        request=urllib.request.Request('https://api.github.com/repos/'+github_repository(values),headers={'Authorization':'Bearer '+git_values['password'],'User-Agent':'cf-video-hub-builds'})
        with urllib.request.urlopen(request,timeout=20) as response: repo=json.load(response)
        if not repo.get('private') and values.get('CF_VIDEO_ALLOW_PUBLIC_REPOSITORY') != 'true':
            raise RuntimeError('Public repository connection requires explicit CF_VIDEO_ALLOW_PUBLIC_REPOSITORY=true after publication authorization')
        scripts=api(token,account+'/workers/scripts')
        worker=next(w for w in scripts if w['id']==state['test_worker'])
        state['test_worker_tag']=worker['tag']
        build_tokens=api(token,account+'/builds/tokens')
        if isinstance(build_tokens,dict): build_tokens=build_tokens.get('tokens',[])
        build_name=state['test_worker']+'-builds'
        # Reuse this project's earlier token name; never create a duplicate
        # token just because the public setup now derives names from the Worker.
        build_token=next((t for t in build_tokens if t.get('build_token_uuid')==state.get('build_token_uuid') or t.get('build_token_name')==build_name),None)
        if not build_token:
            build_token=api(token,account+'/builds/tokens','POST',{'build_token_name':build_name,'build_token_secret':token,'cloudflare_token_id':state['tokens']['CF_DEPLOY_API_TOKEN']})
        state['build_token_uuid']=build_token['build_token_uuid']
        save()
        connection=api(token,account+'/builds/repos/connections','PUT',{'provider_type':'github','provider_account_id':str(repo['owner']['id']),'provider_account_name':repo['owner']['login'],'repo_id':str(repo['id']),'repo_name':repo['name']})
        state['repo_connection_uuid']=connection['repo_connection_uuid']
        save()
        triggers=api(token,account+'/builds/workers/'+worker['tag']+'/triggers')
        if isinstance(triggers,dict): triggers=triggers.get('triggers',[])
        trigger_name=state['test_worker']+'-'+branch.replace('/', '-')
        trigger=next((t for t in triggers if t.get('trigger_name')==trigger_name),None)
        if not trigger:
            trigger=api(token,account+'/builds/triggers','POST',{
                'external_script_id':worker['tag'],'repo_connection_uuid':state['repo_connection_uuid'],
                'build_token_uuid':state['build_token_uuid'],'trigger_name':trigger_name,
                'build_command':'npm run check','deploy_command':deployment_command(state['test_worker']),'root_directory':'/',
                'branch_includes':[branch],'branch_excludes':[],'path_includes':['*'],'path_excludes':[]})
        state['test_trigger_uuid']=trigger['trigger_uuid']
        save()
        print(json.dumps({k:state[k] for k in ['test_worker_tag','repo_connection_uuid','test_trigger_uuid']}))
    elif command=='trigger':
        commit=sys.argv[2]
        if len(commit)!=40 or any(c not in '0123456789abcdef' for c in commit): raise RuntimeError('Exact commit SHA required')
        same=wait_for_automatic_build(token,account+'/builds/workers/'+state['test_worker_tag']+'/builds',commit)
        result=same or api(token,account+'/builds/triggers/'+state['test_trigger_uuid']+'/builds','POST',{'branch':branch,'commit_hash':commit})
        state['last_build_uuid']=result['build_uuid'];save()
        print(json.dumps({**{k:result.get(k) for k in ['build_uuid','status','build_outcome']},
            'trigger_result': 'reused_existing' if same else 'triggered_after_push_grace'}))
    elif command=='status':
        result=api(token,account+'/builds/builds/'+(sys.argv[2] if len(sys.argv)>2 else state['last_build_uuid']))
        safe={k:result.get(k) for k in ['build_uuid','status','build_outcome','created_on','modified_on']}
        safe['commit_hash']=result.get('build_trigger_metadata',{}).get('commit_hash')
        print(json.dumps(safe))
    else: raise RuntimeError('Choose ensure, trigger <SHA>, or status [build UUID]')

if __name__=='__main__':
    try: main()
    except Exception as error:
        print(str(error),file=sys.stderr)
        sys.exit(1)
