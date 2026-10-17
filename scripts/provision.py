#!/usr/bin/env python3
"""Explicit project-only bootstrap. Secrets never enter output or the repository.

This script creates tokens and isolated TEST resources. It never fills Worker
runtime secrets, starts Containers, subscribes to plans or connects production.
Run only after reviewing the project objective and Cloudflare permissions.
"""
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
import secrets
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
ENV = Path(os.environ.get('CF_VIDEO_ENV_FILE', ROOT / '.env')).expanduser()
STATE = ROOT / '.local' / 'cloudflare.json'
BASE = 'https://api.cloudflare.com/client/v4'

def permission_group_ids(groups, names):
    aliases = {
        'Workers Metadata Read-Only': ['Workers Metadata Read-Only', 'Workers Scripts Read'],
        'Workers Containers Read': ['Workers Containers Read', 'Containers Read'],
        'Workers Containers Write': ['Workers Containers Write', 'Containers Write'],
    }
    result = []
    for name in names:
        selected = next((candidate for candidate in aliases.get(name, [name]) if candidate in groups), None)
        if selected is None:
            raise RuntimeError('Required Cloudflare permission is unavailable: ' + name)
        result.append({'id': groups[selected]})
    return result

def env_values():
    file_values = {k.strip(): v.strip().strip('\"\'') for k, v in
            (line.split('=', 1) for line in (ENV.read_text().splitlines() if ENV.exists() else [])
             if '=' in line and not line.lstrip().startswith('#'))}
    return {**file_values, **os.environ}

