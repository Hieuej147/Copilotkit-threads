CREATE TABLE IF NOT EXISTS agent_core.agent_title_jobs (
    id              uuid PRIMARY KEY,
    thread_id       uuid NOT NULL UNIQUE REFERENCES agent_core.agent_threads(id) ON DELETE CASCADE,
    source          text NOT NULL,
    status          varchar(16) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'completed', 'dead')),
    attempts        integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    available_at    timestamptz NOT NULL DEFAULT now(),
    locked_at       timestamptz,
    locked_by       varchar(200),
    last_error      text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    completed_at    timestamptz
);

CREATE INDEX IF NOT EXISTS agent_title_jobs_claim_idx
    ON agent_core.agent_title_jobs (available_at, created_at)
    WHERE status IN ('pending', 'running');

INSERT INTO agent_core.schema_migrations(version)
VALUES ('004_title_jobs')
ON CONFLICT (version) DO NOTHING;
