BEGIN;

DELETE FROM agent_core.agent_messages AS message
USING agent_core.agent_run_events AS event
WHERE event.run_id = message.run_id
  AND event.event_type = 'TEXT_MESSAGE_START'
  AND event.payload ->> 'messageId' = message.id
  AND event.payload #>> '{rawEvent,metadata,langgraph_node}' = 'title';

WITH projection AS (
  SELECT
    thread.id AS thread_id,
    COUNT(message.id)::integer AS message_count,
    LEFT(
      (ARRAY_AGG(
        CASE
          WHEN jsonb_typeof(message.content) = 'string' THEN message.content #>> '{}'
          ELSE message.content::text
        END
        ORDER BY message.sequence DESC
      ) FILTER (WHERE message.status = 'completed'))[1],
      240
    ) AS last_message_preview
  FROM agent_core.agent_threads AS thread
  LEFT JOIN agent_core.agent_messages AS message ON message.thread_id = thread.id
  WHERE thread.deleted_at IS NULL
  GROUP BY thread.id
)
UPDATE agent_core.agent_threads AS thread
SET message_count = projection.message_count,
    last_message_preview = projection.last_message_preview,
    updated_at = now(),
    version = thread.version + 1
FROM projection
WHERE projection.thread_id = thread.id;

INSERT INTO agent_core.schema_migrations(version)
VALUES ('002_remove_internal_title_messages')
ON CONFLICT(version) DO NOTHING;

COMMIT;
