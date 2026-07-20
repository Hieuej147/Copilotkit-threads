BEGIN;

CREATE TABLE IF NOT EXISTS agent_core.agent_definitions (
    id                      uuid PRIMARY KEY,
    namespace               varchar(64) NOT NULL,
    agent_id                varchar(100) NOT NULL,
    display_name            varchar(160) NOT NULL,
    endpoint_url            text NOT NULL,
    health_url              text,
    transport               varchar(32) NOT NULL DEFAULT 'ag-ui-http'
                            CHECK (transport IN ('ag-ui-http')),
    credential_ref          text,
    enabled                 boolean NOT NULL DEFAULT true,
    timeout_ms              integer NOT NULL DEFAULT 120000
                            CHECK (timeout_ms BETWEEN 1000 AND 3600000),
    max_concurrent_runs     integer NOT NULL DEFAULT 25
                            CHECK (max_concurrent_runs BETWEEN 1 AND 10000),
    title_enabled           boolean NOT NULL DEFAULT true,
    title_base_url          text,
    title_model             varchar(160),
    title_credential_ref    text,
    version                 bigint NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    disabled_at             timestamptz,
    UNIQUE (namespace, agent_id)
);

CREATE INDEX IF NOT EXISTS agent_definitions_enabled_idx
    ON agent_core.agent_definitions (namespace, agent_id)
    WHERE enabled;

CREATE TABLE IF NOT EXISTS agent_core.agent_message_parts (
    thread_id           uuid NOT NULL,
    message_id          varchar(200) NOT NULL,
    part_index          integer NOT NULL CHECK (part_index >= 0),
    part_type           varchar(24) NOT NULL
                        CHECK (part_type IN ('text', 'tool_call', 'tool_result', 'activity', 'interrupt')),
    content             jsonb NOT NULL DEFAULT '{}'::jsonb,
    status              varchar(16) NOT NULL DEFAULT 'completed'
                        CHECK (status IN ('streaming', 'completed', 'failed')),
    tool_call_id        varchar(200),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, message_id, part_index),
    FOREIGN KEY (thread_id, message_id)
      REFERENCES agent_core.agent_messages(thread_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS agent_message_parts_tool_call_idx
    ON agent_core.agent_message_parts (thread_id, tool_call_id)
    WHERE tool_call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_core.agent_run_snapshots (
    run_id          uuid NOT NULL REFERENCES agent_core.agent_runs(id) ON DELETE CASCADE,
    thread_id       uuid NOT NULL REFERENCES agent_core.agent_threads(id) ON DELETE CASCADE,
    snapshot_key    varchar(160) NOT NULL,
    event_type      varchar(80) NOT NULL,
    payload         jsonb NOT NULL,
    updated_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_id, snapshot_key)
);

CREATE INDEX IF NOT EXISTS agent_run_snapshots_thread_idx
    ON agent_core.agent_run_snapshots (thread_id, updated_at);

INSERT INTO agent_core.agent_message_parts
    (thread_id, message_id, part_index, part_type, content, status, tool_call_id, created_at, updated_at)
SELECT message.thread_id, message.id, 0,
       CASE message.kind
         WHEN 'tool_call' THEN 'tool_call'
         WHEN 'tool_result' THEN 'tool_result'
         WHEN 'activity' THEN 'activity'
         ELSE 'text'
       END,
       message.content, message.status, message.tool_call_id,
       message.created_at, message.updated_at
FROM agent_core.agent_messages AS message
ON CONFLICT (thread_id, message_id, part_index) DO NOTHING;

INSERT INTO agent_core.schema_migrations(version)
VALUES ('006_platform_v3')
ON CONFLICT (version) DO NOTHING;

COMMIT;
