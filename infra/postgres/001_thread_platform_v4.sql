BEGIN;

CREATE SCHEMA IF NOT EXISTS thread_platform;

CREATE TABLE IF NOT EXISTS thread_platform.schema_migrations (
    version text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE thread_platform.agents (
    id uuid PRIMARY KEY,
    namespace varchar(64) NOT NULL,
    agent_id varchar(100) NOT NULL,
    display_name varchar(160) NOT NULL,
    endpoint_url text NOT NULL,
    health_url text,
    transport varchar(32) NOT NULL DEFAULT 'ag-ui-http' CHECK (transport = 'ag-ui-http'),
    credential_ref text,
    enabled boolean NOT NULL DEFAULT true,
    timeout_ms integer NOT NULL DEFAULT 120000 CHECK (timeout_ms BETWEEN 1000 AND 3600000),
    max_concurrent_runs integer NOT NULL DEFAULT 25 CHECK (max_concurrent_runs BETWEEN 1 AND 10000),
    title_enabled boolean NOT NULL DEFAULT true,
    title_base_url text,
    title_model varchar(160),
    title_credential_ref text,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    disabled_at timestamptz,
    UNIQUE (namespace, agent_id)
);

CREATE INDEX agents_enabled_idx ON thread_platform.agents (namespace, agent_id) WHERE enabled;

CREATE TABLE thread_platform.threads (
    id uuid PRIMARY KEY,
    namespace varchar(64) NOT NULL,
    tenant_id varchar(128) NOT NULL,
    owner_id varchar(128) NOT NULL,
    agent_id varchar(100) NOT NULL,
    creation_request_id varchar(128),
    title varchar(160) NOT NULL DEFAULT 'New conversation',
    title_status varchar(16) NOT NULL DEFAULT 'pending'
        CHECK (title_status IN ('pending','generating','generated','fallback','manual')),
    title_model varchar(160),
    status varchar(16) NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','archived','deleted')),
    message_count integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
    last_message_preview text,
    version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    active_fencing_token bigint NOT NULL DEFAULT 0 CHECK (active_fencing_token >= 0),
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    last_activity_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz
);

CREATE UNIQUE INDEX threads_creation_request_idx
    ON thread_platform.threads (namespace, tenant_id, owner_id, creation_request_id)
    WHERE creation_request_id IS NOT NULL;
CREATE INDEX threads_sidebar_idx
    ON thread_platform.threads
       (namespace, tenant_id, owner_id, agent_id, status, last_activity_at DESC, id DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE thread_platform.runs (
    id uuid PRIMARY KEY,
    thread_id uuid NOT NULL REFERENCES thread_platform.threads(id) ON DELETE CASCADE,
    agent_id varchar(100) NOT NULL,
    client_request_id varchar(128) NOT NULL,
    input_message_id varchar(200),
    status varchar(16) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued','running','completed','failed','cancelled','interrupted')),
    fencing_token bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
    last_event_seq bigint NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
    error_code varchar(100),
    error_detail text,
    heartbeat_at timestamptz,
    started_at timestamptz,
    finished_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (thread_id, client_request_id)
);

CREATE UNIQUE INDEX runs_one_active_per_thread_idx
    ON thread_platform.runs (thread_id) WHERE status IN ('queued','running');
CREATE INDEX runs_thread_created_idx ON thread_platform.runs (thread_id, created_at DESC);
CREATE INDEX runs_stale_idx ON thread_platform.runs (heartbeat_at)
    WHERE status IN ('queued','running');

CREATE TABLE thread_platform.messages (
    id varchar(200) NOT NULL,
    thread_id uuid NOT NULL REFERENCES thread_platform.threads(id) ON DELETE CASCADE,
    run_id uuid REFERENCES thread_platform.runs(id) ON DELETE SET NULL,
    sequence bigint NOT NULL,
    role varchar(16) NOT NULL CHECK (role IN ('user','assistant','tool','system')),
    kind varchar(20) NOT NULL DEFAULT 'text'
        CHECK (kind IN ('text','tool_call','tool_result','activity')),
    content jsonb NOT NULL DEFAULT '""'::jsonb,
    status varchar(16) NOT NULL DEFAULT 'completed'
        CHECK (status IN ('streaming','completed','failed')),
    tool_call_id varchar(200),
    parent_message_id varchar(200),
    model varchar(100),
    usage jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, id),
    UNIQUE (thread_id, sequence)
);

CREATE INDEX messages_thread_sequence_idx ON thread_platform.messages (thread_id, sequence);

CREATE TABLE thread_platform.message_parts (
    thread_id uuid NOT NULL,
    message_id varchar(200) NOT NULL,
    part_index integer NOT NULL CHECK (part_index >= 0),
    part_type varchar(24) NOT NULL
        CHECK (part_type IN ('text','tool_call','tool_result','activity','interrupt')),
    content jsonb NOT NULL DEFAULT '{}'::jsonb,
    status varchar(16) NOT NULL DEFAULT 'completed'
        CHECK (status IN ('streaming','completed','failed')),
    tool_call_id varchar(200),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, message_id, part_index),
    FOREIGN KEY (thread_id, message_id)
        REFERENCES thread_platform.messages(thread_id, id) ON DELETE CASCADE
);

CREATE INDEX message_parts_tool_call_idx
    ON thread_platform.message_parts (thread_id, tool_call_id) WHERE tool_call_id IS NOT NULL;

CREATE TABLE thread_platform.run_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id uuid NOT NULL REFERENCES thread_platform.runs(id) ON DELETE CASCADE,
    sequence bigint NOT NULL,
    thread_id uuid NOT NULL REFERENCES thread_platform.threads(id) ON DELETE CASCADE,
    event_type varchar(80) NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (run_id, sequence)
);

CREATE INDEX run_events_thread_cursor_idx
    ON thread_platform.run_events (thread_id, id);

CREATE TABLE thread_platform.run_snapshots (
    run_id uuid NOT NULL REFERENCES thread_platform.runs(id) ON DELETE CASCADE,
    thread_id uuid NOT NULL REFERENCES thread_platform.threads(id) ON DELETE CASCADE,
    snapshot_key varchar(160) NOT NULL,
    event_type varchar(80) NOT NULL,
    payload jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, snapshot_key)
);

CREATE INDEX run_snapshots_thread_idx ON thread_platform.run_snapshots (thread_id, updated_at);

CREATE TABLE thread_platform.thread_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    thread_id uuid NOT NULL REFERENCES thread_platform.threads(id) ON DELETE CASCADE,
    tenant_id varchar(128) NOT NULL,
    owner_id varchar(128) NOT NULL,
    namespace varchar(64) NOT NULL,
    event_type varchar(40) NOT NULL
        CHECK (event_type IN ('thread.created','thread.updated','thread.archived','thread.unarchived','thread.deleted')),
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX thread_events_replay_idx
    ON thread_platform.thread_events (tenant_id, owner_id, namespace, id);

CREATE TABLE thread_platform.title_jobs (
    id uuid PRIMARY KEY,
    thread_id uuid NOT NULL UNIQUE REFERENCES thread_platform.threads(id) ON DELETE CASCADE,
    source text NOT NULL,
    status varchar(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending','running','completed','dead')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    locked_by varchar(200),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE INDEX title_jobs_claim_idx ON thread_platform.title_jobs (available_at, created_at)
    WHERE status IN ('pending','running');

INSERT INTO thread_platform.schema_migrations(version)
VALUES ('001_thread_platform_v4') ON CONFLICT (version) DO NOTHING;

COMMIT;
