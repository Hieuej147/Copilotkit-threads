BEGIN;

ALTER TABLE agent_core.agent_threads
    ADD COLUMN IF NOT EXISTS creation_request_id uuid;

ALTER TABLE agent_core.agent_threads
    DROP CONSTRAINT IF EXISTS agent_threads_title_status_check;

ALTER TABLE agent_core.agent_threads
    ADD CONSTRAINT agent_threads_title_status_check
    CHECK (title_status IN ('pending', 'generating', 'generated', 'fallback', 'manual'));

CREATE UNIQUE INDEX IF NOT EXISTS agent_threads_creation_request_idx
    ON agent_core.agent_threads
       (tenant_id, owner_id, namespace, creation_request_id)
    WHERE creation_request_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_core.agent_thread_events (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    thread_id       uuid NOT NULL REFERENCES agent_core.agent_threads(id) ON DELETE CASCADE,
    tenant_id       varchar(128) NOT NULL,
    owner_id        varchar(128) NOT NULL,
    namespace       varchar(64) NOT NULL,
    event_type      varchar(40) NOT NULL
                    CHECK (event_type IN (
                      'thread.created', 'thread.updated', 'thread.archived',
                      'thread.unarchived', 'thread.deleted'
                    )),
    payload         jsonb NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_thread_events_replay_idx
    ON agent_core.agent_thread_events
       (tenant_id, owner_id, namespace, id);

INSERT INTO agent_core.schema_migrations(version)
VALUES ('005_thread_service_hardening')
ON CONFLICT (version) DO NOTHING;

COMMIT;
