"""Exercise the real Builds command with intercepted HTTP and isolated state."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import urllib.error
import urllib.parse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
SPEC = importlib.util.spec_from_file_location('builds_under_test', ROOT / 'scripts' / 'builds.py')
builds = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builds)
import provision as provision_under_test

COMMIT = 'a' * 40
FIXTURE_TOKEN = 'offline-fixture-token-never-log'
PER_PAGE = builds.BUILDS_PER_PAGE


def record(number, commit=None):
    return {
        'build_uuid': 'fixture-build-' + str(number),
        'build_trigger_metadata': {'commit_hash': commit or format(number, '040x')},
        'status': 'stopped',
        'build_outcome': 'success',
    }


def envelope(records, page=1, total_count=None, total_pages=None):
    count = len(records) if total_count is None else total_count
    pages = max(1, (count + PER_PAGE - 1) // PER_PAGE) if total_pages is None else total_pages
    return {
        'success': True,
        'result': records,
        'result_info': {
            'count': len(records),
            'page': page,
            'per_page': PER_PAGE,
            'total_count': count,
            'total_pages': pages,
        },
    }


class BuildsPaginationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='cf-video-builds-pagination-')
        self.addCleanup(self.temp.cleanup)
        self.state_path = Path(self.temp.name) / 'state.json'
        self.initial_state = {
            'test_worker_tag': 'fixture-worker-tag',
            'test_trigger_uuid': 'fixture-trigger',
            'last_build_uuid': 'previous-build',
        }
        self.state_path.write_text(json.dumps(self.initial_state))
        self.requests = []
        self.responses = []
        self.output = io.StringIO()
        self.post_result = record('new', COMMIT)
        self.addCleanup(mock.patch.stopall)
        mock.patch.object(builds, 'STATE', self.state_path).start()
        mock.patch.object(builds, 'env_values', return_value={
            'CF_DEPLOY_API_TOKEN': FIXTURE_TOKEN,
            'CLOUDFLARE_ACCOUNT_ID': 'fixture-account',
        }).start()
        mock.patch.object(builds, 'AUTOMATIC_BUILD_GRACE_SECONDS', 0).start()
        # Patches the transport used by both builds.py and provision.api. An
        # unexpected URL/method fails locally; no real HTTP connection exists.
        mock.patch('urllib.request.urlopen', side_effect=self.http).start()
        mock.patch.object(sys, 'argv', ['builds.py', 'trigger', COMMIT]).start()

    def http(self, request, timeout):
        url = urllib.parse.urlsplit(request.full_url)
        self.assertEqual(url.scheme, 'https')
        self.assertEqual(url.netloc, 'api.cloudflare.com')
        self.assertEqual(request.get_header('Authorization'), 'Bearer ' + FIXTURE_TOKEN)
        self.assertEqual(timeout, 45)
        method = request.get_method()
        query = urllib.parse.parse_qs(url.query)
        self.requests.append((method, url.path, query, request.data))
        if method == 'GET':
            self.assertEqual(url.path, '/client/v4/accounts/fixture-account/builds/workers/fixture-worker-tag/builds')
            self.assertEqual(query.get('per_page'), [str(PER_PAGE)])
            self.assertEqual(set(query), {'page', 'per_page'})
            page = int(query['page'][0])
            self.assertEqual(page, sum(item[0] == 'GET' for item in self.requests))
            self.assertLessEqual(page, len(self.responses), 'Unexpected additional list request')
            response = self.responses[page - 1]
            if isinstance(response, Exception):
                raise response
            if isinstance(response, bytes):
                return io.BytesIO(response)
            return io.BytesIO(json.dumps(response).encode())
        self.assertEqual(method, 'POST')
        self.assertEqual(url.path, '/client/v4/accounts/fixture-account/builds/triggers/fixture-trigger/builds')
        self.assertFalse(query)
        self.assertEqual(json.loads(request.data), {'branch': 'main', 'commit_hash': COMMIT})
        return io.BytesIO(json.dumps({'success': True, 'result': self.post_result}).encode())

    def trigger(self, responses):
        self.responses = responses
        with contextlib.redirect_stdout(self.output):
            builds.main()
        return json.loads(self.output.getvalue())

    def rejected(self, responses, message=None):
        with self.assertRaises(RuntimeError) as caught:
            self.trigger(responses)
        text = str(caught.exception)
        self.assertIn('refusing to trigger a build', text)
        if message:
            self.assertIn(message, text)
        self.assertNotIn(FIXTURE_TOKEN, text)
        self.assertNotIn('sensitive-response-body', text)
        self.assertFalse(any(item[0] == 'POST' for item in self.requests))
        self.assertEqual(json.loads(self.state_path.read_text()), self.initial_state)
        self.assertEqual(self.output.getvalue(), '')

    def two_pages(self):
        records = [record(number) for number in range(PER_PAGE + 1)]
        return [
            envelope(records[:PER_PAGE], 1, len(records)),
            envelope(records[PER_PAGE:], 2, len(records)),
        ]

    def test_first_page_exact_sha_is_reused(self):
        result = self.trigger([envelope([record(1, COMMIT)])])
        self.assertEqual(result['build_uuid'], 'fixture-build-1')
        self.assertEqual([item[0] for item in self.requests], ['GET'])
        self.assertEqual(json.loads(self.state_path.read_text())['last_build_uuid'], 'fixture-build-1')

    def test_second_page_exact_sha_is_reused_without_post(self):
        pages = self.two_pages()
        pages[1]['result'][0]['build_trigger_metadata']['commit_hash'] = COMMIT
        result = self.trigger(pages)
        self.assertEqual(result['build_uuid'], 'fixture-build-' + str(PER_PAGE))
        self.assertEqual([item[0] for item in self.requests], ['GET', 'GET'])

    def test_later_failure_does_not_hide_an_existing_success_for_same_commit(self):
        failed = record(2, COMMIT)
        failed['build_outcome'] = 'fail'
        result = self.trigger([envelope([failed, record(1, COMMIT)])])
        self.assertEqual(result['build_uuid'], 'fixture-build-1')
        self.assertEqual(result['trigger_result'], 'reused_existing')
        self.assertEqual([item[0] for item in self.requests], ['GET'])

    def test_existing_live_duplicate_is_tracked_before_completed_build(self):
        live = record(2, COMMIT)
        live['status'] = 'running'
        live['build_outcome'] = None
        result = self.trigger([envelope([record(1, COMMIT), live])])
        self.assertEqual(result['build_uuid'], 'fixture-build-2')
        self.assertEqual([item[0] for item in self.requests], ['GET'])

    def test_delayed_automatic_push_build_is_reused_within_grace_without_post(self):
        clock = [0]
        def pause(seconds):
            clock[0] += seconds
        automatic = record(9, COMMIT)
        with mock.patch.object(builds, 'AUTOMATIC_BUILD_GRACE_SECONDS', 90), \
                mock.patch.object(builds.time, 'monotonic', side_effect=lambda: clock[0]), \
                mock.patch.object(builds.time, 'sleep', side_effect=pause), \
                mock.patch.object(builds, 'find_build', side_effect=[None, None, None, None, automatic]) as find:
            result = self.trigger([])
        self.assertEqual(clock[0], 60)
        self.assertEqual(find.call_count, 5)
        self.assertEqual(result['build_uuid'], 'fixture-build-9')
        self.assertEqual(result['trigger_result'], 'reused_existing')
        self.assertEqual(self.requests, [])

    def test_grace_expires_before_single_manual_trigger(self):
        clock = [0]
        def pause(seconds):
            clock[0] += seconds
        with mock.patch.object(builds, 'AUTOMATIC_BUILD_GRACE_SECONDS', 35), \
                mock.patch.object(builds.time, 'monotonic', side_effect=lambda: clock[0]), \
                mock.patch.object(builds.time, 'sleep', side_effect=pause), \
                mock.patch.object(builds, 'find_build', return_value=None) as find:
            result = self.trigger([])
        self.assertEqual(clock[0], 35)
        self.assertEqual(find.call_count, 4)
        self.assertEqual(result['trigger_result'], 'triggered_after_push_grace')
        self.assertEqual([item[0] for item in self.requests], ['POST'])

    def test_complete_nonempty_history_triggers_once(self):
        result = self.trigger(self.two_pages())
        self.assertEqual(result['build_uuid'], 'fixture-build-new')
        self.assertEqual([item[0] for item in self.requests], ['GET', 'GET', 'POST'])
        self.assertEqual(json.loads(self.state_path.read_text())['last_build_uuid'], 'fixture-build-new')

    def test_empty_history_requires_explicit_complete_metadata(self):
        for pages in (0, 1):
            with self.subTest(total_pages=pages):
                self.requests = []
                self.output = io.StringIO()
                result = self.trigger([envelope([], total_pages=pages)])
                self.assertEqual(result['build_uuid'], 'fixture-build-new')
                self.assertEqual([item[0] for item in self.requests], ['GET', 'POST'])

    def test_missing_metadata_never_means_no_build(self):
        response = envelope([])
        del response['result_info']
        self.rejected([response], 'pagination metadata')

    def test_each_missing_pagination_field_is_rejected(self):
        for key in envelope([])['result_info']:
            with self.subTest(field=key):
                response = envelope([])
                del response['result_info'][key]
                self.requests = []
                self.rejected([response], 'pagination fields')

    def test_malformed_pagination_numbers_are_rejected(self):
        for value in (None, True, '1', 1.5, -1):
            with self.subTest(value=value):
                response = envelope([])
                response['result_info']['total_pages'] = value
                self.requests = []
                self.rejected([response], 'pagination fields')

    def test_unconfirmed_success_and_invalid_result_are_rejected(self):
        responses = [None, [], {'success': False}, {'result': []}, {**envelope([]), 'result': {'builds': []}}]
        for response in responses:
            with self.subTest(response=response):
                self.requests = []
                self.rejected([response])

    def test_wrong_page_and_page_size_are_rejected(self):
        for field, value in (('page', 2), ('per_page', 1), ('per_page', 201)):
            with self.subTest(field=field, value=value):
                response = envelope([])
                response['result_info'][field] = value
                self.requests = []
                self.rejected([response], 'page or page size')

    def test_total_pages_cannot_hide_records(self):
        response = envelope([record(1)], total_count=PER_PAGE + 1, total_pages=1)
        self.rejected([response], 'total count and page count')

    def test_short_nonfinal_page_is_rejected(self):
        response = envelope([record(1)], total_count=PER_PAGE + 1)
        self.rejected([response], 'incomplete page')

    def test_count_disagrees_with_response_length(self):
        response = envelope([record(1)])
        response['result_info']['count'] = 0
        self.rejected([response], 'record count')

    def test_missing_last_record_is_rejected(self):
        pages = self.two_pages()
        pages[1]['result'] = []
        pages[1]['result_info']['count'] = 0
        self.rejected(pages, 'incomplete page')

    def test_replayed_page_number_is_rejected(self):
        pages = self.two_pages()
        pages[1]['result_info']['page'] = 1
        self.rejected(pages, 'page or page size')

    def test_overlapping_page_records_are_rejected(self):
        pages = self.two_pages()
        pages[1]['result'][0] = copy.deepcopy(pages[0]['result'][0])
        self.rejected(pages, 'repeated build identity')

    def test_duplicate_within_one_page_is_rejected(self):
        self.rejected([envelope([record(1), record(1)])], 'repeated build identity')

    def test_changing_totals_are_rejected(self):
        pages = self.two_pages()
        pages[1]['result_info']['total_count'] += 1
        self.rejected(pages, 'totals changed')

    def test_page_limit_prevents_partial_scan_then_post(self):
        with mock.patch.object(builds, 'MAX_BUILD_PAGES', 1):
            self.rejected(self.two_pages(), 'page limit')
        self.assertEqual(len(self.requests), 1)

    def test_match_does_not_hide_later_incomplete_page(self):
        pages = self.two_pages()
        pages[0]['result'][0]['build_trigger_metadata']['commit_hash'] = COMMIT
        del pages[1]['result_info']
        self.rejected(pages, 'pagination metadata')

    def test_missing_build_identity_or_commit_is_unknown(self):
        malformed = [None, {}, {**record(1), 'build_uuid': None}, {**record(1), 'build_trigger_metadata': None},
            {**record(1), 'build_trigger_metadata': {}}, record(1, COMMIT[:12]), record(1, 'A' * 40)]
        for item in malformed:
            with self.subTest(record=item):
                self.requests = []
                self.rejected([envelope([item])])

    def test_json_transport_and_http_failures_are_sanitized(self):
        errors = [
            b'{invalid sensitive-response-body',
            urllib.error.URLError(FIXTURE_TOKEN + ' sensitive-response-body'),
            urllib.error.HTTPError('https://example.invalid/' + FIXTURE_TOKEN, 403,
                'sensitive-response-body', {}, io.BytesIO(FIXTURE_TOKEN.encode())),
        ]
        for error in errors:
            with self.subTest(error_type=type(error).__name__):
                self.requests = []
                self.rejected([error])

    def test_invalid_requested_sha_never_uses_http(self):
        for commit in (COMMIT[:12], 'A' * 40, 'a' * 39 + 'z'):
            with self.subTest(commit=commit), mock.patch.object(sys, 'argv', ['builds.py', 'trigger', commit]):
                with self.assertRaisesRegex(RuntimeError, 'Exact commit SHA required'):
                    self.trigger([])
        self.assertEqual(self.requests, [])


class OperatorConfigurationTests(unittest.TestCase):
    def test_permission_aliases_never_promote_read_access_to_write(self):
        groups = {'Workers Scripts Read': 'fixture-read', 'Workers Scripts Write': 'fixture-write', 'Containers Read': 'fixture-container-read'}
        self.assertEqual(provision_under_test.permission_group_ids(groups, ['Workers Metadata Read-Only', 'Workers Containers Read']), [{'id': 'fixture-read'}, {'id': 'fixture-container-read'}])
        groups['Workers Metadata Read-Only'] = 'fixture-metadata'
        self.assertEqual(provision_under_test.permission_group_ids(groups, ['Workers Metadata Read-Only']), [{'id': 'fixture-metadata'}])
        with self.assertRaisesRegex(RuntimeError, 'permission is unavailable'):
            provision_under_test.permission_group_ids({'Workers Scripts Write': 'fixture-write'}, ['Workers Metadata Read-Only'])

    def test_github_repository_uses_explicit_value_or_origin(self):
        self.assertEqual(builds.github_repository({'CF_VIDEO_REPOSITORY': 'example-owner/video-hub'}), 'example-owner/video-hub')
        for origin in ('https://github.com/example-owner/video-hub.git', 'git@github.com:example-owner/video-hub.git'):
            with self.subTest(origin=origin), mock.patch.object(builds.subprocess, 'run', return_value=mock.Mock(stdout=origin)):
                self.assertEqual(builds.github_repository({}), 'example-owner/video-hub')

    def test_repository_and_branch_reject_api_path_or_glob_inputs(self):
        for repository in ('https://github.com/example/repo', 'example/repo?token=fixture', 'example/repo/extra'):
            with self.subTest(repository=repository), self.assertRaisesRegex(RuntimeError, 'owner/repository'):
                builds.github_repository({'CF_VIDEO_REPOSITORY': repository})
        self.assertEqual(builds.deployment_branch({}), 'main')
        self.assertEqual(builds.deployment_branch({'CF_VIDEO_BRANCH': 'release/review'}), 'release/review')
        for branch in ('*', 'main:other', 'refs/*', '-danger', '/main', 'a//b'):
            with self.subTest(branch=branch), self.assertRaisesRegex(RuntimeError, 'exact branch name'):
                builds.deployment_branch({'CF_VIDEO_BRANCH': branch})
        self.assertEqual(builds.deployment_command('cf-video-hub-test'), 'npm run release:test')
        self.assertEqual(builds.deployment_command('example-video-test'), 'CF_VIDEO_WORKER_NAME=example-video-test npm run release:test')
        with self.assertRaisesRegex(RuntimeError, 'invalid deployment Worker'):
            builds.deployment_command('unsafe; command')

    def test_env_file_is_optional_and_process_values_override_it(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {'CLOUDFLARE_ACCOUNT_ID': 'process-account'}, clear=True):
            path = Path(directory) / 'operator.env'
            with mock.patch.object(provision_under_test, 'ENV', path):
                self.assertEqual(provision_under_test.env_values()['CLOUDFLARE_ACCOUNT_ID'], 'process-account')
                path.write_text('CLOUDFLARE_ACCOUNT_ID=file-account\n# ignored=comment\nCF_VIDEO_PROJECT_NAME=example-video\n')
                values = provision_under_test.env_values()
                self.assertEqual(values['CLOUDFLARE_ACCOUNT_ID'], 'process-account')
                self.assertEqual(values['CF_VIDEO_PROJECT_NAME'], 'example-video')
                self.assertNotIn('# ignored', values)

    def test_generated_credentials_are_saved_only_to_a_private_regular_file(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {}, clear=True):
            path = Path(directory) / 'operator.env'
            with mock.patch.object(provision_under_test, 'ENV', path):
                provision_under_test.save_secret('FIXTURE_GENERATED', 'offline-generated-fixture')
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(provision_under_test.env_values()['FIXTURE_GENERATED'], 'offline-generated-fixture')
                with self.assertRaisesRegex(RuntimeError, 'Refusing to overwrite'):
                    provision_under_test.save_secret('FIXTURE_GENERATED', 'replacement')
                path.chmod(0o644)
                with self.assertRaisesRegex(RuntimeError, 'mode 0600'):
                    provision_under_test.save_secret('OTHER', 'offline-fixture')
            alias = Path(directory) / 'symlink.env'
            alias.symlink_to(path)
            with mock.patch.object(provision_under_test, 'ENV', alias), self.assertRaisesRegex(RuntimeError, 'regular'):
                provision_under_test.secure_credential_file()


if __name__ == '__main__':
    unittest.main(verbosity=2)