def secure_credential_file():
    if not ENV.exists():
        # Exclusive creation avoids overwriting another process's credentials.
        descriptor = os.open(ENV, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        os.close(descriptor)
    info = ENV.lstat()
    if ENV.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != 0o600:
        raise RuntimeError('Credential file must be owned by current user, regular and mode 0600')

def save_secret(name, value):
    secure_credential_file()
    if name in env_values():
        raise RuntimeError('Refusing to overwrite existing credential variable: ' + name)
    with ENV.open('a') as stream:
        stream.write('\n' + name + '=' + value + '\n')
        stream.flush()
        os.fsync(stream.fileno())

def api(token, path, method='GET', data=None, raw=None, content_type='application/json'):
    payload = raw if raw is not None else json.dumps(data).encode() if data is not None else None
    request = urllib.request.Request(BASE + path, data=payload, method=method,
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': content_type})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        try: codes = [item.get('code') for item in json.load(error).get('errors', [])]
        except Exception: codes = []
        raise RuntimeError(f'Cloudflare {method} {path}: HTTP {error.code}, error codes {codes}') from None
    if not result.get('success', True):
        raise RuntimeError('Cloudflare error codes: ' + str([x.get('code') for x in result.get('errors', [])]))
    return result.get('result')

def main():
    # Validate output storage before any remote token creation, so a local
    # permissions failure cannot leave an unrecoverable newly issued token.
    secure_credential_file()
    values = env_values()
    account = values['CLOUDFLARE_ACCOUNT_ID']
    manager = values['CF_TOKEN_MANAGER_API_TOKEN']
    account_path = '/accounts/' + account
    state = json.loads(STATE.read_text()) if STATE.exists() else {}
    STATE.parent.mkdir(exist_ok=True)
    def save():
        STATE.write_text(json.dumps(state, indent=2) + '\n')
        STATE.chmod(0o600)
    status = api(manager, '/user/tokens/verify')
    if status.get('status') != 'active': raise RuntimeError('Token manager not active')
    groups = {g['name']: g['id'] for g in api(manager, '/user/tokens/permission_groups')}
    project = values.get('CF_VIDEO_PROJECT_NAME', 'cf-video-hub')
    if not project or len(project) > 50 or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in project) or project.startswith('-') or project.endswith('-'):
        raise RuntimeError('CF_VIDEO_PROJECT_NAME must be a lowercase DNS label of at most 50 characters')
    zone = None
    if values.get('CF_VIDEO_ZONE_NAME'):
        zones = api(values['CLOUDFLARE_API_TOKEN'], '/zones?' + urllib.parse.urlencode({'name': values['CF_VIDEO_ZONE_NAME']}))
        matches = [z for z in zones if z.get('account', {}).get('id') == account]
        if len(matches) != 1: raise RuntimeError('Target zone/account mismatch')
        zone = matches[0]['id']
        state['zone_id'] = zone
    def policy(names, resource):
        return {'effect': 'allow', 'permission_groups': permission_group_ids(groups, names), 'resources': {resource: '*'}}
    def token(variable, name, policies, creator, path, expires=None):
        expires = expires or values.get('CF_VIDEO_TOKEN_EXPIRES_ON') or (datetime.now(timezone.utc) + timedelta(days=90)).strftime('%Y-%m-%dT%H:%M:%SZ')
        if variable in env_values():
            if variable not in state.get('tokens', {}):
                raise RuntimeError('Existing credential lacks recorded token ID; reconcile before creation: ' + variable)
            return env_values()[variable], state['tokens'][variable]
        existing = api(creator, path)
        if any(t.get('name') == name and t.get('status') == 'active' for t in existing):
            raise RuntimeError('Named token exists but secret missing; recover explicitly: ' + name)
        created = api(creator, path, 'POST', {'name': name, 'policies': policies, 'expires_on': expires})
        save_secret(variable, created['value'])
        state.setdefault('tokens', {})[variable] = created['id']
        save()
        print('Created', name, '(secret saved locally)')
        return created['value'], created['id']
    deployment_policies = [
        policy(['Workers Scripts Write', 'Workers R2 Storage Write', 'D1 Write',
                'Workers Containers Write', 'Cloudchamber Write', 'Workers CI Write',
                'Workers Observability Write', 'Account Settings Read'], 'com.cloudflare.api.account.' + account),
    ]
    if zone:
        deployment_policies.append(policy(['Zone Read', 'DNS Write', 'Workers Routes Write'], 'com.cloudflare.api.account.zone.' + zone))
    deploy, _ = token('CF_DEPLOY_API_TOKEN', project + '-deploy', deployment_policies, manager, '/user/tokens')
    bootstrap_only = '--bootstrap-only' in sys.argv
    runtime_user = '--runtime-user' in sys.argv or state.get('runtime_token_type') == 'user'
    if runtime_user:
        state['runtime_token_type'] = 'user'
        save()
    if not bootstrap_only and not runtime_user:
        provisioner, _ = token('CF_VIDEO_TOKEN_PROVISIONER', project + '-token-provisioner', [
            policy(['Account API Tokens Read', 'Account API Tokens Write'], 'com.cloudflare.api.account.' + account)
        ], manager, '/user/tokens', expires=(datetime.now(timezone.utc) + timedelta(days=7)).strftime('%Y-%m-%dT%H:%M:%SZ'))
    for environment in ['test', 'production']:
        if not bootstrap_only:
            variable = state.get('active_usage_variables', {}).get(environment, 'CF_USAGE_' + environment.upper() + '_API_TOKEN')
            usage, _ = token(variable, project + '-' + environment + '-usage', [
                policy(['Billing Read', 'Account Analytics Read', 'Workers R2 Storage Metadata Read',
                        'D1 Read', 'Workers Metadata Read-Only', 'Workers Containers Read', 'Workers CI Read'], 'com.cloudflare.api.account.' + account)
            ], manager if runtime_user else provisioner, '/user/tokens' if runtime_user else account_path + '/tokens')
            verify = api(usage, '/user/tokens/verify' if runtime_user else account_path + '/tokens/verify')
            if verify.get('status') != 'active': raise RuntimeError('Runtime token inactive')
            info = api(usage, account_path + '/billable-usage/info')
            print(environment, 'runtime billing token verified; covered:', info.get('covered'))
        secret_name = state.get('active_session_variables', {}).get(environment, 'SESSION_SECRET_' + environment.upper())
        if secret_name not in env_values(): save_secret(secret_name, secrets.token_urlsafe(48))
    databases = api(deploy, account_path + '/d1/database')
    worker_name = values.get('CF_VIDEO_WORKER_NAME', project + '-test')
    if not worker_name or len(worker_name) > 63 or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in worker_name) or worker_name.startswith('-') or worker_name.endswith('-'):
        raise RuntimeError('CF_VIDEO_WORKER_NAME must be a lowercase DNS label')
    database_name = values.get('CF_VIDEO_DATABASE_NAME', worker_name)
    bucket_name = values.get('CF_VIDEO_BUCKET_NAME', worker_name)
    database = next((d for d in databases if d['name'] == database_name), None)
    if not database:
        database = api(deploy, account_path + '/d1/database', 'POST', {'name': database_name, 'primary_location_hint': values.get('CF_VIDEO_LOCATION', 'apac')})
    state['test_database_id'] = database['uuid']
    buckets = api(deploy, account_path + '/r2/buckets')
    if not any(b['name'] == bucket_name for b in buckets['buckets']):
        api(deploy, account_path + '/r2/buckets', 'POST', {'name': bucket_name, 'locationHint': values.get('CF_VIDEO_LOCATION', 'apac')})
    state['test_bucket'] = bucket_name
    public = api(deploy, account_path + '/r2/buckets/' + bucket_name + '/domains/managed')
    if public.get('enabled'): raise RuntimeError('Test bucket public access unexpectedly enabled; investigate')
    scripts = api(deploy, account_path + '/workers/scripts')
    if not any(w['id'] == worker_name for w in scripts):
        metadata = {'main_module': 'bootstrap.mjs', 'compatibility_date': '2026-10-13', 'bindings': [
            {'name': 'DB', 'type': 'd1', 'id': database['uuid']}, {'name': 'MEDIA', 'type': 'r2_bucket', 'bucket_name': bucket_name}]}
        module = "export default {fetch(){return Response.json({configured:false,message:'Runtime configuration required; V3 application deployment pending'},{status:503,headers:{'Cache-Control':'no-store'}})}};"
        boundary = secrets.token_hex(20)
        chunks = []
        for name, filename, content_type, content in [('metadata', None, 'application/json', json.dumps(metadata)), ('bootstrap.mjs', 'bootstrap.mjs', 'application/javascript+module', module)]:
            disposition = f'form-data; name="{name}"' + (f'; filename="{filename}"' if filename else '')
            chunks.append(f'--{boundary}\r\nContent-Disposition: {disposition}\r\nContent-Type: {content_type}\r\n\r\n{content}\r\n')
        raw = (''.join(chunks) + f'--{boundary}--\r\n').encode()
        api(deploy, account_path + '/workers/scripts/' + worker_name, 'PUT', raw=raw, content_type='multipart/form-data; boundary=' + boundary)
        api(deploy, account_path + '/workers/scripts/' + worker_name + '/subdomain', 'POST', {'enabled': True, 'previews_enabled': False})
    subdomain = api(deploy, account_path + '/workers/subdomain')['subdomain']
    state['test_worker'] = worker_name
    state['test_url'] = f'https://{worker_name}.{subdomain}.workers.dev'
    save()
    print(json.dumps({k:v for k,v in state.items() if k != 'tokens'}))

if __name__ == '__main__':
    try: main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
