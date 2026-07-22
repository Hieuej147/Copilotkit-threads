\set ON_ERROR_STOP on

BEGIN;

DO $$
DECLARE
    thread_id uuid := gen_random_uuid();
    first_run_id uuid := gen_random_uuid();
    affected integer;
BEGIN
    IF to_regclass('thread_platform.threads') IS NULL
       OR to_regclass('thread_platform.runs') IS NULL
       OR to_regclass('thread_platform.run_events') IS NULL THEN
        RAISE EXCEPTION 'V4 core tables are missing';
    END IF;

    INSERT INTO thread_platform.threads
        (id, namespace, tenant_id, owner_id, agent_id, creation_request_id)
    VALUES
        (thread_id, 'acceptance', 'tenant-a', 'owner-a', 'default', 'thread-create-key');

    INSERT INTO thread_platform.runs
        (id, thread_id, agent_id, client_request_id, status, fencing_token, heartbeat_at)
    VALUES
        (first_run_id, thread_id, 'default', 'run-key-1', 'running', 41, now());
    UPDATE thread_platform.threads SET active_fencing_token = 41 WHERE id = thread_id;

    BEGIN
        INSERT INTO thread_platform.runs
            (id, thread_id, agent_id, client_request_id, status, fencing_token)
        VALUES
            (gen_random_uuid(), thread_id, 'default', 'run-key-2', 'running', 42);
        RAISE EXCEPTION 'more than one active run was accepted';
    EXCEPTION WHEN unique_violation THEN
        NULL;
    END;

    UPDATE thread_platform.runs r SET heartbeat_at = now()
    FROM thread_platform.threads t
    WHERE r.id = first_run_id AND r.thread_id = t.id
      AND r.fencing_token = 40 AND t.active_fencing_token = 40
      AND r.status IN ('queued', 'running');
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 0 THEN
        RAISE EXCEPTION 'stale fencing token updated the run';
    END IF;

    UPDATE thread_platform.runs r SET heartbeat_at = now()
    FROM thread_platform.threads t
    WHERE r.id = first_run_id AND r.thread_id = t.id
      AND r.fencing_token = 41 AND t.active_fencing_token = 41
      AND r.status IN ('queued', 'running');
    GET DIAGNOSTICS affected = ROW_COUNT;
    IF affected <> 1 THEN
        RAISE EXCEPTION 'current fencing token could not update the run';
    END IF;
END $$;

ROLLBACK;
