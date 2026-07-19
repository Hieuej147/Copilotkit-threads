CREATE SCHEMA IF NOT EXISTS agent_core;

CREATE TABLE IF NOT EXISTS agent_core.schema_migrations (
    version         text PRIMARY KEY,
    applied_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_core.agent_threads (
    id                      uuid PRIMARY KEY,
    namespace               varchar(64) NOT NULL,
    agent_id                varchar(100) NOT NULL,
    title                   varchar(160) NOT NULL DEFAULT 'New conversation',
    title_status            varchar(16) NOT NULL DEFAULT 'pending'
                            CHECK (title_status IN ('pending', 'generating', 'generated', 'fallback')),
    title_source_message_id varchar(200),
    title_model             varchar(100),
    status                  varchar(16) NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'archived', 'deleted')),
    message_count           integer NOT NULL DEFAULT 0 CHECK (message_count >= 0),
    last_message_preview    text,
    version                 bigint NOT NULL DEFAULT 0 CHECK (version >= 0),
    metadata                jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    last_activity_at        timestamptz NOT NULL DEFAULT now(),
    deleted_at              timestamptz
);

CREATE INDEX IF NOT EXISTS agent_threads_sidebar_idx
    ON agent_core.agent_threads (namespace, agent_id, last_activity_at DESC, id DESC)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS agent_core.agent_runs (
    id                  uuid PRIMARY KEY,
    thread_id           uuid NOT NULL REFERENCES agent_core.agent_threads(id) ON DELETE CASCADE,
    agent_id            varchar(100) NOT NULL,
    client_request_id   uuid NOT NULL,
    input_message_id    varchar(200),
    status              varchar(16) NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
    last_event_seq      bigint NOT NULL DEFAULT 0 CHECK (last_event_seq >= 0),
    error_code          varchar(100),
    error_detail        text,
    started_at          timestamptz,
    finished_at         timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now(),
    UNIQUE (thread_id, client_request_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_runs_one_active_per_thread_idx
    ON agent_core.agent_runs (thread_id)
    WHERE status IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS agent_runs_thread_created_idx
    ON agent_core.agent_runs (thread_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_core.agent_messages (
    id                  varchar(200) NOT NULL,
    thread_id           uuid NOT NULL REFERENCES agent_core.agent_threads(id) ON DELETE CASCADE,
    run_id              uuid REFERENCES agent_core.agent_runs(id) ON DELETE SET NULL,
    sequence            bigint NOT NULL,
    role                varchar(16) NOT NULL CHECK (role IN ('user', 'assistant', 'tool', 'system')),
    kind                varchar(20) NOT NULL DEFAULT 'text'
                        CHECK (kind IN ('text', 'tool_call', 'tool_result', 'activity')),
    content             jsonb NOT NULL DEFAULT '""'::jsonb,
    status              varchar(16) NOT NULL DEFAULT 'completed'
                        CHECK (status IN ('streaming', 'completed', 'failed')),
    tool_call_id        varchar(200),
    parent_message_id   varchar(200),
    model               varchar(100),
    usage               jsonb,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, id),
    UNIQUE (thread_id, sequence)
);

CREATE INDEX IF NOT EXISTS agent_messages_thread_sequence_idx
    ON agent_core.agent_messages (thread_id, sequence);

CREATE TABLE IF NOT EXISTS agent_core.agent_run_events (
    run_id              uuid NOT NULL REFERENCES agent_core.agent_runs(id) ON DELETE CASCADE,
    sequence            bigint NOT NULL,
    thread_id           uuid NOT NULL REFERENCES agent_core.agent_threads(id) ON DELETE CASCADE,
    event_type          varchar(80) NOT NULL,
    payload             jsonb NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, sequence)
);

CREATE INDEX IF NOT EXISTS agent_run_events_thread_created_idx
    ON agent_core.agent_run_events (thread_id, created_at, run_id, sequence);

INSERT INTO agent_core.schema_migrations(version)
VALUES ('001_agent_core')
ON CONFLICT (version) DO NOTHING;
