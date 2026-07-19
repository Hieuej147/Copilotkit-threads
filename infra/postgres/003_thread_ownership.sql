ALTER TABLE agent_core.agent_threads
    ADD COLUMN IF NOT EXISTS tenant_id varchar(128) NOT NULL DEFAULT 'default',
    ADD COLUMN IF NOT EXISTS owner_id varchar(128) NOT NULL DEFAULT 'anonymous';

CREATE INDEX IF NOT EXISTS agent_threads_owner_sidebar_idx
    ON agent_core.agent_threads (tenant_id, owner_id, namespace, agent_id, last_activity_at DESC, id DESC)
    WHERE deleted_at IS NULL;

ALTER TABLE agent_core.agent_threads
    DROP CONSTRAINT IF EXISTS agent_threads_tenant_owner_check;

INSERT INTO agent_core.schema_migrations(version)
VALUES ('003_thread_ownership')
ON CONFLICT (version) DO NOTHING;
