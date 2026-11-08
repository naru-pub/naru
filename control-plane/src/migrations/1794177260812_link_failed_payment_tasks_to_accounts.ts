import { sql, type Kysely } from "kysely";

// Keep attribution in the same transaction as the terminal job state.
export async function up(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION report_failed_payment_task() RETURNS trigger
    LANGUAGE plpgsql AS $$
    DECLARE
      job jsonb;
      account_id uuid;
    BEGIN
      IF NEW.state = 'failed' AND OLD.state IS DISTINCT FROM NEW.state THEN
        job := NEW.params->'job';
        -- A malformed or missing ID can be why the task failed. Only cast
        -- valid IDs so the alert itself cannot block that state transition.
        SELECT id INTO account_id FROM users WHERE id = coalesce(
          (SELECT user_id FROM payments WHERE id = CASE
            WHEN pg_input_is_valid(job->>'paymentId', 'uuid')
            THEN (job->>'paymentId')::uuid END),
          (SELECT user_id FROM subscriptions WHERE id = CASE
            WHEN pg_input_is_valid(job->>'subscriptionId', 'uuid')
            THEN (job->>'subscriptionId')::uuid END),
          CASE WHEN job->>'kind' = 'repair_entitlement'
            AND pg_input_is_valid(job->>'userId', 'uuid')
            THEN (job->>'userId')::uuid END
        ) FOR KEY SHARE;

        INSERT INTO payment_events (kind, user_id, summary) VALUES ('job_failed',
          account_id,
          '결제 후속 작업 ' || NEW.task_name || ' (' || NEW.task_id || ')가 실패해 멈췄습니다: ' ||
          left(coalesce((SELECT failure_reason->>'message' FROM absurd.r_payments
            WHERE run_id = NEW.last_attempt_run), ''), 300));
      END IF;
      RETURN NEW;
    END $$;
  `.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`
    CREATE OR REPLACE FUNCTION report_failed_payment_task() RETURNS trigger
    LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.state = 'failed' AND OLD.state IS DISTINCT FROM NEW.state THEN
        INSERT INTO payment_events (kind, summary) VALUES ('job_failed',
          '결제 후속 작업 ' || NEW.task_name || ' (' || NEW.task_id || ')가 실패해 멈췄습니다: ' ||
          left(coalesce((SELECT failure_reason->>'message' FROM absurd.r_payments
            WHERE run_id = NEW.last_attempt_run), ''), 300));
      END IF;
      RETURN NEW;
    END $$;
  `.execute(db);
}
