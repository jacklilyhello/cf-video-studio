export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  ASSETS: Fetcher;
  COORDINATOR: DurableObjectNamespace;
  PROCESSOR: DurableObjectNamespace;
  VERSION: WorkerVersionMetadata;
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  CF_USAGE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  APP_ENV?: string;
  PROCESSING_ENABLED?: string;
  BUILD_COMMIT?: string;
  RESOURCE_WORKER_NAME?: string;
  RESOURCE_D1_DATABASE_ID?: string;
  RESOURCE_R2_BUCKET?: string;
  RESOURCE_DO_NAMESPACES?: string;
  RESOURCE_CONTAINER_APPLICATION_ID?: string;
  RESOURCE_WORKER_TAG?: string;
}
export interface Video {
  id: string;
  title: string;
  source_key: string | null;
  source_size: number;
  source_etag: string | null;
  source_revision: string;
  source_name: string;
  status: string;
  published: number;
  current_version_id: string | null;
  probe_json: string | null;
  created_at: number;
  updated_at: number;
}
export interface Version {
  id: string;
  video_id: string;
  task_id: string | null;
  prefix: string;
  state: string;
  mode: string;
  quality: string;
  manifest: string | null;
  bytes: number;
  duration: number | null;
  timeline_id: string;
  validation_json: string | null;
  created_at: number;
}
export interface Upload {
  id: string;
  video_id: string;
  object_key: string;
  multipart_id: string | null;
  fingerprint: string;
  expected_size: number;
  state: string;
  reserved_bytes: number;
  expires_at: number;
  created_at: number;
  updated_at: number;
  error: string | null;
}
export interface Job {
  id: string;
  video_id: string;
  version_id: string;
  quote_id: string;
  state: string;
  stage: string;
  progress_json: string | null;
  error: string | null;
  started_at: number | null;
  deadline_at: number | null;
  finished_at: number | null;
  stop_verified: number;
  stop_evidence_json: string | null;
  consumption_json: string | null;
  created_at: number;
  updated_at: number;
}
export interface Quote {
  id: string;
  video_id: string;
  source_revision: string;
  source_etag: string;
  mode: string;
  quality: string;
  snapshot_id: string;
  period_start: string;
  expires_at: number;
  state: string;
  data_json: string;
  created_at: number;
}
